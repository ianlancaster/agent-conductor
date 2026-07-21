import type { Store } from '../store/index.js';
import type { RuntimeName } from '../config/schema.js';
import type { Activity, SessionState } from './types.js';

/**
 * Per-session state registry. Auto/tag/pause persist to SQLite; session and
 * activity fields are runtime-only and recomputed after a conductor restart.
 */
export class SessionStateManager {
  private readonly states = new Map<string, SessionState>();

  constructor(
    private readonly store: Store,
    private readonly defaultAuto: boolean,
  ) {}

  register(codename: string, isAgentProject: boolean): void {
    const existing = this.states.get(codename);
    if (existing !== undefined) {
      existing.isAgentProject = isAgentProject;
      return;
    }
    const persisted = this.store.getSessionState(codename);
    this.states.set(codename, {
      auto: persisted?.auto ?? this.defaultAuto,
      tag: persisted?.tag ?? undefined,
      paused: persisted?.paused ?? false,
      runtime: persisted?.activeRuntime ?? undefined,
      effort: persisted?.activeEffort ?? undefined,
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

  isAuto(codename: string): boolean {
    return this.states.get(codename)?.auto ?? this.defaultAuto;
  }

  toggleAuto(codename: string): boolean {
    const state = this.mustGet(codename);
    state.auto = !state.auto;
    this.persist(codename);
    return state.auto;
  }

  getTag(codename: string): string | undefined {
    return this.states.get(codename)?.tag;
  }

  setTag(codename: string, tag: string | undefined): void {
    const state = this.mustGet(codename);
    state.tag = tag;
    this.persist(codename);
  }

  pause(codename: string): boolean {
    const state = this.mustGet(codename);
    if (state.paused) return false;
    state.paused = true;
    this.persist(codename);
    return true;
  }

  resume(codename: string): boolean {
    const state = this.mustGet(codename);
    if (!state.paused) return false;
    state.paused = false;
    this.persist(codename);
    return true;
  }

  isPaused(codename: string): boolean {
    return this.states.get(codename)?.paused === true;
  }

  setRuntime(codename: string, runtime: RuntimeName | undefined): void {
    const state = this.mustGet(codename);
    state.runtime = runtime;
    this.persist(codename);
  }

  /** Persist the active process settings together so restart recovery never sees a torn pair. */
  setRunSettings(codename: string, runtime: RuntimeName | undefined, effort: string | undefined): void {
    const state = this.mustGet(codename);
    state.runtime = runtime;
    state.effort = effort;
    this.persist(codename);
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
      auto: state.auto,
      tag: state.tag ?? null,
      paused: state.paused,
      activeRuntime: state.runtime ?? null,
      activeEffort: state.effort ?? null,
      activity: state.activity,
    });
  }
}
