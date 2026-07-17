import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { log } from '../logger.js';
import { isValidCodename, type SessionConfig } from '../config/schema.js';
import type { SessionRuntime, IdentityEndpoints } from '../runtimes/types.js';
import type { Store } from '../store/index.js';
import type { TerminalBackend } from '../terminals/types.js';
import type { SessionStateManager } from './state.js';
import { truncate } from './utils.js';
import type { PaneRef, Placement } from './types.js';
import { addWorktree, isWorktree, removeWorktree } from './worktree.js';

export interface StartOptions {
  prompt?: string;
  placement?: Placement;
  continueSession?: boolean;
}

export interface SpawnOptions {
  path?: string;
  model?: string;
  prompt?: string;
  placement?: Placement;
  /** Create the session's directory as a git worktree of this repository. */
  worktreeRepo?: string;
  /** Branch for the worktree (default: the codename). */
  branch?: string;
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
    markerFile: string;
    spawnDirPattern: string;
  };
  baseDir: string;
  sessionConfigDir: string;
  /** Re-read session configs immediately (after spawn/teardown writes). */
  reloadSessions(): void;
  /** Reset health tracking for a session (on start/restart). */
  healthReset(session: string): void;
  /** Post-start hook (pending notification delivery). */
  onStarted(session: string): Promise<void>;
}

/** Session lifecycle: start / continue / stop / restart / spawn / teardown. */
export class Lifecycle {
  private readonly panes = new Map<string, PaneRef>();
  private readonly sessions = new Map<string, string>();
  /** In-flight start per codename — serializes concurrent starts so we never open two panes for one session. */
  private readonly starting = new Map<string, Promise<string>>();

  constructor(private readonly deps: LifecycleDeps) {}

  getPane(session: string): PaneRef | undefined {
    return this.panes.get(session);
  }

  /** Adopt a surviving pane after a conductor restart. */
  adopt(codename: string, pane: PaneRef): void {
    this.panes.set(codename, pane);
    if (this.deps.states.has(codename)) {
      this.deps.states.setSession(codename, pane.id);
      // A surviving pane's runtime was already up before we restarted.
      this.deps.states.setReady(codename);
      this.deps.states.setActivity(codename, 'working');
      log().info('lifecycle', `${codename}: adopted surviving pane ${pane.id}`);
    }
  }

  start(codename: string, opts: StartOptions = {}): Promise<string> {
    // Serialize starts for one codename: a cron fire racing an operator /start
    // (or an auto-start via sendToSession) must not both pass the liveness check
    // and open two panes for a single identity.
    const inFlight = this.starting.get(codename);
    if (inFlight !== undefined) return inFlight;
    const promise = this.startInner(codename, opts).finally(() => {
      this.starting.delete(codename);
    });
    this.starting.set(codename, promise);
    return promise;
  }

  private async startInner(codename: string, opts: StartOptions): Promise<string> {
    const session = this.deps.sessions().get(codename);
    if (session === undefined) return `Unknown session: ${codename}`;

    const existingPane = this.panes.get(codename);
    if (this.deps.states.get(codename)?.running === true && existingPane !== undefined) {
      if (await this.safeIsAlive(existingPane)) {
        return `${codename} is already running.`;
      }
      log().warn('lifecycle', `${codename}: state said active but pane is dead — restarting`);
      this.clearSession(codename);
    }

    const runtime = this.deps.runtimes.get(session.runtime);
    if (runtime === undefined) return `No runtime registered for '${session.runtime}'.`;

    const identity = this.deps.identityFor(codename);
    await runtime.prepare(session, identity);

    this.deps.states.register(codename, this.isAgentProject(session));

    const placement = opts.placement ?? this.deps.config.defaultPlacement;
    const pane = await this.deps.backend.createPane(codename, placement, session.repo);
    this.panes.set(codename, pane);

    try {
      await this.deps.backend.rename(pane, codename);
      const command = runtime.buildLaunchCommand(session, identity, {
        prompt: opts.prompt,
        continueSession: opts.continueSession ?? false,
      });
      await this.deps.backend.launch(pane, command);
    } catch (err) {
      // Don't leak the pane we just opened if launch setup fails.
      this.panes.delete(codename);
      try {
        await this.deps.backend.kill(pane);
      } catch {
        // Best effort — the pane may already be gone.
      }
      throw err;
    }

    const sessionId = randomUUID();
    this.sessions.set(codename, sessionId);
    this.deps.store.insertRun(sessionId, codename, opts.prompt !== undefined ? truncate(opts.prompt, 200) : undefined);

    this.deps.states.setSession(codename, pane.id);
    this.deps.states.setActivity(codename, 'working');
    this.deps.healthReset(codename);
    await this.deps.onStarted(codename);

    log().info('lifecycle', `${codename}: ${opts.continueSession === true ? 'continued' : 'started'} in ${pane.id}`);
    return `${codename} ${opts.continueSession === true ? 'continued' : 'started'}.`;
  }

  continue(codename: string, opts: Omit<StartOptions, 'continueSession'> = {}): Promise<string> {
    return this.start(codename, { ...opts, continueSession: true });
  }

  async stop(codename: string): Promise<string> {
    if (!this.deps.states.has(codename)) return `Unknown session: ${codename}`;
    const pane = this.panes.get(codename);
    if (pane !== undefined) {
      try {
        await this.deps.backend.kill(pane);
      } catch (err) {
        log().warn('lifecycle', `${codename}: pane kill failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.clearSession(codename);
    log().info('lifecycle', `${codename}: stopped`);
    return `${codename} stopped.`;
  }

  async restart(codename: string, opts: StartOptions = {}): Promise<string> {
    await this.stop(codename);
    return this.start(codename, opts);
  }

  /** Session ended without us stopping it (pane closed, session-end event). */
  handleSessionEnd(codename: string): void {
    if (this.deps.states.get(codename)?.running !== true) return;
    this.clearSession(codename);
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

    const rawDir = opts.path ?? this.deps.config.spawnDirPattern.replace('{codename}', codename);
    const dir = isAbsolute(rawDir) ? rawDir : resolve(this.deps.baseDir, rawDir);
    if (opts.worktreeRepo !== undefined) {
      const repo = isAbsolute(opts.worktreeRepo) ? opts.worktreeRepo : resolve(this.deps.baseDir, opts.worktreeRepo);
      await addWorktree(repo, dir, opts.branch ?? codename);
    } else {
      mkdirSync(dir, { recursive: true });
    }

    // Serialize with js-yaml, never string interpolation: a model/prompt value
    // containing a newline would otherwise inject arbitrary YAML keys.
    const config: Record<string, string> = { codename, repo: dir };
    if (opts.model !== undefined) config.model = opts.model;
    mkdirSync(this.deps.sessionConfigDir, { recursive: true });
    writeFileSync(join(this.deps.sessionConfigDir, `${codename}.yaml`), yaml.dump(config));

    this.deps.reloadSessions();
    const started = await this.start(codename, { prompt: opts.prompt, placement: opts.placement });
    return `Spawned ${codename} at ${dir}. ${started}`;
  }

  async teardown(codename: string, deleteDir = false): Promise<string> {
    const session = this.deps.sessions().get(codename);
    if (session === undefined) return `Unknown session: ${codename}`;

    if (this.deps.states.get(codename)?.running === true) {
      await this.stop(codename);
    }

    const configFile = join(this.deps.sessionConfigDir, `${codename}.yaml`);
    if (existsSync(configFile)) unlinkSync(configFile);

    let dirNote = '';
    if (deleteDir) {
      if (isWorktree(session.repo)) {
        try {
          await removeWorktree(session.repo);
          dirNote = ' Worktree removed.';
        } catch (err) {
          dirNote = ` Worktree NOT removed: ${err instanceof Error ? err.message : String(err)} (commit or stash changes, or remove it manually).`;
        }
      } else if (existsSync(join(session.repo, '.git'))) {
        dirNote = ` Directory kept: ${session.repo} contains a git repository.`;
      } else if (existsSync(join(session.repo, this.deps.config.markerFile))) {
        dirNote = ` Directory kept: ${session.repo} is marked as an agent project.`;
      } else {
        rmSync(session.repo, { recursive: true, force: true });
        dirNote = ` Directory deleted.`;
      }
    }

    this.deps.states.deregister(codename);
    this.deps.reloadSessions();
    log().info('lifecycle', `${codename}: torn down`);
    return `${codename} deregistered.${dirNote}`;
  }

  isAgentProject(session: SessionConfig): boolean {
    return existsSync(join(session.repo, this.deps.config.markerFile));
  }

  private clearSession(codename: string): void {
    const sessionId = this.sessions.get(codename);
    if (sessionId !== undefined) {
      this.deps.store.completeRun(sessionId);
      this.sessions.delete(codename);
    }
    this.panes.delete(codename);
    // Cancel any armed idle/stall timers so they can't fire into a stopped or
    // (after teardown) deregistered session — that would throw inside setTimeout.
    this.deps.healthReset(codename);
    if (this.deps.states.has(codename)) {
      this.deps.states.setSession(codename, undefined);
      this.deps.states.setActivity(codename, 'stopped');
    }
  }

  private async safeIsAlive(pane: PaneRef): Promise<boolean> {
    try {
      return await this.deps.backend.isAlive(pane);
    } catch {
      return false;
    }
  }
}
