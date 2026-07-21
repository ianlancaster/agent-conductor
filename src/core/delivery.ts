import { log } from '../logger.js';
import type { SessionRuntime } from '../runtimes/types.js';
import type { TerminalBackend } from '../terminals/types.js';
import type { PaneRef } from './types.js';

export type DeliveryResult = 'delivered' | 'queued' | 'no-pane';

/**
 * What the pane tells us about typing into it right now.
 * - `clear`    — the runtime's input line is visibly empty (or unknowable but
 *   the session has proven it is up); typing is safe.
 * - `operator` — the input line holds UNSIGNED content: a human is composing.
 *   Never type — our deliveries end with Enter, which would submit the
 *   operator's half-typed message. Not even overdue messages go out; the
 *   queue releases the moment the line clears (submitted or deleted).
 * - `busy`     — the input line holds one of the conductor's own unsubmitted
 *   envelopes; overdue force-delivery may proceed.
 * - `not-up`   — no runtime chrome visible AND no lifecycle event yet: the
 *   pane may still be a shell executing the launch command, where typed text
 *   splices into the command line and corrupts it. Never type, even overdue.
 */
type TypingState = 'clear' | 'operator' | 'busy' | 'not-up';

interface QueuedMessage {
  text: string;
  queuedAt: number;
  onDelivered?: () => void;
}

export interface DeliveryOptions {
  /** Receipt callback invoked exactly once, after the pane write succeeds. */
  onDelivered?: () => void;
}

export interface DeliveryDeps {
  backend: TerminalBackend;
  runtimeFor(session: string): SessionRuntime | undefined;
  getPane(session: string): PaneRef | undefined;
  /**
   * Whether the session's runtime has proven it is up (first lifecycle event).
   * Until then nothing is typed into the pane — a message racing the launch
   * command splices into the shell line and corrupts it.
   */
  isReady(session: string): boolean;
  /** Called only after text has actually been submitted to a live runtime pane. */
  onDelivered?(session: string): void;
  config: {
    queueDrainMs: number;
    queueMaxAgeMs: number;
  };
}

/**
 * Typing-aware message delivery. If the session's input line has content (the
 * operator is mid-composition, or another message is queued in the TUI), the
 * message is held and retried every `queueDrainMs`, force-delivered after
 * `queueMaxAgeMs` so nothing is silently lost. Three hard rules:
 *
 * - Queued messages drain ONE per pass, not as a burst — back-to-back
 *   paste+Enter sequences have been observed to leave the later messages
 *   concatenated and UNSUBMITTED in the runtime's composer.
 * - An operator draft is NEVER typed over, no matter how overdue the queue
 *   is. Everything waits behind it and releases as soon as the input clears.
 * - Overdue force-delivery overrides only a stuck conductor envelope
 *   (`busy`), never a booting pane (`not-up`): typing over the launch
 *   command corrupts it.
 */
export class DeliveryQueue {
  private readonly queues = new Map<string, QueuedMessage[]>();
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(private readonly deps: DeliveryDeps) {}

  async deliverOrQueue(session: string, text: string, options: DeliveryOptions = {}): Promise<DeliveryResult> {
    const pane = this.deps.getPane(session);
    if (pane === undefined) return 'no-pane';

    const existing = this.queues.get(session);
    if ((existing === undefined || existing.length === 0) && (await this.typingState(session, pane)) === 'clear') {
      try {
        await this.deps.backend.run(pane, text);
        this.recordDelivered(session, options.onDelivered);
        return 'delivered';
      } catch (err) {
        // The pane errored on write (closed window, dead tmux). Queue for retry
        // rather than letting the rejection escape — callers are often fire-and-forget.
        log().warn(
          'delivery',
          `${session}: direct delivery failed, queueing: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const queue = existing ?? [];
    queue.push({ text, queuedAt: Date.now(), onDelivered: options.onDelivered });
    this.queues.set(session, queue);
    this.ensureTimer();
    log().debug('delivery', `${session}: input busy — queued message (${queue.length} pending)`);
    return 'queued';
  }

  pendingCount(session: string): number {
    return this.queues.get(session)?.length ?? 0;
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
    for (const [session, queue] of [...this.queues.entries()]) {
      if (queue.length === 0) {
        this.queues.delete(session);
        continue;
      }
      const pane = this.deps.getPane(session);
      if (pane === undefined || !(await this.safeIsAlive(pane))) {
        // A pane can disappear transiently during an agent restart. Keep the
        // queue: the next drain resolves the replacement pane by codename.
        // Durable direct messages are also recovered from SQLite after a
        // conductor restart, so neither lifecycle boundary loses them.
        log().debug('delivery', `${session}: no live pane — holding ${queue.length} queued message(s)`);
        continue;
      }
      const oldest = queue[0];
      if (oldest === undefined) {
        this.queues.delete(session);
        continue;
      }
      const state = await this.typingState(session, pane);
      if (state === 'not-up') continue;
      if (state === 'operator') {
        log().debug('delivery', `${session}: operator is composing — holding ${queue.length} message(s)`);
        continue;
      }
      const overdue = Date.now() - oldest.queuedAt >= this.deps.config.queueMaxAgeMs;
      if (state === 'clear' || overdue) {
        if (state !== 'clear') log().debug('delivery', `${session}: force-delivering overdue message`);
        // One message per pass: each submit gets a full drain interval to be
        // processed before the next one is typed.
        try {
          await this.deps.backend.run(pane, oldest.text);
          // Remove only AFTER a successful write. Shifting first silently lost
          // the message whenever iTerm/osascript failed during a drain.
          queue.shift();
          this.recordDelivered(session, oldest.onDelivered);
        } catch (err) {
          log().warn(
            'delivery',
            `${session}: delivery failed; retaining for retry: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (queue.length === 0) this.queues.delete(session);
        else this.ensureTimer();
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
   * Classify the pane for typing. Visible runtime chrome (parseInputState
   * returns non-null) proves the process is up — the draft's signature (or
   * absence of one) decides whose content is in the way. NO chrome (null, or
   * capture failure) falls back to the event-based ready flag: ready → clear,
   * otherwise `not-up`.
   */
  private async typingState(session: string, pane: PaneRef): Promise<TypingState> {
    const runtime = this.deps.runtimeFor(session);
    const fallback = (): TypingState => (this.deps.isReady(session) ? 'clear' : 'not-up');
    if (runtime === undefined) return fallback();
    try {
      const capture =
        runtime.capabilities.styledCapture && this.deps.backend.captureStyled !== undefined
          ? await this.deps.backend.captureStyled(pane, 10)
          : await this.deps.backend.capture(pane, 10);
      const state = runtime.parseInputState(capture, session);
      if (state === null) return fallback();
      if (state === 'clear') return 'clear';
      return state === 'operator-draft' ? 'operator' : 'busy';
    } catch {
      return fallback();
    }
  }

  private async safeIsAlive(pane: PaneRef): Promise<boolean> {
    try {
      return await this.deps.backend.isAlive(pane);
    } catch {
      return false;
    }
  }

  private recordDelivered(session: string, receipt?: () => void): void {
    this.deps.onDelivered?.(session);
    if (receipt === undefined) return;
    try {
      receipt();
    } catch (err) {
      // The pane write already succeeded, so retrying would duplicate the
      // message. Surface the receipt failure without putting text back in the
      // queue.
      log().error(
        'delivery',
        `${session}: delivered but receipt update failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
