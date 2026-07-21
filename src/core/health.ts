import { log } from '../logger.js';
import type { SessionRuntime } from '../runtimes/types.js';
import type { TerminalBackend } from '../terminals/types.js';
import type { PaneRef, RuntimeEvent, StallKind } from './types.js';

export interface StallInfo {
  reason?: string;
  transcriptPath?: string;
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
  onStall(session: string, kind: StallKind, info: StallInfo): void;
  onSessionEnd(session: string): void;
  logEvent(session: string, event: string, detail?: string): void;
}

/**
 * Event-driven health monitor with a pane-diff fallback watchdog.
 *
 * Primary signal: runtime lifecycle events (Claude hooks, Codex notify).
 *  - `stop` starts a quiet timer; if nothing else arrives it becomes an idle stall.
 *  - `notification` = blocked on a decision — immediate stall.
 *  - `compaction` = immediate stall (the sentinel re-orients the session).
 * Fallback: for runtimes without events, or when events have gone silent while
 * the pane is alive (wedged TUI), unchanged pane content across heartbeats
 * raises a `silent` stall.
 */
export class HealthMonitor {
  private readonly lastEventAt = new Map<string, number>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private readonly lastCapture = new Map<string, string>();
  private readonly stillBeats = new Map<string, number>();
  private readonly silentNotified = new Set<string>();
  private heartbeatInFlight = false;

  constructor(private readonly deps: HealthDeps) {}

  handleEvent(event: RuntimeEvent): void {
    const { session } = event;
    this.lastEventAt.set(session, event.receivedAt);
    this.clearIdleTimer(session);

    switch (event.type) {
      case 'stop': {
        const info: StallInfo = { reason: event.reason, transcriptPath: event.transcriptPath };
        if (this.deps.config.idleConfirmMs <= 0) {
          this.deps.onStall(session, 'idle', info);
          return;
        }
        const timer = setTimeout(() => {
          this.idleTimers.delete(session);
          this.deps.onStall(session, 'idle', info);
        }, this.deps.config.idleConfirmMs);
        timer.unref();
        this.idleTimers.set(session, timer);
        return;
      }
      case 'notification':
        this.deps.onStall(session, 'blocked', { reason: event.reason, transcriptPath: event.transcriptPath });
        return;
      case 'compaction':
        this.deps.onStall(session, 'compaction', { transcriptPath: event.transcriptPath });
        return;
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
        this.lastEventAt.set(session, event.receivedAt);
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
    this.lastEventAt.delete(session);
    this.lastCapture.delete(session);
    this.stillBeats.delete(session);
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

    const runtime = this.deps.runtimeFor(session);
    const hasEvents = runtime?.capabilities.lifecycleEvents === true;
    const lastEvent = this.lastEventAt.get(session);
    if (hasEvents && lastEvent !== undefined && Date.now() - lastEvent < this.deps.config.eventSilenceMs) {
      return; // events are flowing — no need to scrape
    }

    const capture = await this.deps.backend.capture(pane, this.deps.config.captureLines);
    if (capture === this.lastCapture.get(session)) {
      const beats = (this.stillBeats.get(session) ?? 0) + 1;
      this.stillBeats.set(session, beats);
      if (beats >= this.deps.config.stallBeatsThreshold && !this.silentNotified.has(session)) {
        this.silentNotified.add(session);
        this.deps.onStall(session, 'silent', {});
      }
    } else {
      this.lastCapture.set(session, capture);
      this.stillBeats.set(session, 0);
      this.silentNotified.delete(session);
    }
  }

  private clearIdleTimer(session: string): void {
    const timer = this.idleTimers.get(session);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.idleTimers.delete(session);
    }
  }
}
