import type { Store } from '../store/index.js';
import type { Activity, SessionState, Autonomy } from './types.js';

/**
 * Per-session state registry. Autonomy/tag/pause persist to SQLite; session and
 * activity fields are runtime-only and recomputed after a conductor restart.
 */
export class SessionStateManager {
  private readonly states = new Map<string, SessionState>();

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
    const persisted = this.store.getSessionState(codename);
    this.states.set(codename, {
      autonomy: persisted?.autonomy ?? this.defaultAutonomy,
      tag: persisted?.tag ?? undefined,
      pause: persisted?.pause ?? undefined,
      running: false,
      ready: false,
      activity: 'stopped',
      isAgentProject,
    });
  }

  deregister(codename: string): void {
    this.states.delete(codename);
    this.store.deleteSessionState(codename);
  }

  has(codename: string): boolean {
    return this.states.has(codename);
  }

  get(codename: string): SessionState | undefined {
    return this.states.get(codename);
  }

  list(): string[] {
    return [...this.states.keys()];
  }

  activeSessions(): string[] {
    return [...this.states.entries()].filter(([, state]) => state.running).map(([codename]) => codename);
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
    state.running = paneId !== undefined;
    // A fresh run starts NOT ready — the runtime proves liveness via its first
    // lifecycle event. A cleared session is trivially not ready.
    state.ready = false;
  }

  /** The runtime signalled it is up (first lifecycle event / adopted live pane). */
  setReady(codename: string): void {
    const state = this.states.get(codename);
    if (state?.running === true) state.ready = true;
  }

  isReady(codename: string): boolean {
    return this.states.get(codename)?.ready === true;
  }

  setActivity(codename: string, activity: Activity): void {
    const state = this.mustGet(codename);
    state.activity = activity;
    this.persist(codename);
  }

  private mustGet(codename: string): SessionState {
    const state = this.states.get(codename);
    if (state === undefined) throw new Error(`Unknown session: ${codename}`);
    return state;
  }

  private persist(codename: string): void {
    const state = this.states.get(codename);
    if (state === undefined) return;
    this.store.upsertSessionState({
      session: codename,
      autonomy: state.autonomy,
      tag: state.tag ?? null,
      pause: state.pause ?? null,
      activity: state.activity,
    });
  }
}
