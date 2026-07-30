import type { Store } from '../store/index.js';
import { DEFAULT_MAX_TAG_LENGTH, type RuntimeName } from '../config/schema.js';
import type { Activity, SessionState } from './types.js';
import type { ConductorEventPublisher } from '../events/types.js';
import { InvalidRequestError } from './errors.js';
import { log } from '../logger.js';

/** Settings of the process being launched, recorded as one indivisible set. */
export interface RunSettings {
  runtime: RuntimeName | undefined;
  effort: string | undefined;
  /** As the runtime resolved it. Undefined means the agent CLI was left to choose. */
  model: string | undefined;
}

/**
 * Per-session state registry. Auto/tag/pause and the active run settings persist
 * to SQLite; session and activity fields are runtime-only and recomputed after a
 * conductor restart.
 */
export class SessionStateManager {
  private readonly states = new Map<string, SessionState>();

  constructor(
    private readonly store: Store,
    private readonly defaultAuto: boolean,
    private readonly events?: ConductorEventPublisher,
    private readonly maxTagLength = DEFAULT_MAX_TAG_LENGTH,
  ) {}

  /**
   * @param declaredAuto session-config policy, used when nothing is persisted.
   */
  register(codename: string, isAgentProject: boolean, declaredAuto?: boolean): void {
    const existing = this.states.get(codename);
    if (existing !== undefined) {
      existing.isAgentProject = isAgentProject;
      return;
    }
    const persisted = this.store.getSessionState(codename);
    const persistedTag = persisted?.tag ?? undefined;
    const tag = persistedTag === undefined || [...persistedTag].length <= this.maxTagLength ? persistedTag : undefined;
    this.states.set(codename, {
      // Persisted runtime state wins over the declared policy, which wins over
      // the fleet default. A session that has never been given a policy is the
      // only one that inherits whichever default was in force at boot.
      auto: persisted?.auto ?? declaredAuto ?? this.defaultAuto,
      tag,
      paused: persisted?.paused ?? false,
      runtime: persisted?.activeRuntime ?? undefined,
      effort: persisted?.activeEffort ?? undefined,
      model: persisted?.activeModel ?? undefined,
      launchedAt: persisted?.activeLaunchedAt ?? undefined,
      running: false,
      ready: false,
      activity: 'stopped',
      isAgentProject,
    });
    if (persisted?.auto === undefined && declaredAuto !== undefined) {
      // Materialize the declared policy immediately so it is inspectable and
      // survives independently of the config file that declared it.
      this.persist(codename);
    }
    if (persistedTag !== undefined && tag === undefined) {
      this.persist(codename);
      log().warn(
        'state',
        `${codename}: cleared a persisted ${String([...persistedTag].length)}-character tag that exceeds supervisor.maxTagLength=${String(this.maxTagLength)}`,
      );
    }
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

  tagMaxLength(): number {
    return this.maxTagLength;
  }

  setTag(codename: string, tag: string | undefined): void {
    const state = this.mustGet(codename);
    const length = tag === undefined ? 0 : [...tag].length;
    if (length > this.maxTagLength) {
      throw new InvalidRequestError(
        `Tag for ${codename} is ${String(length)} characters; this fleet allows at most ${String(this.maxTagLength)}. Shorten the tag and try again.`,
      );
    }
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

  /**
   * Persist the settings of the process being launched, together, so restart
   * recovery never sees a torn set. `runtime: undefined` means no process — the
   * whole set is cleared, including the launch stamp, because a stale model on a
   * stopped session would later read as a live fact.
   *
   * The launch stamp is taken here rather than passed in: this call site is the
   * moment of launch by construction, and it is what lets status say how long a
   * process has been running something its config no longer declares.
   */
  setRunSettings(codename: string, settings: RunSettings): void {
    const state = this.mustGet(codename);
    state.runtime = settings.runtime;
    state.effort = settings.effort;
    state.model = settings.model;
    state.launchedAt = settings.runtime === undefined ? undefined : new Date().toISOString();
    this.persist(codename);
  }

  setSession(codename: string, paneId: string | undefined): void {
    const state = this.mustGet(codename);
    state.paneId = paneId;
    state.running = paneId !== undefined;
    // A fresh run starts NOT ready — a hook, foreground process, or visible
    // runtime chrome must prove launch completion. A cleared session is
    // trivially not ready.
    state.ready = false;
  }

  /** The runtime was observed up through a hook, process, chrome, or adopted live pane. */
  setReady(codename: string): void {
    const state = this.states.get(codename);
    if (state?.running !== true || state.ready) return;
    state.ready = true;
    this.events?.emit({ type: 'session.ready', session: codename });
  }

  isReady(codename: string): boolean {
    return this.states.get(codename)?.ready === true;
  }

  setActivity(codename: string, activity: Activity): void {
    const state = this.mustGet(codename);
    const previous = state.activity;
    if (previous === activity) return;
    state.activity = activity;
    this.persist(codename);
    this.events?.emit({ type: 'session.activity.changed', session: codename, previous, activity });
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
      activeModel: state.model ?? null,
      activeLaunchedAt: state.launchedAt ?? null,
      activity: state.activity,
    });
  }
}
