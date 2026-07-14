import { log } from '../logger.js';
import type { TerminalBackend } from '../terminals/types.js';
import type { AgentStateManager } from './state.js';

export interface FocusAutoPauseDeps {
  backend: TerminalBackend;
  states: AgentStateManager;
  healthReset(agent: string): void;
  config: {
    checkMs: number;
    resumeDelayMs: number;
    startEnabled: boolean;
  };
}

/**
 * Optional iTerm capability: when the operator focuses an autonomous agent's
 * pane, pause it (temporary facilitated) so the sentinel machinery doesn't
 * type into the pane mid-interaction; auto-resume after a cooldown once focus
 * leaves.
 */
export class FocusAutoPause {
  private on: boolean;
  private timer: NodeJS.Timeout | undefined;
  private focused: string | null = null;
  private readonly resumeTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: FocusAutoPauseDeps) {
    this.on = deps.config.startEnabled;
  }

  enabled(): boolean {
    return this.on;
  }

  setEnabled(on: boolean): void {
    this.on = on;
  }

  start(): void {
    if (this.deps.backend.getFocusedAgent === undefined) return;
    this.timer = setInterval(() => {
      void this.check();
    }, this.deps.config.checkMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    for (const timer of this.resumeTimers.values()) clearTimeout(timer);
    this.resumeTimers.clear();
  }

  private async check(): Promise<void> {
    if (!this.on || this.deps.backend.getFocusedAgent === undefined) return;
    let focused: string | null = null;
    try {
      focused = await this.deps.backend.getFocusedAgent();
    } catch {
      return;
    }
    if (focused === this.focused) return;

    const previous = this.focused;
    this.focused = focused;

    if (previous !== null && this.deps.states.get(previous)?.pause?.pausedBy === 'auto-focus') {
      this.scheduleResume(previous);
    }

    if (focused !== null) {
      this.cancelResume(focused);
      const state = this.deps.states.get(focused);
      if (state?.autonomy === 'autonomous' && state.pause === undefined) {
        this.deps.states.pause(focused, 'auto-focus');
        log().info('autopause', `${focused}: paused (pane focused)`);
      }
    }
  }

  private scheduleResume(agent: string): void {
    this.cancelResume(agent);
    const timer = setTimeout(() => {
      this.resumeTimers.delete(agent);
      if (this.deps.states.get(agent)?.pause?.pausedBy === 'auto-focus') {
        this.deps.states.resume(agent);
        this.deps.healthReset(agent);
        log().info('autopause', `${agent}: resumed (focus left)`);
      }
    }, this.deps.config.resumeDelayMs);
    timer.unref();
    this.resumeTimers.set(agent, timer);
  }

  private cancelResume(agent: string): void {
    const timer = this.resumeTimers.get(agent);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.resumeTimers.delete(agent);
    }
  }
}
