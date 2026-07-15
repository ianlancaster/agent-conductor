import { Cron } from 'croner';
import { log } from '../logger.js';
import type { AgentConfig, ScheduleEntry } from '../config/schema.js';
import { sleep } from './utils.js';

const FRESH_SESSION_SETTLE_MS = 3000;

export interface SchedulerDeps {
  agents(): Map<string, AgentConfig>;
  isActive(agent: string): boolean;
  isPaused(agent: string): boolean;
  startAgent(agent: string, opts: { prompt?: string }): Promise<string>;
  stopAgent(agent: string): Promise<string>;
  deliver(agent: string, text: string): Promise<unknown>;
}

/** Cron scheduling of agent prompts, on croner. Rebuilt whenever configs reload. */
export class Scheduler {
  private jobs: Cron[] = [];

  constructor(private readonly deps: SchedulerDeps) {}

  /** Tear down and re-create all jobs from current configs. */
  rebuild(): void {
    this.stop();
    for (const [codename, agent] of this.deps.agents()) {
      for (const entry of agent.schedules) {
        if (entry.paused) continue;
        try {
          // The callback must be async (not a sync fn that voids a promise) or
          // croner's `protect` clears the moment the sync fn returns and overlap
          // protection never engages.
          const job = new Cron(entry.cron, { catch: true, protect: true }, async () => {
            await this.fire(codename, entry);
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

  stop(): void {
    for (const job of this.jobs) job.stop();
    this.jobs = [];
  }

  private async fire(codename: string, entry: ScheduleEntry): Promise<void> {
    const label = entry.label ?? entry.cron;
    try {
      if (this.deps.isPaused(codename)) {
        log().info('scheduler', `${codename}: '${label}' deferred (agent is paused)`);
        return;
      }
      if (entry.freshSession) {
        if (this.deps.isActive(codename)) {
          await this.deps.stopAgent(codename);
          await sleep(FRESH_SESSION_SETTLE_MS);
        }
        await this.deps.startAgent(codename, { prompt: entry.prompt });
        log().info('scheduler', `${codename}: '${label}' fired (fresh session)`);
        return;
      }
      if (this.deps.isActive(codename)) {
        await this.deps.deliver(codename, entry.prompt);
      } else {
        await this.deps.startAgent(codename, { prompt: entry.prompt });
      }
      log().info('scheduler', `${codename}: '${label}' fired`);
    } catch (err) {
      log().error('scheduler', `${codename}: '${label}' failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
