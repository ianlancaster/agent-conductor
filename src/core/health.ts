import { log } from '../logger.js';
import type { AgentRuntime } from '../runtimes/types.js';
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
  runtimeFor(agent: string): AgentRuntime | undefined;
  getPane(agent: string): PaneRef | undefined;
  getActiveAgents(): string[];
  onStall(agent: string, kind: StallKind, info: StallInfo): void;
  onSessionEnd(agent: string): void;
  logEvent(agent: string, event: string, detail?: string): void;
}

/**
 * Event-driven health monitor with a pane-diff fallback watchdog.
 *
 * Primary signal: runtime lifecycle events (Claude hooks, Codex notify).
 *  - `stop` starts a quiet timer; if nothing else arrives it becomes an idle stall.
 *  - `notification` = blocked on a decision — immediate stall.
 *  - `compaction` = immediate stall (the sentinel re-orients the agent).
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

  constructor(private readonly deps: HealthDeps) {}

  handleEvent(event: RuntimeEvent): void {
    const { agent } = event;
    this.lastEventAt.set(agent, event.receivedAt);
    this.clearIdleTimer(agent);

    switch (event.type) {
      case 'stop': {
        const info: StallInfo = { transcriptPath: event.transcriptPath };
        if (this.deps.config.idleConfirmMs <= 0) {
          this.deps.onStall(agent, 'idle', info);
          return;
        }
        const timer = setTimeout(() => {
          this.idleTimers.delete(agent);
          this.deps.onStall(agent, 'idle', info);
        }, this.deps.config.idleConfirmMs);
        timer.unref();
        this.idleTimers.set(agent, timer);
        return;
      }
      case 'notification':
        this.deps.onStall(agent, 'blocked', { reason: event.reason, transcriptPath: event.transcriptPath });
        return;
      case 'compaction':
        this.deps.onStall(agent, 'compaction', { transcriptPath: event.transcriptPath });
        return;
      case 'session-end':
        this.deps.logEvent(agent, 'session_end', event.reason);
        this.reset(agent);
        this.deps.onSessionEnd(agent);
        return;
      case 'session-start':
        this.reset(agent);
        this.lastEventAt.set(agent, event.receivedAt);
        return;
    }
  }

  /** One heartbeat of the fallback watchdog. */
  async heartbeat(): Promise<void> {
    for (const agent of this.deps.getActiveAgents()) {
      try {
        await this.checkAgent(agent);
      } catch (err) {
        log().warn('health', `${agent}: heartbeat check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** Clear all per-agent tracking (on start/restart/mode change). */
  reset(agent: string): void {
    this.clearIdleTimer(agent);
    this.lastEventAt.delete(agent);
    this.lastCapture.delete(agent);
    this.stillBeats.delete(agent);
    this.silentNotified.delete(agent);
  }

  stop(): void {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
  }

  private async checkAgent(agent: string): Promise<void> {
    const runtime = this.deps.runtimeFor(agent);
    const hasEvents = runtime?.capabilities.lifecycleEvents === true;
    const lastEvent = this.lastEventAt.get(agent);
    if (hasEvents && lastEvent !== undefined && Date.now() - lastEvent < this.deps.config.eventSilenceMs) {
      return; // events are flowing — no need to scrape
    }

    const pane = this.deps.getPane(agent);
    if (pane === undefined) return;
    if (!(await this.deps.backend.isAlive(pane))) {
      this.deps.logEvent(agent, 'pane_dead');
      this.reset(agent);
      this.deps.onSessionEnd(agent);
      return;
    }

    const capture = await this.deps.backend.capture(pane, this.deps.config.captureLines);
    if (capture === this.lastCapture.get(agent)) {
      const beats = (this.stillBeats.get(agent) ?? 0) + 1;
      this.stillBeats.set(agent, beats);
      if (beats >= this.deps.config.stallBeatsThreshold && !this.silentNotified.has(agent)) {
        this.silentNotified.add(agent);
        this.deps.onStall(agent, 'silent', {});
      }
    } else {
      this.lastCapture.set(agent, capture);
      this.stillBeats.set(agent, 0);
      this.silentNotified.delete(agent);
    }
  }

  private clearIdleTimer(agent: string): void {
    const timer = this.idleTimers.get(agent);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.idleTimers.delete(agent);
    }
  }
}
