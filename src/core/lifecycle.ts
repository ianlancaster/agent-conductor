import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { log } from '../logger.js';
import type { AgentConfig } from '../config/schema.js';
import type { AgentRuntime, IdentityEndpoints } from '../runtimes/types.js';
import type { Store } from '../store/index.js';
import type { TerminalBackend } from '../terminals/types.js';
import type { AgentStateManager } from './state.js';
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
  /** Create the agent's directory as a git worktree of this repository. */
  worktreeRepo?: string;
  /** Branch for the worktree (default: the codename). */
  branch?: string;
}

export interface LifecycleDeps {
  store: Store;
  backend: TerminalBackend;
  states: AgentStateManager;
  runtimes: Map<string, AgentRuntime>;
  agents(): Map<string, AgentConfig>;
  identityFor(codename: string): IdentityEndpoints;
  config: {
    defaultPlacement: Placement;
    markerFile: string;
    spawnDirPattern: string;
  };
  baseDir: string;
  agentConfigDir: string;
  /** Re-read agent configs immediately (after spawn/teardown writes). */
  reloadAgents(): void;
  /** Reset health tracking for an agent (on start/restart). */
  healthReset(agent: string): void;
  /** Post-start hook (pending notification delivery). */
  onStarted(agent: string): Promise<void>;
}

/** Agent session lifecycle: start / continue / stop / restart / spawn / teardown. */
export class Lifecycle {
  private readonly panes = new Map<string, PaneRef>();
  private readonly sessions = new Map<string, string>();

  constructor(private readonly deps: LifecycleDeps) {}

  getPane(agent: string): PaneRef | undefined {
    return this.panes.get(agent);
  }

  /** Adopt a surviving pane after a conductor restart. */
  adopt(codename: string, pane: PaneRef): void {
    this.panes.set(codename, pane);
    if (this.deps.states.has(codename)) {
      this.deps.states.setSession(codename, pane.id);
      this.deps.states.setActivity(codename, 'working');
      log().info('lifecycle', `${codename}: adopted surviving pane ${pane.id}`);
    }
  }

  async start(codename: string, opts: StartOptions = {}): Promise<string> {
    const agent = this.deps.agents().get(codename);
    if (agent === undefined) return `Unknown agent: ${codename}`;

    const existingPane = this.panes.get(codename);
    if (this.deps.states.get(codename)?.sessionActive === true && existingPane !== undefined) {
      if (await this.safeIsAlive(existingPane)) {
        return `${codename} is already running.`;
      }
      log().warn('lifecycle', `${codename}: state said active but pane is dead — restarting`);
      this.clearSession(codename);
    }

    const runtime = this.deps.runtimes.get(agent.runtime);
    if (runtime === undefined) return `No runtime registered for '${agent.runtime}'.`;

    const identity = this.deps.identityFor(codename);
    await runtime.prepare(agent, identity);

    this.deps.states.register(codename, this.isAgentProject(agent));

    const placement = opts.placement ?? this.deps.config.defaultPlacement;
    const pane = await this.deps.backend.createPane(codename, placement, agent.repo);
    this.panes.set(codename, pane);
    await this.deps.backend.rename(pane, codename);

    const command = runtime.buildLaunchCommand(agent, identity, {
      prompt: opts.prompt,
      continueSession: opts.continueSession ?? false,
    });
    await this.deps.backend.launch(pane, command);

    const sessionId = randomUUID();
    this.sessions.set(codename, sessionId);
    this.deps.store.insertSession(
      sessionId,
      codename,
      opts.prompt !== undefined ? truncate(opts.prompt, 200) : undefined,
    );

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
    if (!this.deps.states.has(codename)) return `Unknown agent: ${codename}`;
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
    if (this.deps.states.get(codename)?.sessionActive !== true) return;
    this.clearSession(codename);
    log().info('lifecycle', `${codename}: session ended`);
  }

  async spawn(codename: string, opts: SpawnOptions = {}): Promise<string> {
    if (this.deps.agents().has(codename)) return `Agent '${codename}' already exists.`;

    const rawDir = opts.path ?? this.deps.config.spawnDirPattern.replace('{codename}', codename);
    const dir = isAbsolute(rawDir) ? rawDir : resolve(this.deps.baseDir, rawDir);
    if (opts.worktreeRepo !== undefined) {
      const repo = isAbsolute(opts.worktreeRepo) ? opts.worktreeRepo : resolve(this.deps.baseDir, opts.worktreeRepo);
      await addWorktree(repo, dir, opts.branch ?? codename);
    } else {
      mkdirSync(dir, { recursive: true });
    }

    const configLines = [`codename: ${codename}`, `repo: ${dir}`];
    if (opts.model !== undefined) configLines.push(`model: ${opts.model}`);
    mkdirSync(this.deps.agentConfigDir, { recursive: true });
    writeFileSync(join(this.deps.agentConfigDir, `${codename}.yaml`), `${configLines.join('\n')}\n`);

    this.deps.reloadAgents();
    const started = await this.start(codename, { prompt: opts.prompt, placement: opts.placement });
    return `Spawned ${codename} at ${dir}. ${started}`;
  }

  async teardown(codename: string, deleteDir = false): Promise<string> {
    const agent = this.deps.agents().get(codename);
    if (agent === undefined) return `Unknown agent: ${codename}`;

    if (this.deps.states.get(codename)?.sessionActive === true) {
      await this.stop(codename);
    }

    const configFile = join(this.deps.agentConfigDir, `${codename}.yaml`);
    if (existsSync(configFile)) unlinkSync(configFile);

    let dirNote = '';
    if (deleteDir) {
      if (isWorktree(agent.repo)) {
        try {
          await removeWorktree(agent.repo);
          dirNote = ' Worktree removed.';
        } catch (err) {
          dirNote = ` Worktree NOT removed: ${err instanceof Error ? err.message : String(err)} (commit or stash changes, or remove it manually).`;
        }
      } else if (existsSync(join(agent.repo, '.git'))) {
        dirNote = ` Directory kept: ${agent.repo} contains a git repository.`;
      } else if (existsSync(join(agent.repo, this.deps.config.markerFile))) {
        dirNote = ` Directory kept: ${agent.repo} is marked as an agent project.`;
      } else {
        rmSync(agent.repo, { recursive: true, force: true });
        dirNote = ` Directory deleted.`;
      }
    }

    this.deps.states.deregister(codename);
    this.deps.reloadAgents();
    log().info('lifecycle', `${codename}: torn down`);
    return `${codename} deregistered.${dirNote}`;
  }

  isAgentProject(agent: AgentConfig): boolean {
    return existsSync(join(agent.repo, this.deps.config.markerFile));
  }

  private clearSession(codename: string): void {
    const sessionId = this.sessions.get(codename);
    if (sessionId !== undefined) {
      this.deps.store.completeSession(sessionId);
      this.sessions.delete(codename);
    }
    this.panes.delete(codename);
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
