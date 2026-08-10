import { log } from '../logger.js';
import type { InputState, SessionRuntime } from '../runtimes/types.js';
import type { TerminalBackend } from '../terminals/types.js';
import type { PaneRef } from './types.js';

export type DeliveryResult = 'delivered' | 'queued' | 'cancelled' | 'no-pane';

export type DeliverySkipReason =
  | 'no-pane'
  | 'pane-not-alive'
  | 'runtime-unavailable'
  | 'capture-failed'
  | 'composer-not-visible'
  | 'input-occupied'
  | 'recipient-paused'
  | 'pane-changed'
  | 'write-failed';

export type CancellationResult = 'cancelled' | 'in-flight' | 'not-found';

/**
 * What the pane tells us about typing into it right now.
 * - `clear`   — the runtime's input line is visibly and unambiguously empty.
 * - `blocked` — the input contains any text, the composer is not visible, or
 *   capture failed. Never type: uncertainty must queue rather than clobber.
 */
type TypingState = 'clear' | 'blocked';

interface TypingObservation {
  state: TypingState;
  /** Runtime-owned composer classification; undefined means observation failed. */
  inputState?: InputState;
  skipReason: DeliverySkipReason | null;
  /** Opaque terminal revision used for an atomic compare-and-submit. */
  token?: string;
}

interface QueuedMessage {
  text: string;
  automated: boolean;
  deliveryId?: number;
  onAttempt?: (skipReason: DeliverySkipReason | null) => void;
  onDelivered?: () => void;
}

export interface DeliveryOptions {
  /** Automated work is held while the recipient's temporary pause flag is set. */
  automated?: boolean;
  /** Durable receipt id, used to cancel a queued delivery without matching text. */
  deliveryId?: number;
  /** Receipt callback invoked for every classification/write attempt. */
  onAttempt?: (skipReason: DeliverySkipReason | null) => void;
  /** Receipt callback invoked exactly once, after the pane write succeeds. */
  onDelivered?: () => void;
}

export interface DeliveryDeps {
  backend: TerminalBackend;
  runtimeFor(session: string): SessionRuntime | undefined;
  /**
   * Runtime parsers to try when the recorded active runtime cannot recognize
   * the visible composer. Surviving panes can outlive the metadata that named
   * the per-run runtime override.
   */
  runtimeCandidates?(session: string): readonly SessionRuntime[];
  getPane(session: string): PaneRef | undefined;
  /** Temporary per-session automation suppression. Manual delivery remains available. */
  isPaused?(session: string): boolean;
  /** Visible runtime input chrome is an independent readiness proof. */
  onRuntimeObserved?(session: string): void;
  /** A non-primary parser uniquely recognized the live runtime's composer. */
  onRuntimeDetected?(session: string, runtimeName: string): void;
  /**
   * Called at the last safe boundary before terminal submission. The returned
   * callback is committed only after the backend confirms that it submitted
   * the text. This lets lifecycle tracking distinguish a turn-start hook that
   * races ahead of the terminal acknowledgement without treating a rejected
   * compare-and-submit as new work.
   */
  onSubmitting?(session: string): (() => void) | undefined;
  /** Called only after text has actually been submitted to a live runtime pane. */
  onDelivered?(session: string): void;
  config: {
    queueDrainMs: number;
  };
}

/**
 * Typing-aware message delivery. If the session's input line has content (the
 * operator is mid-composition, another message is queued in the TUI, or the
 * composer cannot be classified), the message is held and retried every
 * `queueDrainMs`. Three hard rules:
 *
 * - Queued messages drain ONE per pass, not as a burst — back-to-back
 *   paste+Enter sequences have been observed to leave the later messages
 *   concatenated and UNSUBMITTED in the runtime's composer.
 * - ANY draft is NEVER typed over, regardless of age, length, contents, or
 *   envelope signature. Everything waits until the input is visibly empty.
 * - Unknown state is blocked. Runtime readiness, capture failure, hidden
 *   composer chrome, and boot races can never authorize a write.
 */
export class DeliveryQueue {
  private readonly queues = new Map<string, QueuedMessage[]>();
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private readonly assessing = new Set<number>();
  private readonly cancellationRequested = new Set<number>();
  private readonly delivering = new Set<number>();

  constructor(private readonly deps: DeliveryDeps) {}

  async deliverOrQueue(session: string, text: string, options: DeliveryOptions = {}): Promise<DeliveryResult> {
    if (options.deliveryId !== undefined) this.assessing.add(options.deliveryId);
    if (this.automationPaused(session, options.automated === true)) {
      this.assessing.delete(options.deliveryId ?? -1);
      this.recordAttempt(session, options.onAttempt, 'recipient-paused');
      return this.enqueue(session, text, options);
    }
    const pane = this.deps.getPane(session);
    if (pane === undefined) {
      this.assessing.delete(options.deliveryId ?? -1);
      this.recordAttempt(session, options.onAttempt, 'no-pane');
      // Durable deliveries stay in the periodic sweep while a restart swaps
      // panes. Ephemeral callers (broadcasts/schedules) keep the historical
      // no-pane result rather than accumulating an unreceipted queue.
      if (options.deliveryId !== undefined) return this.enqueue(session, text, options);
      return 'no-pane';
    }

    const existing = this.queues.get(session);
    const classification =
      existing === undefined || existing.length === 0 ? await this.typingState(session, pane) : undefined;
    if (options.deliveryId !== undefined && this.cancellationRequested.delete(options.deliveryId)) {
      this.assessing.delete(options.deliveryId);
      return 'cancelled';
    }
    if ((existing === undefined || existing.length === 0) && classification?.state === 'clear') {
      if (options.deliveryId !== undefined) {
        this.assessing.delete(options.deliveryId);
        this.delivering.add(options.deliveryId);
      }
      try {
        const writeSkipReason = await this.submitIfStillClear(
          session,
          pane,
          text,
          classification,
          options.automated === true,
        );
        if (writeSkipReason !== null) {
          this.recordAttempt(session, options.onAttempt, writeSkipReason);
          return this.enqueue(session, text, options, existing);
        }
        this.recordAttempt(session, options.onAttempt, null);
        this.recordDelivered(session, options.onDelivered);
        return 'delivered';
      } catch (err) {
        // The pane errored on write (closed window, dead tmux). Queue for retry
        // rather than letting the rejection escape — callers are often fire-and-forget.
        log().warn(
          'delivery',
          `${session}: direct delivery failed, queueing: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.recordAttempt(session, options.onAttempt, 'write-failed');
      } finally {
        if (options.deliveryId !== undefined) this.delivering.delete(options.deliveryId);
      }
    } else if (classification !== undefined) {
      this.recordAttempt(session, options.onAttempt, classification.skipReason);
    }

    return this.enqueue(session, text, options, existing);
  }

  pendingCount(session: string): number {
    return this.queues.get(session)?.length ?? 0;
  }

  /** Cancel a durable message while it is assessing or waiting in memory. */
  cancel(session: string, deliveryId: number): CancellationResult {
    if (this.delivering.has(deliveryId)) return 'in-flight';
    if (this.assessing.has(deliveryId)) {
      this.cancellationRequested.add(deliveryId);
      return 'cancelled';
    }
    const queue = this.queues.get(session);
    const index = queue?.findIndex((message) => message.deliveryId === deliveryId) ?? -1;
    if (queue === undefined || index < 0) return 'not-found';
    queue.splice(index, 1);
    if (queue.length === 0) this.queues.delete(session);
    if (this.queues.size === 0) this.stop();
    return 'cancelled';
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
        this.recordAttempt(session, queue[0]?.onAttempt, pane === undefined ? 'no-pane' : 'pane-not-alive');
        continue;
      }
      const oldestIndex = queue.findIndex((message) => !this.automationPaused(session, message.automated));
      const oldest = oldestIndex < 0 ? undefined : queue[oldestIndex];
      if (oldest === undefined) {
        this.recordAttempt(session, queue[0]?.onAttempt, 'recipient-paused');
        continue;
      }
      const classification = await this.typingState(session, pane);
      // Cancellation can remove the item while capture is in flight.
      if (queue[oldestIndex] !== oldest) continue;
      if (classification.state === 'clear') {
        // One message per pass: each submit gets a full drain interval to be
        // processed before the next one is typed.
        try {
          if (oldest.deliveryId !== undefined) this.delivering.add(oldest.deliveryId);
          const writeSkipReason = await this.submitIfStillClear(
            session,
            pane,
            oldest.text,
            classification,
            oldest.automated,
          );
          if (writeSkipReason !== null) {
            this.recordAttempt(session, oldest.onAttempt, writeSkipReason);
            continue;
          }
          this.recordAttempt(session, oldest.onAttempt, null);
          // Remove only AFTER a successful write. Shifting first silently lost
          // the message whenever iTerm/osascript failed during a drain.
          queue.splice(oldestIndex, 1);
          this.recordDelivered(session, oldest.onDelivered);
        } catch (err) {
          this.recordAttempt(session, oldest.onAttempt, 'write-failed');
          log().warn(
            'delivery',
            `${session}: delivery failed; retaining for retry: ${err instanceof Error ? err.message : String(err)}`,
          );
        } finally {
          if (oldest.deliveryId !== undefined) this.delivering.delete(oldest.deliveryId);
        }
        if (queue.length === 0) this.queues.delete(session);
        else this.ensureTimer();
      } else {
        this.recordAttempt(session, oldest.onAttempt, classification.skipReason);
        log().debug('delivery', `${session}: input is occupied or uncertain — holding ${queue.length} message(s)`);
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

  private enqueue(
    session: string,
    text: string,
    options: DeliveryOptions,
    existing = this.queues.get(session),
  ): 'queued' {
    const queue = existing ?? [];
    queue.push({
      text,
      automated: options.automated === true,
      ...(options.deliveryId !== undefined ? { deliveryId: options.deliveryId } : {}),
      ...(options.onAttempt !== undefined ? { onAttempt: options.onAttempt } : {}),
      ...(options.onDelivered !== undefined ? { onDelivered: options.onDelivered } : {}),
    });
    this.queues.set(session, queue);
    if (options.deliveryId !== undefined) this.assessing.delete(options.deliveryId);
    this.ensureTimer();
    log().debug('delivery', `${session}: input busy or unavailable — queued message (${queue.length} pending)`);
    return 'queued';
  }

  /**
   * Classify the pane for typing. The only safe state is an explicitly empty
   * runtime composer. Any text, missing chrome, or capture failure blocks.
   */
  private async typingState(session: string, pane: PaneRef): Promise<TypingObservation> {
    const runtime = this.deps.runtimeFor(session);
    if (runtime === undefined) return { state: 'blocked', skipReason: 'runtime-unavailable' };
    try {
      let capture: string;
      let token: string | undefined;
      if (this.deps.backend.captureForDelivery !== undefined) {
        const observation = await this.deps.backend.captureForDelivery(pane, 10, {
          styled: runtime.capabilities.styledCapture,
        });
        capture = observation.content;
        token = observation.token;
      } else if (runtime.capabilities.styledCapture && this.deps.backend.captureStyled !== undefined) {
        capture = await this.deps.backend.captureStyled(pane, 10);
      } else {
        capture = await this.deps.backend.capture(pane, 10);
      }
      let selectedRuntime = runtime;
      let state = runtime.parseInputState(capture, session);
      if (state === null) {
        const alternatives = (this.deps.runtimeCandidates?.(session) ?? [])
          .filter((candidate) => candidate.name !== runtime.name)
          .map((candidate) => ({ candidate, state: candidate.parseInputState(capture, session) }))
          .filter((result) => result.state !== null);
        // One distinctive alternate composer is enough to repair stale
        // active-runtime metadata. Ambiguous recognition remains blocked.
        if (alternatives.length === 1) {
          const recognized = alternatives[0];
          if (recognized !== undefined) {
            selectedRuntime = recognized.candidate;
            state = recognized.state;
            this.deps.onRuntimeDetected?.(session, selectedRuntime.name);
          }
        }
      }
      if (state !== 'clear' && selectedRuntime.resolveInputState !== undefined) {
        state = await selectedRuntime.resolveInputState(capture, session, state);
      }
      if (state === null) return { state: 'blocked', inputState: null, skipReason: 'composer-not-visible' };
      this.deps.onRuntimeObserved?.(session);
      if (state === 'clear') {
        return { state: 'clear', inputState: 'clear', skipReason: null, ...(token !== undefined ? { token } : {}) };
      }
      return { state: 'blocked', inputState: 'draft', skipReason: 'input-occupied' };
    } catch {
      return { state: 'blocked', skipReason: 'capture-failed' };
    }
  }

  /**
   * Close the observation/write race. Backends with an atomic compare-and-submit
   * use their opaque capture token; other backends get a mandatory second
   * composer classification immediately before the write. Any change fails
   * closed and leaves the message queued.
   */
  private async submitIfStillClear(
    session: string,
    pane: PaneRef,
    text: string,
    observation: TypingObservation,
    automated: boolean,
  ): Promise<DeliverySkipReason | null> {
    if (this.automationPaused(session, automated)) return 'recipient-paused';
    if (observation.token !== undefined && this.deps.backend.submitIfUnchanged !== undefined) {
      const confirmSubmission = this.prepareSubmission(session);
      if (!(await this.deps.backend.submitIfUnchanged(pane, text, observation.token))) return 'pane-changed';
      this.confirmSubmission(session, confirmSubmission);
      return null;
    }

    const confirmation = await this.typingState(session, pane);
    if (confirmation.state !== 'clear') return confirmation.skipReason ?? 'pane-changed';
    if (this.automationPaused(session, automated)) return 'recipient-paused';
    const confirmSubmission = this.prepareSubmission(session);
    await this.deps.backend.run(pane, text);
    this.confirmSubmission(session, confirmSubmission);
    return null;
  }

  private automationPaused(session: string, automated: boolean): boolean {
    return automated && this.deps.isPaused?.(session) === true;
  }

  private prepareSubmission(session: string): (() => void) | undefined {
    try {
      return this.deps.onSubmitting?.(session);
    } catch (err) {
      // Lifecycle observation must never prevent delivery at an otherwise-safe
      // composer boundary.
      log().error(
        'delivery',
        `${session}: pre-submit observer failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  private confirmSubmission(session: string, confirm: (() => void) | undefined): void {
    if (confirm === undefined) return;
    try {
      confirm();
    } catch (err) {
      // The terminal write already succeeded. Never turn an observation error
      // into a queued retry that would duplicate the submitted message.
      log().error(
        'delivery',
        `${session}: submission observer failed: ${err instanceof Error ? err.message : String(err)}`,
      );
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

  private recordAttempt(
    session: string,
    receipt: ((skipReason: DeliverySkipReason | null) => void) | undefined,
    skipReason: DeliverySkipReason | null,
  ): void {
    if (receipt === undefined) return;
    try {
      receipt(skipReason);
    } catch (err) {
      log().error(
        'delivery',
        `${session}: flush-attempt receipt update failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
