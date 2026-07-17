import { mkdtemp, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaneRef, Placement } from '../../core/types.js';
import { sleep } from '../../core/utils.js';
import { log } from '../../logger.js';
import type { Store } from '../../store/index.js';
import type { TerminalBackend, TerminalCapabilities } from '../types.js';
import {
  buildCloseSessionScript,
  buildCreateSessionWindowScript,
  buildCreateTabScript,
  buildCreateWindowScript,
  buildFocusWindowScript,
  buildFocusedSessionScript,
  buildInSessionScript,
  buildListSessionIdsScript,
  buildRediscoverScript,
  buildSplitPaneScript,
  buildWindowExistsScript,
  containsPromptMarker,
  encodeSessionVar,
  escapeAppleScript,
  parseRediscoveryOutput,
  parseWindowCreateResult,
  runOsa,
  sessionSetup,
  shellQuote,
  shouldUseBracketedPaste,
  tailLines,
  wrapBracketedPaste,
} from './applescript.js';

/** The `terminal.iterm` config slice plus the shared `terminal.windowName`. */
export interface ITermBackendConfig {
  windowName: string;
  /** Scopes pane identity markers so rediscovery never adopts another fleet's panes. */
  fleetId: string;
  autoPauseOnFocus: boolean;
  autoPauseResumeDelaySeconds: number;
  focusCheckMs: number;
  bracketedPasteThreshold: number;
  launchTimeoutSec: number;
  pollIntervalSec: number;
}

export interface ITermBackendOptions {
  store: Store;
  config: ITermBackendConfig;
}

/** Store keys replacing the old workspace.json. */
const WINDOW_ID_KEY = 'iterm.windowId';
const PANES_KEY = 'iterm.panes';

/**
 * iTerm2 TerminalBackend, driven via async AppleScript (execFile, never execSync —
 * osascript calls must not block the event loop).
 *
 * Key design, ported from cc-conductor's IterminalWorkspace:
 *  - Panes are tracked by iTerm2 session UUID, searched across ALL windows, so
 *    panes moved to other windows keep working. Only pane creation targets the
 *    conductor window.
 *  - Each session session carries a `user.conductor_session` variable (base64
 *    codename), set atomically in the creation AppleScript, which is how
 *    rediscover() reattaches after a conductor restart.
 *  - Text delivery always goes through a temp file + `write contents of file`,
 *    because iTerm2's `write text` simulates keystrokes and truncates ~800 chars.
 *    Multi-line or over-threshold text is wrapped in bracketed-paste markers so
 *    embedded newlines are content, not submit keystrokes.
 *  - launch() polls session contents for a shell prompt marker (JS-side async
 *    loop — the old code busy-waited inside AppleScript) so the first command
 *    is not swallowed by shell rc-file init.
 */
export class ITermBackend implements TerminalBackend {
  readonly name = 'iterm';
  readonly capabilities: TerminalCapabilities = { focusTracking: true, headless: false };

  private readonly store: Store;
  private readonly config: ITermBackendConfig;
  private windowId: number | null = null;
  /** session codename -> iTerm2 session UUID */
  private readonly panes = new Map<string, string>();
  private tmpDirPromise: Promise<string> | null = null;

  constructor(options: ITermBackendOptions) {
    this.store = options.store;
    this.config = options.config;
  }

  // ── Workspace lifecycle ─────────────────────────────────────────────────────

  async init(): Promise<void> {
    this.windowId = this.store.getWorkspaceValue<number>(WINDOW_ID_KEY) ?? null;
    this.panes.clear();
    const persisted = this.store.getWorkspaceValue<Record<string, string>>(PANES_KEY) ?? {};
    for (const [session, sessionId] of Object.entries(persisted)) {
      this.panes.set(session, sessionId);
    }

    if (this.windowId !== null) {
      if (await this.windowExists(this.windowId)) {
        log().info('iterm', `Existing conductor window found (id=${this.windowId}) — validating persisted panes`);
      } else {
        this.windowId = null;
      }
    }
    await this.pruneDeadPanes();
    // The workspace window itself is created lazily — an empty window at
    // startup is just confusing. First pane creation calls ensureWindow().
  }

  async focusWindow(): Promise<void> {
    if (this.windowId === null) return;
    try {
      await runOsa(buildFocusWindowScript(this.windowId));
    } catch (err) {
      log().debug('iterm', `Focus failed: ${String(err)}`);
    }
  }

  // ── Pane lifecycle ──────────────────────────────────────────────────────────

  async createPane(session: string, placement: Placement, cwd?: string): Promise<PaneRef> {
    const existing = this.panes.get(session);
    if (existing !== undefined) {
      if (await this.sessionAlive(existing)) {
        log().debug('iterm', `${session}: pane already exists, reusing (session=${existing.slice(0, 8)})`);
        return { backend: this.name, id: existing };
      }
      this.panes.delete(session);
      this.persistPanes();
    }

    log().info('iterm', `${session}: creating ${placement}`);
    const sessionVar = encodeSessionVar(this.config.fleetId, session);
    let sessionId: string;
    if (placement === 'window') {
      sessionId = (await runOsa(buildCreateSessionWindowScript(session, sessionVar))).trim();
    } else {
      const { windowId, seedSessionId } = await this.ensureWindow();
      if (seedSessionId !== null) {
        // A fresh window unavoidably contains one shell. The first session
        // claims it instead of splitting, so there is never an unexplained
        // empty pane in the workspace window.
        await this.inSession(seedSessionId, sessionSetup(session, sessionVar));
        sessionId = seedSessionId;
      } else {
        const script =
          placement === 'tab'
            ? buildCreateTabScript(windowId, session, sessionVar)
            : buildSplitPaneScript(windowId, session, sessionVar);
        sessionId = (await runOsa(script)).trim();
      }
    }
    if (sessionId === '') {
      throw new Error(`iTerm2 returned no session id creating ${placement} for ${session}`);
    }
    this.panes.set(session, sessionId);
    this.persistPanes();
    log().debug('iterm', `${session}: ${placement} created (session=${sessionId.slice(0, 8)})`);

    if (cwd !== undefined) {
      // The shell starts in the profile's default directory; move it before the
      // runtime's launch command arrives. Wait for the prompt so the cd is not
      // swallowed by shell rc-file init.
      await this.waitForPrompt(sessionId);
      await this.deliver(sessionId, `cd ${shellQuote(cwd)}`);
    }
    return { backend: this.name, id: sessionId };
  }

  async launch(pane: PaneRef, command: string): Promise<void> {
    log().debug('iterm', `Launching in ${pane.id.slice(0, 8)} (poll for prompt, length=${command.length})`);
    const found = await this.waitForPrompt(pane.id);
    if (!found) {
      log().warn(
        'iterm',
        `${pane.id.slice(0, 8)}: no prompt within ${this.config.launchTimeoutSec}s — submitting anyway`,
      );
    }
    await this.deliver(pane.id, command);
  }

  async run(pane: PaneRef, text: string): Promise<void> {
    log().debug('iterm', `${pane.id.slice(0, 8)}: sending → ${text.slice(0, 80)}`);
    await this.deliver(pane.id, text);
  }

  async capture(pane: PaneRef, lines: number): Promise<string> {
    try {
      const contents = await this.sessionContents(pane.id);
      return tailLines(contents, lines);
    } catch (err) {
      log().warn('iterm', `${pane.id.slice(0, 8)}: capture failed: ${String(err)}`);
      return '';
    }
  }

  async isAlive(pane: PaneRef): Promise<boolean> {
    const alive = await this.sessionAlive(pane.id);
    if (!alive) this.forgetSession(pane.id);
    return alive;
  }

  async kill(pane: PaneRef): Promise<void> {
    log().info('iterm', `Closing pane ${pane.id.slice(0, 8)}`);
    try {
      await runOsa(buildCloseSessionScript(pane.id));
    } catch (err) {
      log().warn('iterm', `${pane.id.slice(0, 8)}: close failed: ${String(err)}`);
    }
    this.forgetSession(pane.id);
  }

  async rename(pane: PaneRef, name: string): Promise<void> {
    const escaped = escapeAppleScript(name);
    try {
      await this.inSession(
        pane.id,
        `set name to "${escaped}"
         set badge to "${escaped}"`,
      );
    } catch (err) {
      log().debug('iterm', `${pane.id.slice(0, 8)}: rename failed: ${String(err)}`);
    }
  }

  async rediscover(): Promise<Map<string, PaneRef>> {
    const result = new Map<string, PaneRef>();
    try {
      const raw = await runOsa(buildRediscoverScript());
      const found = parseRediscoveryOutput(raw, this.config.fleetId);
      this.panes.clear();
      for (const [session, sessionId] of found) {
        this.panes.set(session, sessionId);
        result.set(session, { backend: this.name, id: sessionId });
      }
      this.persistPanes();
      log().info('iterm', `Rediscovery: ${result.size} surviving session pane(s)`);
    } catch (err) {
      log().warn('iterm', `Rediscovery failed: ${String(err)}`);
    }
    return result;
  }

  async getFocusedSession(): Promise<string | null> {
    if (this.windowId === null) return null;
    try {
      const sessionId = (await runOsa(buildFocusedSessionScript(this.windowId))).trim();
      for (const [session, paneSessionId] of this.panes) {
        if (paneSessionId === sessionId) return session;
      }
      return null;
    } catch {
      return null;
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /** Create the workspace window; returns its id and the seed session's id. */
  private async createWorkspaceWindow(): Promise<{ windowId: number; seedSessionId: string }> {
    log().info('iterm', `Creating iTerm2 window: "${this.config.windowName}"`);
    const stdout = await runOsa(buildCreateWindowScript(this.config.windowName));
    const parsed = parseWindowCreateResult(stdout);
    if (parsed === null) {
      throw new Error(`Unexpected create-window output from iTerm2: ${JSON.stringify(stdout)}`);
    }
    this.windowId = parsed.windowId;
    this.store.setWorkspaceValue(WINDOW_ID_KEY, this.windowId);
    log().info('iterm', `Window created: id=${this.windowId}`);
    // iTerm2 needs a moment after window creation before the window id is
    // addressable via AppleScript in subsequent calls.
    await sleep(1000);
    return { windowId: parsed.windowId, seedSessionId: parsed.sessionId };
  }

  /**
   * Existing window → { windowId, seedSessionId: null }. Freshly created →
   * the seed session id is returned exactly once so the caller can claim it.
   */
  private async ensureWindow(): Promise<{ windowId: number; seedSessionId: string | null }> {
    if (this.windowId !== null && (await this.windowExists(this.windowId))) {
      return { windowId: this.windowId, seedSessionId: null };
    }
    return this.createWorkspaceWindow();
  }

  private async windowExists(windowId: number): Promise<boolean> {
    try {
      const result = await runOsa(buildWindowExistsScript(windowId));
      return result.trim() === 'true';
    } catch {
      return false;
    }
  }

  /** Drop persisted pane mappings whose sessions no longer exist. */
  private async pruneDeadPanes(): Promise<void> {
    if (this.panes.size === 0) return;
    try {
      const raw = await runOsa(buildListSessionIdsScript());
      const live = new Set(
        raw
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== ''),
      );
      let changed = false;
      for (const [session, sessionId] of [...this.panes]) {
        if (!live.has(sessionId)) {
          log().warn('iterm', `${session}: session gone, removing mapping`);
          this.panes.delete(session);
          changed = true;
        }
      }
      if (changed) this.persistPanes();
    } catch (err) {
      log().warn('iterm', `Pane validation failed: ${String(err)}`);
    }
  }

  /**
   * Poll session contents for a shell prompt marker so input lands on a live
   * prompt instead of being consumed by rc-file init (nvm, oh-my-zsh, ...).
   * Async JS-side loop — never blocks the event loop. Returns false on timeout
   * (callers submit anyway, best-effort — same behavior as the old conductor).
   */
  private async waitForPrompt(sessionId: string): Promise<boolean> {
    const deadline = Date.now() + this.config.launchTimeoutSec * 1000;
    const intervalMs = this.config.pollIntervalSec * 1000;
    for (;;) {
      const contents = await this.sessionContents(sessionId);
      if (containsPromptMarker(contents)) return true;
      if (Date.now() >= deadline) return false;
      await sleep(intervalMs);
    }
  }

  /**
   * Deliver text to a session as if typed, then submit with CR. Content goes
   * through a temp file (`write contents of file`) because `write text`
   * truncates long strings; multi-line/long content is bracketed-paste wrapped.
   */
  private async deliver(sessionId: string, text: string): Promise<void> {
    const bracketed = shouldUseBracketedPaste(text, this.config.bracketedPasteThreshold);
    const content = bracketed ? wrapBracketedPaste(text) : text;
    const path = await this.writeTempContent(content);
    try {
      await this.inSession(
        sessionId,
        `write contents of file "${escapeAppleScript(path)}" newline false
         delay ${bracketed ? 0.1 : 0.2}
         write text (ASCII character 13)`,
      );
    } finally {
      await unlink(path).catch(() => undefined);
    }
  }

  private async sessionAlive(sessionId: string): Promise<boolean> {
    try {
      return (await this.inSession(sessionId, '', '"ALIVE"')).trim() === 'ALIVE';
    } catch {
      return false;
    }
  }

  private async sessionContents(sessionId: string): Promise<string> {
    return this.inSession(sessionId, '', '(contents as string)');
  }

  private async inSession(sessionId: string, operations: string, returnExpr = '"OK"'): Promise<string> {
    return runOsa(buildInSessionScript(sessionId, operations, returnExpr));
  }

  private forgetSession(sessionId: string): void {
    let changed = false;
    for (const [session, paneSessionId] of [...this.panes]) {
      if (paneSessionId === sessionId) {
        this.panes.delete(session);
        changed = true;
      }
    }
    if (changed) this.persistPanes();
  }

  private persistPanes(): void {
    this.store.setWorkspaceValue(PANES_KEY, Object.fromEntries(this.panes));
  }

  private async writeTempContent(text: string): Promise<string> {
    this.tmpDirPromise ??= mkdtemp(join(tmpdir(), 'conductor-iterm-'));
    const dir = await this.tmpDirPromise;
    const path = join(dir, `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    await writeFile(path, text, 'utf-8');
    return path;
  }
}
