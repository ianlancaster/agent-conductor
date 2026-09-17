import { Cron } from 'croner';
import { log } from '../logger.js';
import type { SessionConfig, ScheduleEntry } from '../config/schema.js';
import { scheduleEnvelope, sleep } from './utils.js';
import type { ScheduleSource } from './utils.js';
import type { ConductorEventPublisher } from '../events/types.js';
import type { DeliveryOptions, DeliveryResult } from './delivery.js';
import {
  MemoryScheduleOccurrenceLedger,
  scheduleOccurrenceId,
  type ScheduleOccurrenceLedger,
  type ScheduleOccurrenceOutcome,
  type ScheduleOccurrenceRow,
} from './schedule-occurrences.js';

const FRESH_SESSION_SETTLE_MS = 3000;
// Like Croner, recheck long waits so wall-clock changes cannot strand a job behind
// Node's maximum timer delay. The retained occurrence itself never changes.
const MAX_TIMER_MS = 30_000;

function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * Croner intentionally exposes execution time through currentRun(), not the due
 * target passed to its private timer. Drive its public nextRun() calculator here
 * so the nominal occurrence is retained before any event-loop or session delay.
 */
class OccurrenceTimer {
  private readonly calculator: Cron;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private running = false;

  constructor(
    pattern: string,
    timezone: string,
    private readonly callback: (source: ScheduleSource) => Promise<void>,
  ) {
    this.calculator = new Cron(pattern, { timezone });
    this.armNext(timezone);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.calculator.stop();
  }

  private armNext(timezone: string): void {
    if (this.stopped) return;
    const scheduledAt = this.calculator.nextRun();
    if (scheduledAt === null) return;
    const source = { scheduledAt: scheduledAt.toISOString(), timezone };
    this.armRetained(scheduledAt, source, timezone);
  }

  private armRetained(scheduledAt: Date, source: ScheduleSource, timezone: string): void {
    const delay = Math.max(0, scheduledAt.getTime() - Date.now());
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        if (this.stopped) return;
        if (Date.now() < scheduledAt.getTime()) {
          this.armRetained(scheduledAt, source, timezone);
          return;
        }

        // Compute from the handling clock only to select the *future* target. The
        // occurrence handed to the callback remains the previously retained one,
        // so a late callback never relabels itself or creates catch-up work.
        this.armNext(timezone);
        if (this.running) return;
        this.running = true;
        void this.callback(source)
          .catch((error: unknown) => {
            log().error(
              'scheduler',
              `Occurrence callback failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          })
          .finally(() => {
            this.running = false;
          });
      },
      Math.min(delay, MAX_TIMER_MS),
    );
  }
}

export interface SchedulerDeps {
  sessions(): Map<string, SessionConfig>;
  isActive(session: string): boolean | Promise<boolean>;
  isPaused(session: string): boolean;
  startSession(session: string, opts: { prompt?: string }): Promise<'started' | 'not-started'>;
  stopSession(session: string): Promise<string>;
  /** Share DeliveryQueue's pause boundary with stopped-session initial prompts. */
  acquireSubmissionLease?(session: string): (() => void) | undefined;
  deliver(
    session: string,
    text: string,
    options: Pick<
      DeliveryOptions,
      'pausePolicy' | 'onSubmissionStarted' | 'onSubmissionRejected' | 'onUncertain' | 'onDelivered'
    >,
  ): Promise<DeliveryResult>;
  occurrences?: ScheduleOccurrenceLedger;
  events?: ConductorEventPublisher;
}

/** Cron scheduling of session prompts, on croner. Rebuilt whenever configs reload. */
export class Scheduler {
  private jobs: OccurrenceTimer[] = [];
  /** Serialize all schedules targeting one session, not merely each Cron job. */
  private readonly sessionRuns = new Map<string, Promise<void>>();
  private generation = 0;
  private readonly cancellations = new Map<string, number>();
  private readonly occurrences: ScheduleOccurrenceLedger;
  private readonly pendingOccurrences = new Map<string, ScheduleOccurrenceRow>();
  private recovered = false;

  constructor(private readonly deps: SchedulerDeps) {
    this.occurrences = deps.occurrences ?? new MemoryScheduleOccurrenceLedger();
  }

  /** Tear down and re-create all jobs from current configs. */
  rebuild(): void {
    this.stop();
    if (!this.recovered) {
      const unknown = this.occurrences.quarantineInterruptedDispatches();
      if (unknown.length > 0) {
        log().warn(
          'scheduler',
          `${String(unknown.length)} interrupted schedule submission(s) quarantined as unknown; none will replay automatically`,
        );
      }
      for (const row of this.occurrences.recoverAdmitted()) void this.enqueueRow(row);
      this.recovered = true;
    }
    for (const [codename, session] of this.deps.sessions()) {
      for (const [index, entry] of session.schedules.entries()) {
        if (entry.paused) continue;
        const configuredName = entry.label?.trim();
        const name =
          configuredName !== undefined && configuredName.length > 0 ? configuredName : `schedule-${index + 1}`;
        try {
          const job = new OccurrenceTimer(entry.cron, localTimezone(), async (source) => {
            await this.admitAndEnqueue(codename, entry, index, name, source);
          });
          this.jobs.push(job);
        } catch (err) {
          log().warn(
            'scheduler',
            `${codename}: invalid cron '${entry.cron}' (${name}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    log().debug('scheduler', `${this.jobs.length} schedule(s) armed`);
  }

  private admitAndEnqueue(
    codename: string,
    entry: ScheduleEntry,
    scheduleIndex: number,
    name: string,
    source: ScheduleSource,
  ): Promise<void> {
    const envelope = scheduleEnvelope(name, entry.cron, entry.prompt, source);
    const admitted = this.occurrences.admit({
      id: scheduleOccurrenceId(codename, scheduleIndex, name, entry.cron, source.scheduledAt),
      session: codename,
      scheduleIndex,
      label: name,
      period: entry.cron,
      ...source,
      envelope,
      wakeIfStopped: entry.wakeIfStopped === true,
      freshContext: entry.freshContext,
    });
    if (admitted.deduplicated) return Promise.resolve();
    return this.enqueueRow(admitted.row);
  }

  private enqueueRow(occurrence: ScheduleOccurrenceRow): Promise<void> {
    const codename = occurrence.session;
    this.pendingOccurrences.set(occurrence.id, occurrence);
    const generation = this.generation;
    const cancellation = this.cancellations.get(codename);
    const isCurrent = (): boolean =>
      generation === this.generation && cancellation === this.cancellations.get(codename);
    const previous = this.sessionRuns.get(codename) ?? Promise.resolve();
    const run = previous.then(
      () => this.fire(occurrence, isCurrent),
      () => this.fire(occurrence, isCurrent),
    );
    this.sessionRuns.set(codename, run);
    return run.finally(() => {
      if (this.sessionRuns.get(codename) === run) this.sessionRuns.delete(codename);
    });
  }

  stop(): void {
    this.generation += 1;
    for (const job of this.jobs) job.stop();
    this.jobs = [];
    for (const occurrence of this.pendingOccurrences.values()) {
      this.finish(occurrence, 'admitted', 'skipped-cancelled');
    }
  }

  /** Cancel already queued/in-flight occurrences before an explicit session stop. */
  cancelSession(codename: string): void {
    this.cancellations.set(codename, (this.cancellations.get(codename) ?? 0) + 1);
    for (const occurrence of this.pendingOccurrences.values()) {
      if (occurrence.session === codename) this.finish(occurrence, 'admitted', 'skipped-cancelled');
    }
  }

  private async fire(occurrence: ScheduleOccurrenceRow, isCurrent: () => boolean): Promise<void> {
    const { session: codename, label } = occurrence;
    let submissionStarted = false;
    const canRun = (): boolean => {
      if (!isCurrent()) {
        this.finish(occurrence, 'admitted', 'skipped-cancelled');
        return false;
      }
      return !this.deferPaused(occurrence);
    };
    try {
      if (!canRun()) return;
      const active = await this.deps.isActive(codename);
      if (!canRun()) return;
      // Check before BOTH branches: freshContext alone never grants wake authority.
      // Exact true also keeps older direct callers that omit the field fail-closed.
      if (!active && !occurrence.wakeIfStopped) {
        log().info('scheduler', `${codename}: '${label}' skipped (session is stopped)`);
        this.finish(occurrence, 'admitted', 'skipped-stopped');
        return;
      }
      if (occurrence.freshContext) {
        if (active) {
          await this.deps.stopSession(codename);
          await sleep(FRESH_SESSION_SETTLE_MS);
        }
        if (!canRun()) return;
        const release = this.deps.acquireSubmissionLease?.(codename);
        if (this.deps.acquireSubmissionLease !== undefined && release === undefined) {
          log().info('scheduler', `${codename}: '${label}' deferred (session is paused)`);
          this.finish(occurrence, 'admitted', 'deferred-paused');
          return;
        }
        try {
          submissionStarted = this.occurrences.markDispatching(occurrence.id);
          if (!submissionStarted) return;
          const startResult = await this.deps.startSession(codename, { prompt: occurrence.envelope });
          if (startResult === 'not-started') {
            if (this.occurrences.restoreAdmitted(occurrence.id)) submissionStarted = false;
            this.finish(occurrence, 'admitted', 'failed');
            return;
          }
          log().info('scheduler', `${codename}: '${label}' fired (fresh session)`);
          this.finish(occurrence, 'dispatching', 'fired-fresh');
        } finally {
          release?.();
        }
        return;
      }
      if (active) {
        const result = await this.deps.deliver(codename, occurrence.envelope, {
          pausePolicy: 'hold',
          onSubmissionStarted: () => {
            submissionStarted = this.occurrences.markDispatching(occurrence.id);
            return submissionStarted;
          },
          onSubmissionRejected: () => {
            const restored = this.occurrences.restoreAdmitted(occurrence.id);
            if (restored) submissionStarted = false;
            return restored;
          },
          onUncertain: () => this.unknown(occurrence),
          onDelivered: () => {
            log().info('scheduler', `${codename}: '${label}' fired`);
            this.finish(occurrence, 'dispatching', 'fired');
          },
        });
        if (result === 'no-pane') this.finish(occurrence, 'admitted', 'failed');
        else if (result === 'cancelled') this.finish(occurrence, 'admitted', 'skipped-cancelled');
      } else {
        const release = this.deps.acquireSubmissionLease?.(codename);
        if (this.deps.acquireSubmissionLease !== undefined && release === undefined) {
          log().info('scheduler', `${codename}: '${label}' deferred (session is paused)`);
          this.finish(occurrence, 'admitted', 'deferred-paused');
          return;
        }
        try {
          submissionStarted = this.occurrences.markDispatching(occurrence.id);
          if (!submissionStarted) return;
          const startResult = await this.deps.startSession(codename, { prompt: occurrence.envelope });
          if (startResult === 'not-started') {
            if (this.occurrences.restoreAdmitted(occurrence.id)) submissionStarted = false;
            this.finish(occurrence, 'admitted', 'failed');
            return;
          }
          log().info('scheduler', `${codename}: '${label}' fired`);
          this.finish(occurrence, 'dispatching', 'fired');
        } finally {
          release?.();
        }
      }
    } catch (err) {
      log().error('scheduler', `${codename}: '${label}' failed: ${err instanceof Error ? err.message : String(err)}`);
      if (submissionStarted) this.unknown(occurrence);
      else this.finish(occurrence, 'admitted', 'failed');
    }
  }

  private deferPaused(occurrence: ScheduleOccurrenceRow): boolean {
    if (!this.deps.isPaused(occurrence.session)) return false;
    log().info('scheduler', `${occurrence.session}: '${occurrence.label}' deferred (session is paused)`);
    this.finish(occurrence, 'admitted', 'deferred-paused');
    return true;
  }

  private finish(
    occurrence: ScheduleOccurrenceRow,
    from: 'admitted' | 'dispatching',
    outcome: ScheduleOccurrenceOutcome,
  ): boolean {
    if (!this.occurrences.settle(occurrence.id, from, outcome)) return false;
    this.pendingOccurrences.delete(occurrence.id);
    this.deps.events?.emit({
      type: 'schedule',
      session: occurrence.session,
      label: occurrence.label,
      scheduledAt: occurrence.scheduledAt,
      timezone: occurrence.timezone,
      outcome,
    });
    return true;
  }

  private unknown(occurrence: ScheduleOccurrenceRow): void {
    if (!this.occurrences.markUnknown(occurrence.id)) return;
    this.pendingOccurrences.delete(occurrence.id);
    this.deps.events?.emit({
      type: 'schedule',
      session: occurrence.session,
      label: occurrence.label,
      scheduledAt: occurrence.scheduledAt,
      timezone: occurrence.timezone,
      outcome: 'uncertain',
    });
  }
}
