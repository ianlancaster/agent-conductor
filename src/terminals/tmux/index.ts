import { setTimeout as sleep } from 'node:timers/promises';
import type { PaneRef, Placement } from '../../core/types.js';
import type { CreatePaneOptions, TerminalBackend, TerminalCapabilities } from '../types.js';
import type { Store } from '../../store/index.js';
import { log } from '../../logger.js';
import {
  SESSION_OPTION,
  buildAttachedPaneArgs,
  buildCreatePaneArgs,
  buildCreateSessionArgs,
  buildDeliveryCommands,
  encodeSessionOption,
  hasShellPrompt,
  parseSessionPanes,
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
  /** Scopes pane identity markers so rediscovery never adopts another fleet's panes. */
  fleetId: string;
  /**
   * Pane id of the conductor console's own tmux pane ($TMUX_PANE), set when
   * the conductor was launched from inside tmux and attachToCurrent is on.
   * Session panes then join the operator's session (split the console's
   * window / add windows to its session) instead of the detached
   * `sessionName` session. Falls back to detached if that pane is gone.
   */
  attachPane?: string;
  /**
   * Enable tmux's pane-border-status on windows the conductor creates panes
   * in, so each pane shows its title ("codename — tag") — tmux hides pane
   * titles by default.
   */
  paneBorders: boolean;
}

export interface TmuxBackendOptions {
  store: Store;
  config: TmuxBackendConfig;
}

/**
 * tmux implementation of TerminalBackend.
 *
 * Two modes: with `attachPane` set (conductor launched from inside tmux),
 * panes join the operator's own session; otherwise all panes live in a
 * single detached tmux session (config.sessionName). Placement notes: tmux
 * has no separate OS windows, so both 'tab' and 'window' placements create
 * a new tmux window; 'pane' splits the console's window (attached) or the
 * session's first window (detached). Focus tracking is not supported
 * (headless backend), so getFocusedSession/focusWindow are intentionally
 * not implemented.
 */
export class TmuxBackend implements TerminalBackend {
  readonly name = 'tmux';
  readonly capabilities: TerminalCapabilities = { focusTracking: false, headless: true };

  private readonly store: Store;
  private readonly sessionName: string;
  private readonly windowName: string;
  private readonly fleetId: string;
  private readonly attachPane: string | undefined;
  private readonly paneBorders: boolean;

  constructor(opts: TmuxBackendOptions) {
    this.store = opts.store;
    this.sessionName = opts.config.sessionName;
    this.windowName = opts.config.windowName;
    this.fleetId = opts.config.fleetId;
    this.attachPane = opts.config.attachPane;
    this.paneBorders = opts.config.paneBorders;
  }

  async init(): Promise<void> {
    // The detached tmux session is created lazily by the first createPane():
    // creating it here would leave an unexplained empty shell pane, since a
    // tmux session cannot exist without one.
  }

  async createPane(session: string, placement: Placement, cwd?: string, opts?: CreatePaneOptions): Promise<PaneRef> {
    const attach = opts?.headless !== true && this.attachPane !== undefined;
    let paneId = attach ? await this.createAttachedPane(placement, session, cwd) : null;
    paneId ??= await this.createDetachedPane(placement, session, cwd);
    if (!paneId.startsWith('%')) {
      throw new Error(`tmux returned an unexpected pane id for session '${session}': '${paneId}'`);
    }
    // Pane-scoped identity marker so rediscover() can map panes back to sessions.
    await tmux(['set-option', '-p', '-t', paneId, SESSION_OPTION, encodeSessionOption(this.fleetId, session)]);
    if (this.paneBorders) {
      // Make pane titles ("codename — tag", set via rename()) actually visible:
      // tmux hides them unless the window shows pane border status lines.
      // Window-scoped and best-effort — display chrome must never fail a spawn.
      try {
        await tmux(['set-option', '-w', '-t', paneId, 'pane-border-status', 'top']);
      } catch (error) {
        log().debug('tmux', `could not enable pane border titles: ${String(error)}`);
      }
    }
    const map = this.readPaneMap();
    map[session] = paneId;
    this.writePaneMap(map);
    log().info('tmux', `created pane ${paneId} for '${session}' (placement=${placement})`);
    return { backend: this.name, id: paneId };
  }

  /**
   * Attached mode: join the operator's own tmux session (the one the
   * conductor was launched from). Returns null when the console pane no
   * longer exists — the caller falls back to the detached session.
   */
  private async createAttachedPane(placement: Placement, session: string, cwd?: string): Promise<string | null> {
    if (this.attachPane === undefined) return null;
    try {
      const targetSession = (await tmux(['display-message', '-p', '-t', this.attachPane, '#{session_name}'])).trim();
      const args = buildAttachedPaneArgs({
        placement,
        attachPane: this.attachPane,
        targetSession,
        session,
        ...(cwd !== undefined ? { cwd } : {}),
      });
      return (await tmux(args)).trim();
    } catch (error) {
      log().warn(
        'tmux',
        `attach to current tmux window failed (${String(error)}) — falling back to detached session '${this.sessionName}'`,
      );
      return null;
    }
  }

  private async createDetachedPane(placement: Placement, session: string, cwd?: string): Promise<string> {
    // `=name` forces an EXACT session match. Without it, tmux prefix-matches, so
    // `has-session -t conductor` would find a user's `conductor-dev` session and
    // we'd inject session panes into it.
    const exists = await tmuxSucceeds(['has-session', '-t', `=${this.sessionName}`]);
    let paneId: string;
    if (exists) {
      const args = buildCreatePaneArgs({ placement, sessionName: this.sessionName, session, cwd });
      paneId = (await tmux(args)).trim();
    } else {
      // First pane: create the tmux session and claim its unavoidable initial
      // pane, so the workspace never carries an empty shell.
      const spec = {
        sessionName: this.sessionName,
        windowName: placement === 'pane' ? this.windowName : session,
        ...(cwd !== undefined ? { cwd } : {}),
      };
      paneId = (await tmux(buildCreateSessionArgs(spec))).trim();
      log().info('tmux', `created detached session '${this.sessionName}'`);
    }
    return paneId;
  }

  /**
   * Move a session's pane into the operator's window, wherever it currently
   * lives (detached fleet session, another window). Already there → focus it.
   */
  async summon(pane: PaneRef, session: string): Promise<string> {
    this.assertRef(pane);
    const anchor = await this.resolveAnchorPane();
    if (anchor === null) {
      return `Cannot summon: no attached tmux window to summon into.`;
    }
    const paneWindow = (await tmux(['display-message', '-p', '-t', pane.id, '#{window_id}'])).trim();
    const anchorWindow = (await tmux(['display-message', '-p', '-t', anchor, '#{window_id}'])).trim();
    if (paneWindow === anchorWindow) {
      await tmux(['select-pane', '-t', pane.id]);
      return `${session} is already in your window — focused it.`;
    }
    await tmux(['join-pane', '-d', '-s', pane.id, '-t', anchor]);
    return `${session} summoned into your window.`;
  }

  /**
   * The inverse of summon: move the pane into the detached fleet session as
   * its own window (created on demand). The session keeps running headless.
   */
  async banish(pane: PaneRef, session: string): Promise<string> {
    this.assertRef(pane);
    const paneSession = (await tmux(['display-message', '-p', '-t', pane.id, '#{session_name}'])).trim();
    if (paneSession === this.sessionName) {
      return `${session} is already banished (running in '${this.sessionName}').`;
    }
    const exists = await tmuxSucceeds(['has-session', '-t', `=${this.sessionName}`]);
    if (exists) {
      await tmux(['break-pane', '-d', '-s', pane.id, '-t', `=${this.sessionName}:`, '-n', session]);
    } else {
      // A tmux session cannot exist without a pane: create it with a
      // placeholder, join the real pane in, then drop the placeholder.
      const placeholder = (
        await tmux(['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', this.sessionName, '-n', session])
      ).trim();
      await tmux(['join-pane', '-d', '-s', pane.id, '-t', placeholder]);
      await tmux(['kill-pane', '-t', placeholder]);
    }
    return `${session} banished to detached session '${this.sessionName}' — /summon ${session} brings it back.`;
  }

  /**
   * The pane summoned panes join: the console's own pane when the conductor
   * was launched inside tmux, else the active pane of the most recently
   * active tmux client. Null when nothing is attached anywhere.
   */
  private async resolveAnchorPane(): Promise<string | null> {
    if (this.attachPane !== undefined && (await this.isAlive({ backend: this.name, id: this.attachPane }))) {
      return this.attachPane;
    }
    try {
      const clients = (await tmux(['list-clients', '-F', '#{client_activity} #{session_name}']))
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const idx = line.indexOf(' ');
          return { activity: Number(line.slice(0, idx)), session: line.slice(idx + 1) };
        })
        .sort((a, b) => b.activity - a.activity);
      const latest = clients[0];
      if (latest === undefined) return null;
      return (await tmux(['display-message', '-p', '-t', `=${latest.session}`, '#{pane_id}'])).trim();
    } catch {
      return null;
    }
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

  /** capture() with ANSI styling retained (`-e`) — see TerminalBackend.captureStyled. */
  async captureStyled(pane: PaneRef, lines: number): Promise<string> {
    this.assertRef(pane);
    const output = await tmux(['capture-pane', '-p', '-e', '-t', pane.id, '-S', `-${lines}`]);
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
      output = await tmux(['list-panes', '-a', '-F', `#{pane_id} #{${SESSION_OPTION}}`]);
    } catch (error) {
      // No tmux server -> no surviving panes.
      log().warn('tmux', `rediscover found no tmux server: ${String(error)}`);
      this.writePaneMap({});
      return result;
    }
    const paneMap: Record<string, string> = {};
    for (const [session, paneId] of parseSessionPanes(output, this.fleetId)) {
      result.set(session, { backend: this.name, id: paneId });
      paneMap[session] = paneId;
    }
    this.writePaneMap(paneMap);
    log().info('tmux', `rediscovered ${result.size} session pane(s)`);
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
