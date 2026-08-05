import { log } from '../logger.js';
import type { InputState, SessionRuntime } from '../runtimes/types.js';
import type { TerminalBackend } from '../terminals/types.js';
import type { PaneActivityEvidence, PaneRef, RuntimeEvent, StallKind } from './types.js';

export interface StallInfo {
  reason?: string;
  transcriptPath?: string;
  /** ISO-8601 instant when Conductor mechanically classified the stall. */
  detectedAt?: string;
}

export interface HealthDeps {
  config: {
    captureLines: number;
    stallBeatsThreshold: number;
    idleConfirmMs: number;
    eventSilenceMs: number;
  };
  backend: TerminalBackend;
  runtimeFor(session: string): SessionRuntime | undefined;
  getPane(session: string): PaneRef | undefined;
  getActiveSessions(): string[];
  /** A live foreground process proves launch completed even before a runtime hook fires. */
  onRuntimeObserved?(session: string): void;
  /** Runtime-owned execution evidence used to reconcile best-effort lifecycle hooks. */
  observeActivity(session: string, pane: PaneRef): Promise<PaneActivityEvidence>;
  /** Runtime-owned composer state used to keep human drafts out of idle routing. */
  observeInputState(session: string, pane: PaneRef): Promise<InputState>;
  onStall(session: string, kind: StallKind, info: StallInfo): void;
  onWorking(session: string): void;
  onSessionEnd(session: string): void;
  logEvent(session: string, event: string, detail?: string): void;
}

/**
 * Event-driven health monitor with a pane-diff fallback watchdog.
 *
 * Primary signal: runtime lifecycle events (Claude hooks, Codex notify).
 *  - `stop` starts a quiet timer; if nothing else arrives it becomes an idle stall.
 *  - `notification` = blocked on a decision — immediate stall.
 *  - `compaction` records the start; compact completion becomes a stall only
 *    after the runtime confirms that the session is waiting.
 * Reconciliation: supported runtimes continuously classify execution evidence
 * independently from input readiness. Active-turn chrome takes precedence over
 * a visible composer because both supported runtimes can accept steering or
 * queued input while a turn is running. This repairs missed/out-of-order
 * best-effort hook delivery without mistaking pane silence for turn completion.
 * Fallback: only runtimes without authoritative turn completion may turn an
 * unchanged pane into a `silent` stall.
 */
export class HealthMonitor {
  private readonly turnPhases = new Map<string, 'active' | 'complete' | 'interrupted'>();
  /** Multiple Codex hook turns may overlap while the root turn owns the pane. */
  private readonly activeTurnIds = new Map<string, Set<string>>();
  /** Newer work was submitted before its runtime-owned turn id arrived. */
  private readonly pendingTurnIds = new Set<string>();
  /** Invalidates an asynchronous activity observation when a newer event wins. */
  private readonly eventSequences = new Map<string, number>();
  /** Ensures a slower, older pane capture cannot overwrite newer evidence. */
  private readonly observationSequences = new Map<string, number>();
  private readonly latestTurnStartSequence = new Map<string, number>();
  private readonly latestTurnStartId = new Map<string, string>();
  private readonly latestCompletionSequence = new Map<string, number>();
  private lifecycleSequence = 0;
  private readonly lastActivityAt = new Map<string, number>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly lastCapture = new Map<string, string>();
  private readonly stillBeats = new Map<string, number>();
  private readonly silentNotified = new Set<string>();
  private readonly pendingCompactions = new Map<string, StallInfo>();
  private heartbeatInFlight = false;

  constructor(private readonly deps: HealthDeps) {}

  handleEvent(event: RuntimeEvent): void {
    const { session } = event;
    this.bumpEventSequence(session);
    if (event.type === 'stop' && event.turnId !== undefined) {
      const activeTurnIds = this.activeTurnIds.get(session);
      if (this.pendingTurnIds.has(session)) {
        activeTurnIds?.delete(event.turnId);
        this.deps.logEvent(session, 'stale_turn_completion', 'out-of-order completion ignored');
        return;
      }
      if (activeTurnIds !== undefined && !activeTurnIds.has(event.turnId)) {
        this.deps.logEvent(session, 'stale_turn_completion', 'out-of-order completion ignored');
        return;
      }
      if (activeTurnIds?.delete(event.turnId) === true && activeTurnIds.size > 0) {
        this.lastActivityAt.set(session, event.receivedAt);
        this.deps.logEvent(session, 'nested_turn_completion', 'another runtime turn remains active');
        return;
      }
    }
    this.lastActivityAt.set(session, event.receivedAt);
    this.clearIdleTimer(session);

    switch (event.type) {
      case 'turn-start': {
        this.lifecycleSequence += 1;
        this.latestTurnStartSequence.set(session, this.lifecycleSequence);
        this.turnPhases.set(session, 'active');
        const submittedTurn = this.pendingTurnIds.delete(session);
        if (event.turnId === undefined) this.activeTurnIds.delete(session);
        else {
          this.latestTurnStartId.set(session, event.turnId);
          // A hook following a known Conductor submission names the new root
          // turn; unmatched ids from the prior prompt cannot remain active.
          const activeTurnIds = submittedTurn ? new Set<string>() : (this.activeTurnIds.get(session) ?? new Set());
          activeTurnIds.add(event.turnId);
          this.activeTurnIds.set(session, activeTurnIds);
        }
        this.deps.onWorking(session);
        return;
      }
      case 'stop': {
        this.lifecycleSequence += 1;
        this.latestCompletionSequence.set(session, this.lifecycleSequence);
        this.turnPhases.set(session, 'complete');
        this.activeTurnIds.delete(session);
        this.pendingTurnIds.delete(session);
        const info: StallInfo = { reason: event.reason, transcriptPath: event.transcriptPath };
        void this.scheduleIdleReport(session, 'idle', info);
        return;
      }
      case 'notification':
        this.turnPhases.set(session, 'interrupted');
        this.reportStall(session, 'blocked', { reason: event.reason, transcriptPath: event.transcriptPath });
        return;
      case 'compaction':
        this.turnPhases.set(session, 'interrupted');
        this.pendingCompactions.set(session, { transcriptPath: event.transcriptPath });
        return;
      case 'compaction-complete': {
        const info = this.pendingCompactions.get(session) ?? {};
        this.reset(session);
        this.lastActivityAt.set(session, event.receivedAt);
        this.turnPhases.set(session, 'interrupted');
        if (this.deps.config.idleConfirmMs <= 0) {
          void this.confirmCompactionIdle(session, info);
          return;
        }
        const timer = setTimeout(() => {
          this.idleTimers.delete(session);
          void this.confirmCompactionIdle(session, info);
        }, this.deps.config.idleConfirmMs);
        timer.unref();
        this.idleTimers.set(session, timer);
        return;
      }
      case 'session-end':
        this.deps.logEvent(session, 'session_end', event.reason);
        this.reset(session);
        // Claude emits SessionEnd for conversation boundaries such as /clear,
        // even though the CLI process remains alive in the pane. Hooks describe
        // runtime/session semantics; only the terminal process check in
        // checkSession() is authoritative for process liveness.
        return;
      case 'session-start':
        this.reset(session);
        this.lastActivityAt.set(session, event.receivedAt);
        this.turnPhases.set(session, 'active');
        this.deps.onWorking(session);
        return;
    }
  }

  /** One heartbeat of the fallback watchdog. Skips if the previous pass is still running. */
  async heartbeat(): Promise<void> {
    if (this.heartbeatInFlight) {
      log().debug('health', 'heartbeat still in flight — skipping this tick');
      return;
    }
    this.heartbeatInFlight = true;
    try {
      await this.runHeartbeat();
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  private async runHeartbeat(): Promise<void> {
    for (const session of this.deps.getActiveSessions()) {
      try {
        await this.checkSession(session);
      } catch (err) {
        log().warn('health', `${session}: heartbeat check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Clear all per-session tracking (on start/restart/mode change). */
  reset(session: string): void {
    this.clearIdleTimer(session);
    this.turnPhases.delete(session);
    this.activeTurnIds.delete(session);
    this.pendingTurnIds.delete(session);
    this.eventSequences.delete(session);
    this.observationSequences.delete(session);
    this.latestTurnStartSequence.delete(session);
    this.latestTurnStartId.delete(session);
    this.latestCompletionSequence.delete(session);
    this.lastActivityAt.set(session, Date.now());
    this.lastCapture.delete(session);
    this.stillBeats.delete(session);
    this.silentNotified.delete(session);
    this.pendingCompactions.delete(session);
  }

  /** Capture the runtime-event boundary immediately before terminal submission. */
  captureTurnBoundary(): number {
    return this.lifecycleSequence;
  }

  /** Positive evidence that a new turn was submitted through Conductor. */
  markTurnActive(session: string, submissionBoundary?: number): boolean {
    // A very fast turn can both start and finish while the terminal backend is
    // still acknowledging the submitted text. Its completion is authoritative;
    // the later write acknowledgement must not resurrect it as working.
    if (
      submissionBoundary !== undefined &&
      (this.latestCompletionSequence.get(session) ?? Number.NEGATIVE_INFINITY) > submissionBoundary
    ) {
      return false;
    }
    const turnStartedAfterSubmissionBegan =
      submissionBoundary !== undefined &&
      (this.latestTurnStartSequence.get(session) ?? Number.NEGATIVE_INFINITY) > submissionBoundary;
    // A fast runtime hook may arrive before the terminal backend acknowledges
    // the write. Preserve that new runtime-owned id; otherwise invalidate any
    // prior id until the submitted turn reports its own start.
    if (!turnStartedAfterSubmissionBegan) {
      this.pendingTurnIds.add(session);
    } else {
      // A start hook that raced ahead of this Conductor submission identifies
      // the new root turn. Any older unmatched ids cannot still own the pane.
      const latestTurnId = this.latestTurnStartId.get(session);
      if (latestTurnId !== undefined) this.activeTurnIds.set(session, new Set([latestTurnId]));
    }
    this.bumpEventSequence(session);
    this.recordWorking(session);
    return true;
  }

  /**
   * Repair working/idle state from runtime-owned execution evidence.
   * This is safe to call from both the heartbeat and an on-demand status
   * reconciliation. Unknown capture evidence deliberately changes nothing.
   */
  async reconcileActivity(session: string, pane: PaneRef): Promise<void> {
    const runtime = this.deps.runtimeFor(session);
    if (runtime?.capabilities.authoritativeTurnCompletion !== true) return;
    const eventSequence = this.eventSequences.get(session) ?? 0;
    const observationSequence = (this.observationSequences.get(session) ?? 0) + 1;
    this.observationSequences.set(session, observationSequence);
    const activity = await this.deps.observeActivity(session, pane);
    if (
      (this.eventSequences.get(session) ?? 0) !== eventSequence ||
      this.observationSequences.get(session) !== observationSequence ||
      activity === 'unknown'
    )
      return;

    if (activity === 'working') {
      this.pendingCompactions.delete(session);
      this.recordWorking(session);
      this.deps.onWorking(session);
      return;
    }

    if (this.turnPhases.get(session) === 'interrupted') {
      const compaction = this.pendingCompactions.get(session);
      if (compaction !== undefined) {
        // The compaction-complete path already owns this confirmation timer.
        // If it has not fired yet, let it preserve the original debounce.
        if (this.idleTimers.has(session)) return;
        this.pendingCompactions.delete(session);
        this.turnPhases.set(session, 'complete');
        this.activeTurnIds.delete(session);
        this.pendingTurnIds.delete(session);
        await this.scheduleIdleReport(session, 'compaction', compaction);
      }
      return;
    }
    if (this.turnPhases.get(session) === 'complete') return;

    // A missed completion hook must not strand a visibly idle runtime in
    // working forever. Apply the same debounce as an ordinary stop event.
    this.turnPhases.set(session, 'complete');
    this.activeTurnIds.delete(session);
    this.pendingTurnIds.delete(session);
    await this.scheduleIdleReport(session, 'idle', {});
  }

  private recordWorking(session: string): void {
    this.clearIdleTimer(session);
    this.turnPhases.set(session, 'active');
    this.lastActivityAt.set(session, Date.now());
    this.stillBeats.set(session, 0);
    this.silentNotified.delete(session);
  }

  stop(): void {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
  }

  private async checkSession(session: string): Promise<void> {
    const pane = this.deps.getPane(session);
    if (pane === undefined) return;
    if (!(await this.deps.backend.isAlive(pane))) {
      this.deps.logEvent(session, 'pane_dead');
      this.reset(session);
      this.deps.onSessionEnd(session);
      return;
    }
    if (!(await this.deps.backend.isSessionActive(pane))) {
      this.deps.logEvent(session, 'runtime_ended');
      this.reset(session);
      this.deps.onSessionEnd(session);
      return;
    }
    this.deps.onRuntimeObserved?.(session);

    const runtime = this.deps.runtimeFor(session);
    if (runtime?.capabilities.authoritativeTurnCompletion === true) {
      await this.reconcileActivity(session, pane);
      return;
    }
    const rawCapture = await this.deps.backend.capture(pane, this.deps.config.captureLines);
    // Runtime chrome is not evidence of work. In particular, Codex redraws its
    // elapsed timer and background-terminal counter while a dead internal
    // handle is otherwise frozen. Compare the same semantic pane content that
    // the sentinel uses, so animated status rows cannot suppress a stall.
    const capture = runtime !== undefined ? runtime.stripChrome(rawCapture) : rawCapture;
    const previousCapture = this.lastCapture.get(session);
    if (capture !== previousCapture) {
      this.lastCapture.set(session, capture);
      this.stillBeats.set(session, 0);
      this.silentNotified.delete(session);
      // The first capture is only a baseline; a subsequent visible change is
      // evidence of work for runtimes without a turn-start event.
      if (previousCapture !== undefined) {
        const wasActive = this.turnPhases.get(session) === 'active';
        // Resumed output after an interruption belongs to the same runtime
        // turn; unlike a newly submitted Conductor message, it must preserve
        // the runtime-owned turn id for the eventual completion match.
        this.recordWorking(session);
        if (!wasActive) this.deps.onWorking(session);
      } else if (!this.lastActivityAt.has(session)) {
        this.lastActivityAt.set(session, Date.now());
      }
      return;
    }

    const lastActivity = this.lastActivityAt.get(session);
    if (lastActivity === undefined) {
      this.lastActivityAt.set(session, Date.now());
      return;
    }
    if (Date.now() - lastActivity < this.deps.config.eventSilenceMs) return;

    const beats = (this.stillBeats.get(session) ?? 0) + 1;
    this.stillBeats.set(session, beats);
    if (beats >= this.deps.config.stallBeatsThreshold && !this.silentNotified.has(session)) {
      this.silentNotified.add(session);
      this.turnPhases.set(session, 'complete');
      this.reportStall(session, 'silent', {});
    }
  }

  private clearIdleTimer(session: string): void {
    const timer = this.idleTimers.get(session);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.idleTimers.delete(session);
    }
  }

  private async scheduleIdleReport(session: string, kind: 'idle' | 'compaction', info: StallInfo): Promise<void> {
    if (this.deps.config.idleConfirmMs <= 0) {
      await this.confirmIdleReport(session, kind, info);
      return;
    }
    if (this.idleTimers.has(session)) return;
    const timer = setTimeout(() => {
      this.idleTimers.delete(session);
      if (this.turnPhases.get(session) !== 'complete') return;
      void this.confirmIdleReport(session, kind, info);
    }, this.deps.config.idleConfirmMs);
    timer.unref();
    this.idleTimers.set(session, timer);
  }

  private bumpEventSequence(session: string): void {
    this.eventSequences.set(session, (this.eventSequences.get(session) ?? 0) + 1);
  }

  private async confirmCompactionIdle(session: string, info: StallInfo): Promise<void> {
    if (this.turnPhases.get(session) !== 'interrupted') return;
    const pane = this.deps.getPane(session);
    if (pane === undefined) return;
    try {
      const activity = await this.deps.observeActivity(session, pane);
      // Pane observation is asynchronous. A newer runtime event wins if it
      // arrived while the pane was being inspected.
      if (this.turnPhases.get(session) !== 'interrupted') return;
      if (activity === 'idle') {
        this.pendingCompactions.delete(session);
        this.turnPhases.set(session, 'complete');
        await this.confirmIdleReport(session, 'compaction', info);
        return;
      }
      if (activity === 'unknown') return;
      this.pendingCompactions.delete(session);
      this.turnPhases.set(session, 'active');
      this.deps.onWorking(session);
    } catch (err) {
      log().warn(
        'health',
        `${session}: post-compaction activity check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async confirmIdleReport(session: string, kind: 'idle' | 'compaction', info: StallInfo): Promise<void> {
    if (this.turnPhases.get(session) !== 'complete') return;
    const pane = this.deps.getPane(session);
    if (pane === undefined) {
      this.reportStall(session, kind, info);
      return;
    }

    const eventSequence = this.eventSequences.get(session) ?? 0;
    const inputState = await this.deps.observeInputState(session, pane);
    // Composer observation is asynchronous. A newer lifecycle event or
    // Conductor submission always wins over the older idle candidate.
    if ((this.eventSequences.get(session) ?? 0) !== eventSequence || this.turnPhases.get(session) !== 'complete')
      return;
    if (inputState === 'draft') {
      this.deps.logEvent(session, 'idle_suppressed', 'composer contains a draft');
      return;
    }
    // Unknown capture evidence does not invent a draft. This preserves the
    // existing lifecycle-driven idle signal when a pane cannot be inspected.
    this.reportStall(session, kind, info);
  }

  private reportStall(session: string, kind: StallKind, info: StallInfo): void {
    this.deps.onStall(session, kind, { ...info, detectedAt: new Date().toISOString() });
  }
}
