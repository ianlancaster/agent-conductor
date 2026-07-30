import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { log } from '../logger.js';
import { isValidCodename, type SessionConfig, type SpawnTemplate } from '../config/schema.js';
import type { SessionRuntime, IdentityEndpoints, LaunchOptions } from '../runtimes/types.js';
import type { Store } from '../store/index.js';
import type { TerminalBackend } from '../terminals/types.js';
import type { RunSettings, SessionStateManager } from './state.js';
import { truncate } from './utils.js';
import type { PaneActivityEvidence, PaneRef, Placement } from './types.js';
import { materializeWorkspace, type WorkspaceSource } from './workspace.js';
import { isWorktree, removeWorktree } from './worktree.js';
import type { ConductorEventPublisher } from '../events/types.js';

/** Mutating lifecycle transitions, which are serialized per session. */
export type LifecycleOperationKind = 'start' | 'continue' | 'stop' | 'restart' | 'teardown';

/**
 * The transition currently holding a session's turnstile. Advisory only: it
 * exists so a second supervisor can SEE that a seat is already being recovered
 * instead of discovering it by colliding. Two supervisors recovering one seat is
 * the normal consequence of running auto-routing beside a scheduled backup.
 */
export interface LifecycleOperation {
  kind: LifecycleOperationKind;
  /** Who asked: a session codename, `operator`, or another mechanical caller. */
  initiator?: string;
  /** ISO-8601 instant the transition took the turnstile. */
  since: string;
}

/** Attribution for a mutating transition, recorded while it holds the turnstile. */
export interface LifecycleActionOptions {
  initiator?: string;
}

export interface StartOptions extends LifecycleActionOptions {
  prompt?: string;
  placement?: Placement;
  continueSession?: boolean;
  /** Override the session's configured default for this run only. */
  runtime?: SessionConfig['runtime'];
  /** Override the resolved reasoning effort for this run only. */
  effort?: string;
  /** Create the pane in the detached fleet session (tmux only) — see CreatePaneOptions.headless. */
  headless?: boolean;
}

export interface ProcessObservation {
  /** Foreground agent runtime truth; null means terminal-backend inspection failed. */
  active: boolean | null;
  /** ISO timestamp for the most recent process-state determination. */
  observedAt: string;
}

export interface SpawnOptions extends LifecycleActionOptions {
  path?: string;
  model?: string;
  /** Persisted per-session effort default for the new session. */
  effort?: string;
  /** Persisted runtime access grants for paths outside the new workspace. */
  additionalDirs?: string[];
  /** Persisted role/policy instructions appended after the Conductor protocol. */
  systemPromptFile?: string;
  prompt?: string;
  placement?: Placement;
  /** Runtime for the new session (default: the supervisor's configured runtime). */
  runtime?: string;
  /** Per-session override of the fleet's approval/sandbox bypass default. */
  bypassPermissions?: boolean;
  /** Create the session's directory as a git worktree of this repository. */
  worktreeRepo?: string;
  /** Materialize the session directory from a registered Git template. */
  template?: string;
  /** Branch for the worktree (default: the codename). */
  branch?: string;
  /** Create the pane in the detached fleet session (tmux only). */
  headless?: boolean;
  /**
   * Register as a short-lived worker rather than a standing fleet member
   * (default: true). Standing membership is what fleet watch measures.
   */
  ephemeral?: boolean;
  /**
   * Declared stall-routing policy for the new session, written into its config.
   * Omitted leaves the session on the fleet default in force when Conductor
   * started — which is not the same as the value currently in supervisor.yaml.
   */
  auto?: boolean;
}

export interface LifecycleDeps {
  store: Store;
  backend: TerminalBackend;
  states: SessionStateManager;
  runtimes: Map<string, SessionRuntime>;
  sessions(): Map<string, SessionConfig>;
  identityFor(codename: string): IdentityEndpoints;
  config: {
    defaultPlacement: Placement;
    defaultRuntime: SessionConfig['runtime'];
    // No defaultModels: model precedence belongs to the runtime that passes the
    // flag (SessionRuntime.resolveLaunchModel). A second copy here is what let
    // an adopted process be reported with a model it was never launched with.
    defaultEfforts: Record<string, string | undefined>;
    defaultBypassPermissions: boolean;
    markerFile: string;
    spawnDirPattern: string;
    spawnTemplates: Record<string, SpawnTemplate>;
    templateCloneTimeoutMs: number;
  };
  baseDir: string;
  sessionConfigDir: string;
  /** Re-read session configs immediately (after spawn/teardown writes). */
  reloadSessions(teardownSession?: string): void;
  /**
   * Pick up session-file edits made since the last poll. A launch reads the
   * in-memory roster, so an operator who edits YAML and immediately restarts
   * would otherwise relaunch with the previous configuration and see the edit
   * silently ignored.
   */
  refreshSessions?(): void;
  /** Reset per-run health and stall-routing tracking on lifecycle boundaries. */
  supervisionReset(session: string): void;
  /** Resolve working/idle from runtime-owned execution evidence at recovery boundaries. */
  observeActivity?(session: string, pane: PaneRef): Promise<PaneActivityEvidence>;
  /** Reconcile live activity after terminal-process liveness is confirmed. */
  reconcileActivity?(session: string, pane: PaneRef): Promise<void>;
  /** Notify orchestration that a live pane is available for this run's queued delivery. */
  onRunning?(session: string): void;
  events?: ConductorEventPublisher;
}

/**
 * No process, so no launch facts. Cleared as a set: a leftover model or launch
 * stamp on a stopped session would be read later as a description of something
 * running.
 */
const CLEARED_RUN_SETTINGS: RunSettings = { runtime: undefined, effort: undefined, model: undefined };

/** Session lifecycle: start / continue / stop / restart / spawn / teardown. */
export class Lifecycle {
  private readonly panes = new Map<string, PaneRef>();
  private readonly sessions = new Map<string, string>();
  /** In-flight start per codename — concurrent starts share one result so we never open two panes for one session. */
  private readonly starting = new Map<string, Promise<string>>();
  /** Tail of each session's serialized transition chain — the turnstile. */
  private readonly turnstiles = new Map<string, Promise<unknown>>();
  private readonly operations = new Map<string, LifecycleOperation>();
  private readonly processObservations = new Map<string, ProcessObservation>();

  constructor(private readonly deps: LifecycleDeps) {}

  getPane(session: string): PaneRef | undefined {
    return this.panes.get(session);
  }

  /** The transition currently holding this session's turnstile, if any. */
  operationInFlight(session: string): LifecycleOperation | undefined {
    return this.operations.get(session);
  }

  /**
   * Run one mutating transition with exclusive ownership of a session.
   *
   * Serializing start alone is not enough: two supervisors recovering the same
   * dead seat interleave stop→start with stop→start, so one caller's stop can
   * kill the pane the other caller's start just opened, and a message can be
   * dispatched against a process already being torn down. Every transition
   * queues here, and a failed transition never blocks the next one.
   */
  private serialize<T>(
    session: string,
    kind: LifecycleOperationKind,
    initiator: string | undefined,
    action: () => Promise<T>,
  ): Promise<T> {
    const previous = this.turnstiles.get(session) ?? Promise.resolve();
    const result = previous.then(async () => {
      const operation: LifecycleOperation = {
        kind,
        ...(initiator === undefined ? {} : { initiator }),
        since: new Date().toISOString(),
      };
      this.operations.set(session, operation);
      try {
        return await action();
      } finally {
        if (this.operations.get(session) === operation) this.operations.delete(session);
      }
    });
    // The chain must survive a rejected transition, and it must not retain a
    // completed one: an unpruned tail would keep every session's last promise
    // alive for the process lifetime.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    const pruned = tail.then(() => {
      if (this.turnstiles.get(session) === pruned) this.turnstiles.delete(session);
    });
    this.turnstiles.set(session, pruned);
    return result;
  }

  processObservation(session: string): ProcessObservation | undefined {
    return this.processObservations.get(session);
  }

  /** Runtime supervising the current run, falling back to the session's configured default. */
  runtimeNameFor(codename: string): SessionConfig['runtime'] | undefined {
    return this.deps.states.get(codename)?.runtime ?? this.deps.sessions().get(codename)?.runtime;
  }

  templateNames(): string[] {
    return Object.keys(this.deps.config.spawnTemplates).sort();
  }

  /** Adopt a surviving pane after a conductor restart. */
  async adopt(codename: string, pane: PaneRef): Promise<void> {
    this.panes.set(codename, pane);
    if (this.deps.states.has(codename)) {
      const configuredRuntime = this.deps.sessions().get(codename)?.runtime;
      if (this.deps.states.get(codename)?.runtime === undefined && configuredRuntime !== undefined) {
        this.deps.states.setRuntime(codename, configuredRuntime);
      }
      this.deps.states.setSession(codename, pane.id);
      this.emitStarted(codename, 'adopt');
      // A surviving pane's runtime was already up before we restarted.
      this.deps.states.setReady(codename);
      this.deps.states.setActivity(codename, await this.recoveredActivity(codename, pane));
      this.deps.supervisionReset(codename);
      this.deps.onRunning?.(codename);
      log().info('lifecycle', `${codename}: adopted surviving pane ${pane.id}`);
    }
  }

  /**
   * Reconcile conductor state with both layers of terminal liveness: the pane
   * may still exist after its Claude/Codex process has returned to the shell.
   * Idle panes stay mapped so a later start/continue can reuse them.
   */
  async reconcile(codename?: string): Promise<void> {
    const targets = codename === undefined ? [...this.panes.keys()] : [codename];
    for (const target of targets) {
      // A transition owns this session's pane and state right now. Reconciling
      // against a pane that is mid-kill or mid-launch reads a torn frame and
      // then writes that stale conclusion over the transition's own result.
      if (this.operations.has(target)) continue;
      const pane = this.panes.get(target);
      if (pane === undefined || !this.deps.states.has(target)) continue;

      const paneAlive = await this.safePaneAlive(pane);
      if (paneAlive === false) {
        this.observeProcess(target, false);
        if (this.deps.states.get(target)?.running === true) {
          log().info('lifecycle', `${target}: pane ${pane.id} ended — marking stopped`);
        }
        this.clearSession(target, 'pane-missing');
        continue;
      }
      if (paneAlive === undefined) {
        this.observeProcess(target, null);
        continue;
      }

      const sessionActive = await this.safeSessionActive(pane);
      this.observeProcess(target, sessionActive ?? null);
      if (sessionActive === false) {
        if (this.deps.states.get(target)?.running === true) {
          log().info('lifecycle', `${target}: runtime exited in pane ${pane.id} — keeping pane for restart`);
          this.clearSession(target, 'runtime-exit', true);
        }
      } else if (sessionActive === true) {
        if (this.deps.states.get(target)?.running !== true) {
          await this.markRunning(target, pane);
          log().info('lifecycle', `${target}: found active runtime in pane ${pane.id}`);
        }
        await this.deps.reconcileActivity?.(target, pane);
      }
    }
  }

  start(codename: string, opts: StartOptions = {}): Promise<string> {
    // Coalesce starts for one codename: a cron fire racing an operator /start
    // (or an auto-start via sendToSession) must not both pass the liveness check
    // and open two panes for a single identity. Every other transition waits at
    // the turnstile instead of interleaving with this one.
    const inFlight = this.starting.get(codename);
    if (inFlight !== undefined) return inFlight;
    const promise = this.serialize(codename, opts.continueSession === true ? 'continue' : 'start', opts.initiator, () =>
      this.startInner(codename, opts),
    ).finally(() => {
      this.starting.delete(codename);
    });
    this.starting.set(codename, promise);
    return promise;
  }

  private async startInner(codename: string, opts: StartOptions): Promise<string> {
    // Config edits take effect on the next launch, not on the next poll.
    this.deps.refreshSessions?.();
    const session = this.deps.sessions().get(codename);
    if (session === undefined) return `Unknown session: ${codename}`;

    let existingPane = await this.findPane(codename);
    if (existingPane !== undefined) {
      const paneAlive = await this.safePaneAlive(existingPane);
      if (paneAlive === false) {
        log().warn('lifecycle', `${codename}: remembered pane is dead — creating a replacement`);
        this.clearSession(codename, 'pane-missing');
        existingPane = undefined;
      } else if (paneAlive === true) {
        const sessionActive = await this.safeSessionActive(existingPane);
        if (sessionActive === undefined) {
          // Launching a second runtime into a pane that might still host one is
          // worse than reporting that the process inspection was inconclusive.
          return `${codename} has a pane, but its runtime status could not be determined.`;
        }
        if (sessionActive) {
          if (this.deps.states.get(codename)?.running !== true) await this.markRunning(codename, existingPane);
          return `${codename} is already running.`;
        }
        // Ctrl-C ended the runtime, not the pane. Close out the old run but
        // retain the pane mapping and launch the replacement into that shell.
        this.clearSession(codename, 'runtime-exit', true);
      } else {
        return `${codename} has a pane, but its liveness could not be determined.`;
      }
    }

    const runtimeName = opts.runtime ?? session.runtime;
    const runtime = this.deps.runtimes.get(runtimeName);
    if (runtime === undefined) return `No runtime registered for '${runtimeName}'.`;

    // Model and effort pins for the configured runtime are not portable across
    // agent CLIs. An override uses the selected runtime's own defaults unless
    // the caller explicitly supplies a per-run effort.
    const launchSession: SessionConfig =
      runtimeName === session.runtime
        ? session
        : { ...session, runtime: runtimeName, model: undefined, effort: undefined };
    const effort = opts.effort ?? launchSession.effort ?? this.deps.config.defaultEfforts[runtimeName];

    const identity = this.deps.identityFor(codename);

    if (opts.headless === true && !this.deps.backend.capabilities.headless) {
      return `Headless sessions need a headless-capable backend (tmux) — the ${this.deps.backend.name} backend cannot detach panes.`;
    }

    await runtime.prepare(launchSession, identity);
    this.deps.states.register(codename, this.isAgentProject(session), session.auto);

    const placement = opts.placement ?? this.deps.config.defaultPlacement;
    const createdPane = existingPane === undefined;
    const pane =
      existingPane ??
      (await this.deps.backend.createPane(codename, placement, session.repo, {
        headless: opts.headless === true,
      }));
    this.panes.set(codename, pane);

    try {
      const launchOptions: LaunchOptions = {
        prompt: opts.prompt,
        continueSession: opts.continueSession ?? false,
        effort,
        bypassPermissions: launchSession.bypassPermissions ?? this.deps.config.defaultBypassPermissions,
      };
      // Record what this launch pins BEFORE the command runs, and take the value
      // from the runtime that builds the command rather than re-deriving it here.
      // A config edited after launch must never be able to overwrite this.
      this.deps.states.setRunSettings(codename, {
        runtime: runtimeName,
        effort,
        model: runtime.resolveLaunchModel(launchSession, launchOptions),
      });
      const command = runtime.buildLaunchCommand(launchSession, identity, launchOptions);
      // Title the pane from INSIDE the launch command (cc-conductor pattern):
      // the shell's own preexec title escape fires first, then this prefix,
      // then the runtime (titles disabled) — last writer wins, no race.
      const tag = this.deps.states.getTag(codename);
      const displayName = tag !== undefined && tag.length > 0 ? `${codename} — ${tag}` : codename;
      const prefix = this.deps.backend.titleShellPrefix?.(displayName, codename);
      await this.deps.backend.launch(pane, prefix !== undefined ? `${prefix} && ${command}` : command);
      // Backends without a title prefix (tmux) label the pane directly.
      if (prefix === undefined) await this.deps.backend.rename(pane, displayName, codename);
    } catch (err) {
      if (createdPane) {
        // Don't leak a pane we just opened if launch setup fails.
        this.panes.delete(codename);
        try {
          await this.deps.backend.kill(pane);
        } catch {
          // Best effort — the pane may already be gone.
        }
        this.deps.events?.emit({ type: 'session.stopped', session: codename, cause: 'launch-failed' });
      } else {
        // A pre-existing shell is still useful even if this launch failed.
        this.clearSession(codename, 'launch-failed', true);
      }
      if (this.deps.states.has(codename)) this.deps.states.setRunSettings(codename, CLEARED_RUN_SETTINGS);
      throw err;
    }

    const sessionId = randomUUID();
    this.sessions.set(codename, sessionId);
    this.deps.store.insertRun(sessionId, codename, opts.prompt !== undefined ? truncate(opts.prompt, 200) : undefined);

    this.deps.states.setSession(codename, pane.id);
    this.emitStarted(codename, opts.continueSession === true ? 'continue' : 'start');
    this.deps.states.setActivity(codename, 'working');
    this.deps.supervisionReset(codename);
    this.deps.onRunning?.(codename);
    log().info('lifecycle', `${codename}: ${opts.continueSession === true ? 'continued' : 'started'} in ${pane.id}`);
    return `${codename} ${opts.continueSession === true ? 'continued' : 'started'}.`;
  }

  continue(codename: string, opts: Omit<StartOptions, 'continueSession'> = {}): Promise<string> {
    return this.start(codename, { ...opts, continueSession: true });
  }

  stop(codename: string, opts: LifecycleActionOptions = {}): Promise<string> {
    return this.serialize(codename, 'stop', opts.initiator, () => this.stopInner(codename));
  }

  /** Stop and restart as ONE transition — nothing may claim the seat in between. */
  restart(codename: string, opts: StartOptions = {}): Promise<string> {
    return this.serialize(codename, 'restart', opts.initiator, async () => {
      await this.stopInner(codename);
      return this.startInner(codename, opts);
    });
  }

  private async stopInner(codename: string): Promise<string> {
    if (!this.deps.states.has(codename)) return `Unknown session: ${codename}`;
    const pane = this.panes.get(codename);
    if (pane !== undefined) {
      try {
        await this.deps.backend.kill(pane);
      } catch (err) {
        log().warn('lifecycle', `${codename}: pane kill failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.clearSession(codename, 'requested');
    log().info('lifecycle', `${codename}: stopped`);
    return `${codename} stopped.`;
  }

  /** Session ended without us stopping it (pane closed, session-end event). */
  handleSessionEnd(codename: string): void {
    if (this.deps.states.get(codename)?.running !== true) return;
    // Runtime SessionEnd/Ctrl-C normally leaves the terminal pane at a shell
    // prompt. Keep it discoverable so start/continue reuse the same pane.
    this.clearSession(codename, 'runtime-exit', true);
    log().info('lifecycle', `${codename}: session ended`);
  }

  async spawn(codename: string, opts: SpawnOptions = {}): Promise<string> {
    // Validate BEFORE any filesystem write: the codename becomes a directory
    // name and a config filename, so an unvalidated value (e.g. '../../x') is a
    // path-traversal write. The schema only checks codenames at load time.
    if (!isValidCodename(codename)) {
      return `Invalid codename '${codename}': must be alphanumeric with dashes/underscores.`;
    }
    if (this.deps.sessions().has(codename)) return `Session '${codename}' already exists.`;
    if (opts.runtime !== undefined && !this.deps.runtimes.has(opts.runtime)) {
      return `Unknown runtime '${opts.runtime}'. Available: ${[...this.deps.runtimes.keys()].sort().join(', ')}.`;
    }
    if (opts.template !== undefined && opts.worktreeRepo !== undefined) {
      return 'Template and worktree sources are mutually exclusive.';
    }
    if (opts.template !== undefined && opts.branch !== undefined) {
      return 'A spawn branch applies only to a worktree source, not a template.';
    }

    const template = opts.template === undefined ? undefined : this.deps.config.spawnTemplates[opts.template];
    if (opts.template !== undefined && template === undefined) {
      const available = this.templateNames();
      return available.length > 0
        ? `Unknown template '${opts.template}'. Available: ${available.join(', ')}.`
        : `Unknown template '${opts.template}'. No spawn templates are configured.`;
    }

    const rawDir = opts.path ?? this.deps.config.spawnDirPattern.replace('{codename}', codename);
    const dir = isAbsolute(rawDir) ? rawDir : resolve(this.deps.baseDir, rawDir);
    let workspaceSource: WorkspaceSource;
    if (opts.worktreeRepo !== undefined) {
      const repo = isAbsolute(opts.worktreeRepo) ? opts.worktreeRepo : resolve(this.deps.baseDir, opts.worktreeRepo);
      workspaceSource = { kind: 'worktree', repo, branch: opts.branch ?? codename };
    } else if (template !== undefined) {
      workspaceSource = {
        kind: 'template',
        template,
        baseDir: this.deps.baseDir,
        timeoutMs: this.deps.config.templateCloneTimeoutMs,
      };
    } else {
      workspaceSource = { kind: 'empty' };
    }
    await materializeWorkspace(dir, workspaceSource);
    this.deps.events?.emit({ type: 'workspace.provisioned', session: codename, kind: workspaceSource.kind });

    // Serialize with js-yaml, never string interpolation: a model/effort value
    // containing a newline would otherwise inject arbitrary YAML keys.
    const config: Record<string, string | boolean | string[]> = {
      codename,
      repo: dir,
      runtime: opts.runtime ?? this.deps.config.defaultRuntime,
      // A session created at runtime is a pod unless the caller says otherwise.
      // Written explicitly so the distinction is visible in the config a human
      // later reads and can flip by hand.
      ephemeral: opts.ephemeral ?? true,
    };
    if (opts.auto !== undefined) config.auto = opts.auto;
    if (opts.model !== undefined) config.model = opts.model;
    if (opts.effort !== undefined) config.effort = opts.effort;
    if (opts.additionalDirs !== undefined) config.additionalDirs = opts.additionalDirs;
    if (opts.systemPromptFile !== undefined) config.systemPromptFile = opts.systemPromptFile;
    if (opts.bypassPermissions !== undefined) config.bypassPermissions = opts.bypassPermissions;
    mkdirSync(this.deps.sessionConfigDir, { recursive: true });
    writeFileSync(join(this.deps.sessionConfigDir, `${codename}.yaml`), yaml.dump(config));

    this.deps.reloadSessions();
    const started = await this.start(codename, {
      prompt: opts.prompt,
      placement: opts.placement,
      headless: opts.headless,
      initiator: opts.initiator,
    });
    return `Spawned ${codename} at ${dir}. ${started}`;
  }

  teardown(codename: string, deleteDir = false, opts: LifecycleActionOptions = {}): Promise<string> {
    return this.serialize(codename, 'teardown', opts.initiator, () => this.teardownInner(codename, deleteDir));
  }

  private async teardownInner(codename: string, deleteDir: boolean): Promise<string> {
    const session = this.deps.sessions().get(codename);
    if (session === undefined) return `Unknown session: ${codename}`;

    // An ended runtime can leave an idle reusable pane behind. Teardown owns
    // the whole session registration, so it must close that pane too. It
    // already holds the turnstile, so it stops the session directly.
    if (this.panes.has(codename)) {
      await this.stopInner(codename);
    }

    let dirNote = '';
    if (deleteDir) {
      if (isWorktree(session.repo)) {
        try {
          const branch = await removeWorktree(session.repo);
          this.deps.events?.emit({ type: 'workspace.removed', session: codename, kind: 'worktree' });
          dirNote =
            branch !== null
              ? ` Worktree removed. Its branch '${branch}' was kept in the main repo — delete it with: git branch -d ${branch}`
              : ' Worktree removed.';
        } catch (err) {
          // Git deliberately refuses dirty worktrees. Keep the session config
          // and registration intact so the operator can clean it and retry —
          // deleting those first would orphan real work outside the conductor.
          return `${codename} stopped but NOT deregistered. Worktree NOT removed: ${err instanceof Error ? err.message : String(err)} (commit or stash changes, then retry).`;
        }
      } else if (existsSync(join(session.repo, '.git'))) {
        dirNote = ` Directory kept: ${session.repo} contains a git repository.`;
      } else if (existsSync(join(session.repo, this.deps.config.markerFile))) {
        dirNote = ` Directory kept: ${session.repo} is marked as an agent project.`;
      } else {
        rmSync(session.repo, { recursive: true, force: true });
        this.deps.events?.emit({ type: 'workspace.removed', session: codename, kind: 'directory' });
        dirNote = ` Directory deleted.`;
      }
    }

    // Session configs may be hand-authored as either extension. Remove both
    // only after guarded directory/worktree deletion has succeeded.
    for (const extension of ['yaml', 'yml']) {
      const configFile = join(this.deps.sessionConfigDir, `${codename}.${extension}`);
      if (existsSync(configFile)) unlinkSync(configFile);
    }

    this.deps.reloadSessions(codename);
    log().info('lifecycle', `${codename}: torn down`);
    return `${codename} deregistered.${dirNote}`;
  }

  isAgentProject(session: SessionConfig): boolean {
    return existsSync(join(session.repo, this.deps.config.markerFile));
  }

  private clearSession(
    codename: string,
    cause: 'requested' | 'runtime-exit' | 'pane-missing' | 'launch-failed',
    keepPane = false,
  ): void {
    // A completed stop/exit transition is authoritative even when the pane is
    // removed before the next process-table reconciliation can inspect it.
    this.observeProcess(codename, false);
    const wasRunning = this.deps.states.get(codename)?.running === true;
    const sessionId = this.sessions.get(codename);
    if (sessionId !== undefined) {
      this.deps.store.completeRun(sessionId);
      this.sessions.delete(codename);
    }
    if (!keepPane) this.panes.delete(codename);
    if (this.deps.states.has(codename)) {
      this.deps.states.setSession(codename, undefined);
      this.deps.states.setRunSettings(codename, CLEARED_RUN_SETTINGS);
      this.deps.states.setActivity(codename, 'stopped');
    }
    if (wasRunning || cause === 'launch-failed') {
      this.deps.events?.emit({ type: 'session.stopped', session: codename, cause });
    }
    // Publish stopped state before reevaluating supervision so fleet watch
    // cannot retain this registration as a working member. Reset also cancels
    // armed idle/stall timers that could otherwise fire after teardown.
    this.deps.supervisionReset(codename);
  }

  private async markRunning(codename: string, pane: PaneRef): Promise<void> {
    const configuredRuntime = this.deps.sessions().get(codename)?.runtime;
    if (this.deps.states.get(codename)?.runtime === undefined && configuredRuntime !== undefined) {
      this.deps.states.setRuntime(codename, configuredRuntime);
    }
    this.deps.states.setSession(codename, pane.id);
    this.emitStarted(codename, 'discovered');
    this.deps.states.setReady(codename);
    this.deps.states.setActivity(codename, await this.recoveredActivity(codename, pane));
    this.deps.supervisionReset(codename);
    this.deps.onRunning?.(codename);
  }

  private async recoveredActivity(codename: string, pane: PaneRef): Promise<'working' | 'idle'> {
    const evidence = await this.deps.observeActivity?.(codename, pane);
    if (evidence === 'idle' || evidence === 'working') return evidence;
    return this.deps.states.get(codename)?.activity === 'idle' ? 'idle' : 'working';
  }

  private emitStarted(codename: string, cause: 'start' | 'continue' | 'adopt' | 'discovered'): void {
    const runtime = this.runtimeNameFor(codename);
    // Every caller has either persisted the selected run settings or backfilled
    // the configured runtime before reaching this choke point.
    if (runtime !== undefined) {
      // Read the recorded launch, never re-derive it from config. `adopt` and
      // `discovered` describe a process this conductor did not start: its config
      // may have been edited since, and resolving it here would report the
      // declaration as though it were the launch — a fabricated fact, and one
      // that fabricates agreement between the config and the running process.
      // Absent means the launch was not recorded, which is reported as nothing
      // at all rather than as a guess.
      const state = this.deps.states.get(codename);
      const launchModel = state?.model;
      const launchEffort = state?.effort;
      this.deps.events?.emit({
        type: 'session.started',
        session: codename,
        cause,
        runtime,
        ...(launchModel === undefined ? {} : { launchModel }),
        ...(launchEffort === undefined ? {} : { launchEffort }),
      });
    }
  }

  /** Rediscover a marked pane if this lifecycle instance has not seen it yet. */
  private async findPane(codename: string): Promise<PaneRef | undefined> {
    const known = this.panes.get(codename);
    if (known !== undefined) return known;
    try {
      const discovered = await this.deps.backend.rediscover();
      for (const [session, pane] of discovered) {
        if (this.deps.sessions().has(session)) this.panes.set(session, pane);
      }
    } catch (err) {
      log().warn('lifecycle', `pane rediscovery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.panes.get(codename);
  }

  private async safePaneAlive(pane: PaneRef): Promise<boolean | undefined> {
    try {
      return await this.deps.backend.isAlive(pane);
    } catch {
      return undefined;
    }
  }

  private async safeSessionActive(pane: PaneRef): Promise<boolean | undefined> {
    try {
      return await this.deps.backend.isSessionActive(pane);
    } catch (err) {
      log().warn(
        'lifecycle',
        `${pane.id}: could not inspect foreground process: ${err instanceof Error ? err.message : String(err)}`,
      );
      return undefined;
    }
  }

  private observeProcess(codename: string, active: boolean | null): void {
    this.processObservations.set(codename, { active, observedAt: new Date().toISOString() });
  }
}
