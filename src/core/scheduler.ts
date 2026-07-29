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
    const previous = this.sessionRuns.get(codename) ?? Promise.resolve();
    const run = previous.then(
      () => this.fire(codename, entry),
      () => this.fire(codename, entry),
    );
    this.sessionRuns.set(codename, run);
    return run.finally(() => {
      if (this.sessionRuns.get(codename) === run) this.sessionRuns.delete(codename);
    });
  }

  stop(): void {
    for (const job of this.jobs) job.stop();
    this.jobs = [];
  }

  private async fire(codename: string, entry: ScheduleEntry): Promise<void> {
    const label = entry.label ?? entry.cron;
    try {
      if (this.deps.isPaused(codename)) {
        log().info('scheduler', `${codename}: '${label}' deferred (session is paused)`);
        this.deps.events?.emit({ type: 'schedule', session: codename, label, outcome: 'deferred-paused' });
        return;
      }
      if (entry.freshContext) {
        if (await this.deps.isActive(codename)) {
          await this.deps.stopSession(codename);
          await sleep(FRESH_SESSION_SETTLE_MS);
        }
        await this.deps.startSession(codename, { prompt: entry.prompt });
        log().info('scheduler', `${codename}: '${label}' fired (fresh session)`);
        this.deps.events?.emit({ type: 'schedule', session: codename, label, outcome: 'fired-fresh' });
        return;
      }
      // Firing and arriving are different facts. A session holding a prompt or a
      // draft cannot receive, and a schedule that reports `fired` for a message
      // still sitting in a queue tells its owner they have coverage they do not
      // have — which is how ten consecutive sweeps went unreported.
      let queued = false;
      if (await this.deps.isActive(codename)) {
        queued = (await this.deps.deliver(codename, entry.prompt)) === 'queued';
      } else {
        await this.deps.startSession(codename, { prompt: entry.prompt });
      }
      log().info('scheduler', `${codename}: '${label}' ${queued ? 'fired but held for delivery' : 'fired'}`);
      this.deps.events?.emit({
        type: 'schedule',
        session: codename,
        label,
        outcome: queued ? 'queued' : 'fired',
      });
    } catch (err) {
      log().error('scheduler', `${codename}: '${label}' failed: ${err instanceof Error ? err.message : String(err)}`);
      this.deps.events?.emit({ type: 'schedule', session: codename, label, outcome: 'failed' });
    }
  }
}
