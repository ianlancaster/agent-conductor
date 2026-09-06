import { Cron } from 'croner';
import { log } from '../logger.js';
import type { SessionConfig, ScheduleEntry } from '../config/schema.js';
import { sleep } from './utils.js';
import type { ConductorEventPublisher } from '../events/types.js';

const FRESH_SESSION_SETTLE_MS = 3000;

export interface SchedulerDeps {
  sessions(): Map<string, SessionConfig>;
  isActive(session: string): boolean | Promise<boolean>;
  isPaused(session: string): boolean;
  startSession(session: string, opts: { prompt?: string }): Promise<string>;
  stopSession(session: string): Promise<string>;
  deliver(session: string, text: string): Promise<unknown>;
  events?: ConductorEventPublisher;
}

/** Cron scheduling of session prompts, on croner. Rebuilt whenever configs reload. */
export class Scheduler {
  private jobs: Cron[] = [];
  /** Serialize all schedules targeting one session, not merely each Cron job. */
  private readonly sessionRuns = new Map<string, Promise<void>>();
  private generation = 0;
  private readonly cancellations = new Map<string, number>();

  constructor(private readonly deps: SchedulerDeps) {}

  /** Tear down and re-create all jobs from current configs. */
  rebuild(): void {
    this.stop();
    for (const [codename, session] of this.deps.sessions()) {
      for (const entry of session.schedules) {
        if (entry.paused) continue;
        try {
          // The callback must be async (not a sync fn that voids a promise) or
          // croner's `protect` clears the moment the sync fn returns and overlap
          // protection never engages.
          const job = new Cron(entry.cron, { catch: true, protect: true }, async () => {
            await this.enqueue(codename, entry);
          });
          this.jobs.push(job);
        } catch (err) {
          log().warn(
            'scheduler',
            `${codename}: invalid cron '${entry.cron}' (${entry.label ?? 'unlabeled'}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    log().debug('scheduler', `${this.jobs.length} schedule(s) armed`);
  }

  private enqueue(codename: string, entry: ScheduleEntry): Promise<void> {
    const generation = this.generation;
    const cancellation = this.cancellations.get(codename);
    const isCurrent = (): boolean =>
      generation === this.generation && cancellation === this.cancellations.get(codename);
    const previous = this.sessionRuns.get(codename) ?? Promise.resolve();
    const run = previous.then(
      () => this.fire(codename, entry, isCurrent),
      () => this.fire(codename, entry, isCurrent),
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
  }

  /** Cancel already queued/in-flight occurrences before an explicit session stop. */
  cancelSession(codename: string): void {
    this.cancellations.set(codename, (this.cancellations.get(codename) ?? 0) + 1);
  }

  private async fire(codename: string, entry: ScheduleEntry, isCurrent: () => boolean): Promise<void> {
    const label = entry.label ?? entry.cron;
    const canRun = (): boolean => {
      if (!isCurrent()) {
        this.deps.events?.emit({ type: 'schedule', session: codename, label, outcome: 'skipped-cancelled' });
        return false;
      }
      return !this.deferPaused(codename, label);
    };
    try {
      if (!canRun()) return;
      const active = await this.deps.isActive(codename);
      if (!canRun()) return;
      // Check before BOTH branches: freshContext alone never grants wake authority.
      // Exact true also keeps older direct callers that omit the field fail-closed.
      if (!active && entry.wakeIfStopped !== true) {
        log().info('scheduler', `${codename}: '${label}' skipped (session is stopped)`);
        this.deps.events?.emit({ type: 'schedule', session: codename, label, outcome: 'skipped-stopped' });
        return;
      }
      if (entry.freshContext) {
        if (active) {
          await this.deps.stopSession(codename);
          await sleep(FRESH_SESSION_SETTLE_MS);
        }
        if (!canRun()) return;
        await this.deps.startSession(codename, { prompt: entry.prompt });
        log().info('scheduler', `${codename}: '${label}' fired (fresh session)`);
        this.deps.events?.emit({ type: 'schedule', session: codename, label, outcome: 'fired-fresh' });
        return;
      }
      if (active) {
        await this.deps.deliver(codename, entry.prompt);
      } else {
        await this.deps.startSession(codename, { prompt: entry.prompt });
      }
      log().info('scheduler', `${codename}: '${label}' fired`);
      this.deps.events?.emit({ type: 'schedule', session: codename, label, outcome: 'fired' });
    } catch (err) {
      log().error('scheduler', `${codename}: '${label}' failed: ${err instanceof Error ? err.message : String(err)}`);
      this.deps.events?.emit({ type: 'schedule', session: codename, label, outcome: 'failed' });
    }
  }

  private deferPaused(codename: string, label: string): boolean {
    if (!this.deps.isPaused(codename)) return false;
    log().info('scheduler', `${codename}: '${label}' deferred (session is paused)`);
    this.deps.events?.emit({ type: 'schedule', session: codename, label, outcome: 'deferred-paused' });
    return true;
  }
}
