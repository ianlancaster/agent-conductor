import { setTimeout as sleep } from 'node:timers/promises';
import type { ShepherdConfig } from './config.js';
import type { PollSummary, ShepherdEngine } from './engine.js';
import type { CoordinatorSink, ShepherdStore } from './types.js';
import { PermanentDeliveryError } from './types.js';

export class ShepherdService {
  private stopped = false;
  private recovered = false;

  constructor(
    private readonly config: ShepherdConfig,
    private readonly engine: Pick<ShepherdEngine, 'pollOnce'>,
    private readonly store: ShepherdStore,
    private readonly sink: CoordinatorSink,
    private readonly runtime?: {
      pollStarted(): void;
      pollSucceeded(): void;
      pollFailed(error: unknown): void;
    },
    private readonly ownershipGuard?: () => void,
  ) {}

  async pollAndDeliver(): Promise<PollSummary> {
    this.ownershipGuard?.();
    this.recoverInFlightOnce();
    this.runtime?.pollStarted();
    try {
      const summary = await this.engine.pollOnce();
      this.runtime?.pollSucceeded();
      return summary;
    } catch (error) {
      this.runtime?.pollFailed(error);
      throw error;
    } finally {
      await this.drainOutbox();
    }
  }

  async start(signal?: AbortSignal): Promise<void> {
    this.stopped = false;
    while (!this.stopped && signal?.aborted !== true) {
      const started = Date.now();
      try {
        await this.pollAndDeliver();
      } catch (error) {
        this.store.logHealth('poll-failed', error instanceof Error ? error.message : String(error));
      }
      const elapsed = Date.now() - started;
      const waitMs = Math.max(0, this.config.polling.intervalSeconds * 1000 - elapsed);
      if (waitMs > 0 && !this.stopped) {
        try {
          await sleep(waitMs, undefined, signal === undefined ? undefined : { signal });
        } catch {
          // Abort is normal shutdown.
        }
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  async drainOutbox(): Promise<void> {
    this.recoverInFlightOnce();
    const batch = this.store.claimOutbox(new Date());
    for (const item of batch) {
      try {
        const receipt = await this.sink.send(item);
        if (receipt?.status === 'queued') {
          throw new Error('Conductor queued the message for this run; awaiting a delivered receipt.');
        }
        this.store.completeOutbox(item.id, receipt);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof PermanentDeliveryError) {
          this.store.parkOutbox(item.id, message);
          continue;
        }
        const exponent = Math.min(item.attempts, 8);
        const delayMs = Math.min(300_000, 1_000 * 2 ** exponent);
        this.store.retryOutbox(item.id, new Date(Date.now() + delayMs), message);
      }
    }
  }

  private recoverInFlightOnce(): void {
    if (!this.recovered) {
      this.store.recoverInFlight();
      this.recovered = true;
    }
  }
}
