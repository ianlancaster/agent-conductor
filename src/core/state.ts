import type { Store } from '../store/index.js';
import type { Activity, AgentState, Autonomy } from './types.js';

/**
 * Per-agent state registry. Autonomy/tag/pause persist to SQLite; session and
 * activity fields are runtime-only and recomputed after a conductor restart.
 */
export class AgentStateManager {
  private readonly states = new Map<string, AgentState>();

  constructor(
    private readonly store: Store,
    private readonly defaultAutonomy: Autonomy,
  ) {}

  register(codename: string, isAgentProject: boolean): void {
    const existing = this.states.get(codename);
    if (existing !== undefined) {
      existing.isAgentProject = isAgentProject;
      return;
    }
    const persisted = this.store.getAgentState(codename);
    this.states.set(codename, {
      autonomy: persisted?.autonomy ?? this.defaultAutonomy,
      tag: persisted?.tag ?? undefined,
      pause: persisted?.pause ?? undefined,
      sessionActive: false,
      activity: 'stopped',
      isAgentProject,
    });
  }

  deregister(codename: string): void {
    this.states.delete(codename);
    this.store.deleteAgentState(codename);
  }

  has(codename: string): boolean {
    return this.states.has(codename);
  }

  get(codename: string): AgentState | undefined {
    return this.states.get(codename);
  }

  list(): string[] {
    return [...this.states.keys()];
  }

  activeAgents(): string[] {
    return [...this.states.entries()].filter(([, state]) => state.sessionActive).map(([codename]) => codename);
  }

  getAutonomy(codename: string): Autonomy {
    return this.states.get(codename)?.autonomy ?? this.defaultAutonomy;
  }

  setAutonomy(codename: string, autonomy: Autonomy): void {
    const state = this.mustGet(codename);
    state.autonomy = autonomy;
    state.pause = undefined; // an explicit mode change clears any pause
    this.persist(codename);
  }

  getTag(codename: string): string | undefined {
    return this.states.get(codename)?.tag;
  }

  setTag(codename: string, tag: string | undefined): void {
    const state = this.mustGet(codename);
    state.tag = tag;
    this.persist(codename);
  }

  /** Temporarily force facilitated, remembering the previous mode. */
  pause(codename: string, pausedBy: 'manual' | 'auto-focus'): boolean {
    const state = this.mustGet(codename);
    if (state.pause !== undefined || state.autonomy === 'facilitated') return false;
    state.pause = { previousAutonomy: state.autonomy, pausedBy };
    state.autonomy = 'facilitated';
    this.persist(codename);
    return true;
  }

  resume(codename: string): boolean {
    const state = this.mustGet(codename);
    if (state.pause === undefined) return false;
    state.autonomy = state.pause.previousAutonomy;
    state.pause = undefined;
    this.persist(codename);
    return true;
  }

  isPaused(codename: string): boolean {
    return this.states.get(codename)?.pause !== undefined;
  }

  setSession(codename: string, paneId: string | undefined): void {
    const state = this.mustGet(codename);
    state.paneId = paneId;
    state.sessionActive = paneId !== undefined;
  }

  setActivity(codename: string, activity: Activity): void {
    const state = this.mustGet(codename);
    state.activity = activity;
    this.persist(codename);
  }

  private mustGet(codename: string): AgentState {
    const state = this.states.get(codename);
    if (state === undefined) throw new Error(`Unknown agent: ${codename}`);
    return state;
  }

  private persist(codename: string): void {
    const state = this.states.get(codename);
    if (state === undefined) return;
    this.store.upsertAgentState({
      agent: codename,
      autonomy: state.autonomy,
      tag: state.tag ?? null,
      pause: state.pause ?? null,
      activity: state.activity,
    });
  }
}
