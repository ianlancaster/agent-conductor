import { setTimeout as sleep } from 'node:timers/promises';
import type { PaneRef, Placement } from '../../core/types.js';
import type { TerminalBackend, TerminalCapabilities } from '../types.js';
import type { Store } from '../../store/index.js';
import { log } from '../../logger.js';
import {
  AGENT_OPTION,
  buildCreatePaneArgs,
  buildDeliveryCommands,
  hasShellPrompt,
  parseAgentPanes,
  parsePaneIds,
  tmux,
  tmuxSucceeds,
  trimToTrailingLines,
} from './tmux.js';

/** Store key under which codename -> pane id mappings are persisted. */
const WORKSPACE_KEY = 'tmux.panes';

const LAUNCH_TIMEOUT_MS = 8_000;
const LAUNCH_POLL_MS = 250;

export interface TmuxBackendConfig {
  sessionName: string;
  windowName: string;
}

export interface TmuxBackendOptions {
  store: Store;
  config: TmuxBackendConfig;
}

/**
 * tmux implementation of TerminalBackend.
 *
 * All panes live in a single detached tmux session (config.sessionName).
 * Placement notes: tmux has no separate OS windows, so both 'tab' and
 * 'window' placements create a new tmux window; 'pane' splits the session's
 * first window. Focus tracking is not supported (headless backend), so
 * getFocusedAgent/focusWindow are intentionally not implemented.
 */
export class TmuxBackend implements TerminalBackend {
  readonly name = 'tmux';
  readonly capabilities: TerminalCapabilities = { focusTracking: false, headless: true };

  private readonly store: Store;
  private readonly sessionName: string;
  private readonly windowName: string;

  constructor(opts: TmuxBackendOptions) {
    this.store = opts.store;
    this.sessionName = opts.config.sessionName;
    this.windowName = opts.config.windowName;
  }

  /** Create the detached session if it does not already exist. */
  async init(): Promise<void> {
    // `=name` forces an EXACT session match. Without it, tmux prefix-matches, so
    // `has-session -t conductor` would find a user's `conductor-dev` session and
    // we'd inject agent panes into it.
    const exists = await tmuxSucceeds(['has-session', '-t', `=${this.sessionName}`]);
    if (exists) {
      log().debug('tmux', `session '${this.sessionName}' already exists`);
      return;
    }
    await tmux(['new-session', '-d', '-s', this.sessionName, '-n', this.windowName]);
    log().info('tmux', `created detached session '${this.sessionName}'`);
  }

  async createPane(agent: string, placement: Placement, cwd?: string): Promise<PaneRef> {
    const args = buildCreatePaneArgs({ placement, sessionName: this.sessionName, agent, cwd });
    const paneId = (await tmux(args)).trim();
    if (!paneId.startsWith('%')) {
      throw new Error(`tmux returned an unexpected pane id for agent '${agent}': '${paneId}'`);
    }
    // Pane-scoped identity marker so rediscover() can map panes back to agents.
    await tmux(['set-option', '-p', '-t', paneId, AGENT_OPTION, agent]);
    const map = this.readPaneMap();
    map[agent] = paneId;
    this.writePaneMap(map);
    log().info('tmux', `created pane ${paneId} for '${agent}' (placement=${placement})`);
    return { backend: this.name, id: paneId };
  }

  /** Wait for the fresh pane's shell prompt, then deliver the first command. */
  async launch(pane: PaneRef, command: string): Promise<void> {
    this.assertRef(pane);
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    for (;;) {
      const capture = await tmux(['capture-pane', '-p', '-t', pane.id]);
      if (hasShellPrompt(capture)) break;
      if (Date.now() >= deadline) {
        log().warn('tmux', `no shell prompt in pane ${pane.id} after ${LAUNCH_TIMEOUT_MS}ms; delivering anyway`);
        break;
      }
      await sleep(LAUNCH_POLL_MS);
    }
    await this.run(pane, command);
  }

  /** Deliver text + Enter. Multiline text goes through bracketed paste. */
  async run(pane: PaneRef, text: string): Promise<void> {
    this.assertRef(pane);
    for (const args of buildDeliveryCommands(pane.id, text)) {
      await tmux(args);
    }
  }

  async capture(pane: PaneRef, lines: number): Promise<string> {
    this.assertRef(pane);
    const output = await tmux(['capture-pane', '-p', '-t', pane.id, '-S', `-${lines}`]);
    return trimToTrailingLines(output, lines);
  }

  async isAlive(pane: PaneRef): Promise<boolean> {
    this.assertRef(pane);
    try {
      const output = await tmux(['list-panes', '-a', '-F', '#{pane_id}']);
      return parsePaneIds(output).includes(pane.id);
    } catch {
      // tmux server not running -> no pane is alive.
      return false;
    }
  }

  async kill(pane: PaneRef): Promise<void> {
    this.assertRef(pane);
    await tmux(['kill-pane', '-t', pane.id]);
    const map = this.readPaneMap();
    const remaining = Object.fromEntries(Object.entries(map).filter(([, id]) => id !== pane.id));
    if (Object.keys(remaining).length !== Object.keys(map).length) {
      this.writePaneMap(remaining);
    }
  }

  /** Sets the tmux pane title (visible in the pane border / status formats). */
  async rename(pane: PaneRef, name: string): Promise<void> {
    this.assertRef(pane);
    await tmux(['select-pane', '-t', pane.id, '-T', name]);
  }

  /** Find surviving marked panes after a conductor restart; refresh the store. */
  async rediscover(): Promise<Map<string, PaneRef>> {
    const result = new Map<string, PaneRef>();
    let output: string;
    try {
      output = await tmux(['list-panes', '-a', '-F', `#{pane_id} #{${AGENT_OPTION}}`]);
    } catch (error) {
      // No tmux server -> no surviving panes.
      log().warn('tmux', `rediscover found no tmux server: ${String(error)}`);
      this.writePaneMap({});
      return result;
    }
    const paneMap: Record<string, string> = {};
    for (const [agent, paneId] of parseAgentPanes(output)) {
      result.set(agent, { backend: this.name, id: paneId });
      paneMap[agent] = paneId;
    }
    this.writePaneMap(paneMap);
    log().info('tmux', `rediscovered ${result.size} agent pane(s)`);
    return result;
  }

  private assertRef(pane: PaneRef): void {
    if (pane.backend !== this.name) {
      throw new Error(`TmuxBackend received a PaneRef for backend '${pane.backend}'`);
    }
  }

  private readPaneMap(): Record<string, string> {
    return this.store.getWorkspaceValue<Record<string, string>>(WORKSPACE_KEY) ?? {};
  }

  private writePaneMap(map: Record<string, string>): void {
    this.store.setWorkspaceValue(WORKSPACE_KEY, map);
  }
}
