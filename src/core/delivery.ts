import { log } from '../logger.js';
import type { AgentRuntime } from '../runtimes/types.js';
import type { TerminalBackend } from '../terminals/types.js';
import type { PaneRef } from './types.js';

export type DeliveryResult = 'delivered' | 'queued' | 'no-pane';

interface QueuedMessage {
  text: string;
  queuedAt: number;
}

export interface DeliveryDeps {
  backend: TerminalBackend;
  runtimeFor(agent: string): AgentRuntime | undefined;
  getPane(agent: string): PaneRef | undefined;
  config: {
    queueDrainMs: number;
    queueMaxAgeMs: number;
  };
}

/**
 * Typing-aware message delivery. If the agent's input line has content (the
 * operator is mid-composition, or another message is queued in the TUI), the
 * message is held and retried every `queueDrainMs`, force-delivered after
 * `queueMaxAgeMs` so nothing is silently lost.
 */
export class DeliveryQueue {
  private readonly queues = new Map<string, QueuedMessage[]>();
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(private readonly deps: DeliveryDeps) {}

  async deliverOrQueue(agent: string, text: string): Promise<DeliveryResult> {
    const pane = this.deps.getPane(agent);
    if (pane === undefined) return 'no-pane';

    const existing = this.queues.get(agent);
    if ((existing === undefined || existing.length === 0) && (await this.isInputClear(agent, pane))) {
      try {
        await this.deps.backend.run(pane, text);
        return 'delivered';
      } catch (err) {
        // The pane errored on write (closed window, dead tmux). Queue for retry
        // rather than letting the rejection escape — callers are often fire-and-forget.
        log().warn(
          'delivery',
          `${agent}: direct delivery failed, queueing: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const queue = existing ?? [];
    queue.push({ text, queuedAt: Date.now() });
    this.queues.set(agent, queue);
    this.ensureTimer();
    log().debug('delivery', `${agent}: input busy — queued message (${queue.length} pending)`);
    return 'queued';
  }

  pendingCount(agent: string): number {
    return this.queues.get(agent)?.length ?? 0;
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One drain pass over all queues. Concurrent calls (timer ticks overlapping a
   * slow capture) join the in-flight pass instead of double-delivering.
   */
  drainNow(): Promise<void> {
    this.inFlight ??= this.drainPass().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async drainPass(): Promise<void> {
    for (const [agent, queue] of [...this.queues.entries()]) {
      if (queue.length === 0) {
        this.queues.delete(agent);
        continue;
      }
      const pane = this.deps.getPane(agent);
      if (pane === undefined || !(await this.safeIsAlive(pane))) {
        log().warn('delivery', `${agent}: pane gone — dropping ${queue.length} queued message(s)`);
        this.queues.delete(agent);
        continue;
      }
      const oldest = queue[0];
      const overdue = oldest !== undefined && Date.now() - oldest.queuedAt >= this.deps.config.queueMaxAgeMs;
      if (overdue || (await this.isInputClear(agent, pane))) {
        if (overdue) log().debug('delivery', `${agent}: force-delivering ${queue.length} overdue message(s)`);
        for (const message of queue) {
          try {
            await this.deps.backend.run(pane, message.text);
          } catch (err) {
            log().warn('delivery', `${agent}: delivery failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        this.queues.delete(agent);
      }
    }
    if (this.queues.size === 0) this.stop();
  }

  private ensureTimer(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.drainNow();
    }, this.deps.config.queueDrainMs);
    this.timer.unref();
  }

  /**
   * Whether it is safe to type into the pane. Unknown (no runtime, capture
   * failure, no visible input line) is treated as clear — matching cc-conductor:
   * only a definitively busy input line queues.
   */
  private async isInputClear(agent: string, pane: PaneRef): Promise<boolean> {
    const runtime = this.deps.runtimeFor(agent);
    if (runtime === undefined) return true;
    try {
      const capture = await this.deps.backend.capture(pane, 10);
      return runtime.parseInputClear(capture) ?? true;
    } catch {
      return true;
    }
  }

  private async safeIsAlive(pane: PaneRef): Promise<boolean> {
    try {
      return await this.deps.backend.isAlive(pane);
    } catch {
      return false;
    }
  }
}
