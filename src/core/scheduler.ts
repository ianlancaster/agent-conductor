import { Cron } from 'croner';
import { log } from '../logger.js';
import type { SessionConfig, ScheduleEntry } from '../config/schema.js';
import { scheduleEnvelope, sleep } from './utils.js';
import type { ConductorEventPublisher } from '../events/types.js';
import type { StartOutcome } from './lifecycle.js';

const FRESH_SESSION_SETTLE_MS = 3000;

export interface SchedulerDeps {
  sessions(): Map<string, SessionConfig>;
  isActive(session: string): boolean | Promise<boolean>;
  isPaused(session: string): boolean;
  startSession(session: string, opts: { prompt?: string }): Promise<StartOutcome>;
  /**
   * Re-read changed session files, then say why a start would be refused right now (for
   * example, a held last-good session config). Called before a schedule stops or launches a
   * session; the re-read may rebuild this scheduler.
   */
  launchRefusal(session: string): string | undefined;
  stopSession(session: string): Promise<string>;
  deliver(session: string, text: string): Promise<unknown>;
  events?: ConductorEventPublisher;
}

/** Cron scheduling of session prompts, on croner. Rebuilt whenever configs reload. */
export class Scheduler {
  private jobs: Cron[] = [];
  /** Serialize all schedules targeting one session, not merely each Cron job. */
  private readonly sessionRuns = new Map<string, Promise<void>>();
  /**
   * Identity of every armed schedule entry. An occurrence stays valid while its own entry is
   * armed, so a reload that leaves that entry unchanged (another session's edit, or the
   * pre-launch session-file refresh) does not cancel it; removing, changing, or pausing the
   * entry, and stopping the scheduler, still do.
   */
  private readonly armed = new Set<string>();
  private readonly cancellations = new Map<string, number>();

  constructor(private readonly deps: SchedulerDeps) {}

  /** Tear down and re-create all jobs from current configs. */
  rebuild(): void {
    this.stop();
    for (const [codename, session] of this.deps.sessions()) {
      for (const [index, entry] of session.schedules.entries()) {
        if (entry.paused) continue;
        const configuredName = entry.label?.trim();
        const name =
          configuredName !== undefined && configuredName.length > 0 ? configuredName : `schedule-${index + 1}`;
        try {
          // The callback must be async (not a sync fn that voids a promise) or
          // croner's `protect` clears the moment the sync fn returns and overlap
          // protection never engages.
          const key = JSON.stringify([codename, name, entry]);
          const job = new Cron(entry.cron, { catch: true, protect: true }, async () => {
            await this.enqueue(codename, entry, name, key);
          });
          this.jobs.push(job);
          this.armed.add(key);
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

  private enqueue(codename: string, entry: ScheduleEntry, name: string, key: string): Promise<void> {
    const cancellation = this.cancellations.get(codename);
    const isCurrent = (): boolean => this.armed.has(key) && cancellation === this.cancellations.get(codename);
    const previous = this.sessionRuns.get(codename) ?? Promise.resolve();
    const run = previous.then(
      () => this.fire(codename, entry, name, isCurrent),
      () => this.fire(codename, entry, name, isCurrent),
    );
    this.sessionRuns.set(codename, run);
    return run.finally(() => {
      if (this.sessionRuns.get(codename) === run) this.sessionRuns.delete(codename);
    });
  }

  stop(): void {
    this.armed.clear();
    for (const job of this.jobs) job.stop();
    this.jobs = [];
  }

  /** Cancel already queued/in-flight occurrences before an explicit session stop. */
  cancelSession(codename: string): void {
    this.cancellations.set(codename, (this.cancellations.get(codename) ?? 0) + 1);
  }

  private async fire(codename: string, entry: ScheduleEntry, name: string, isCurrent: () => boolean): Promise<void> {
    const label = name;
    const prompt = scheduleEnvelope(name, entry.cron, entry.prompt);
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
      if (entry.freshContext || !active) {
        // About to stop and/or launch: pick up session-file edits first. The reload this
        // may trigger can change or remove this very entry, so recheck before acting, and
        // never stop a running session that could not be started again.
        const refusal = this.deps.launchRefusal(codename);
        if (!canRun()) return;
        if (refusal !== undefined) {
          this.refused(codename, label, refusal);
          return;
        }
      }
      if (entry.freshContext) {
        if (active) {
          await this.deps.stopSession(codename);
          await sleep(FRESH_SESSION_SETTLE_MS);
        }
        if (!canRun()) return;
        const outcome = await this.deps.startSession(codename, { prompt });
        if (!outcome.launched) {
          this.refused(codename, label, outcome.message);
          return;
        }
        log().info('scheduler', `${codename}: '${label}' fired (fresh session)`);
        this.deps.events?.emit({ type: 'schedule', session: codename, label, outcome: 'fired-fresh' });
        return;
      }
      if (active) {
        await this.deps.deliver(codename, prompt);
      } else {
        const outcome = await this.deps.startSession(codename, { prompt });
        if (!outcome.launched) {
          this.refused(codename, label, outcome.message);
          return;
        }
      }
      log().info('scheduler', `${codename}: '${label}' fired`);
      this.deps.events?.emit({ type: 'schedule', session: codename, label, outcome: 'fired' });
    } catch (err) {
      log().error('scheduler', `${codename}: '${label}' failed: ${err instanceof Error ? err.message : String(err)}`);
      this.deps.events?.emit({ type: 'schedule', session: codename, label, outcome: 'failed' });
    }
  }

  /** The start did not launch, so the prompt was not delivered: say so instead of reporting a fire. */
  private refused(codename: string, label: string, reason: string): void {
    log().warn('scheduler', `${codename}: '${label}' refused: ${reason}`);
    this.deps.events?.emit({ type: 'schedule', session: codename, label, outcome: 'refused' });
  }

  private deferPaused(codename: string, label: string): boolean {
    if (!this.deps.isPaused(codename)) return false;
    log().info('scheduler', `${codename}: '${label}' deferred (session is paused)`);
    this.deps.events?.emit({ type: 'schedule', session: codename, label, outcome: 'deferred-paused' });
    return true;
  }
}
