import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** osascript stdout can include large pane captures. */
const OSA_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Hard timeout for any osascript call. iTerm2 can block indefinitely on a modal
 * dialog, a beachball, or a macOS automation-permission (TCC) prompt; without a
 * timeout the heartbeat/focus intervals would spawn a fresh stuck process every
 * tick. On timeout execFile kills the child and rejects.
 */
const OSA_TIMEOUT_MS = 20_000;

/** iTerm2 session user variable holding the base64-encoded session codename (used for restart rediscovery). */
export const SESSION_USER_VAR = 'user.conductor_session';
export const SESSION_NOT_FOUND_RESULT = '__CONDUCTOR_ITERM_SESSION_NOT_FOUND__';

const ESC = '\u001b';

// ── Runner ────────────────────────────────────────────────────────────────────

/**
 * Run an AppleScript via osascript without blocking the event loop.
 * Returns raw stdout (callers trim as needed).
 */
export async function runOsa(script: string): Promise<string> {
  const { stdout } = await execFileAsync('osascript', ['-e', script], {
    maxBuffer: OSA_MAX_BUFFER,
    timeout: OSA_TIMEOUT_MS,
  });
  return stdout;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Escape a string for embedding inside a double-quoted AppleScript literal.
 * Every user-supplied string interpolated into a script MUST pass through this —
 * unescaped quotes break the entire osascript call.
 */
export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Guard an iTerm write with the exact pane snapshot captured immediately
 * beforehand. AppleScript's default file encoding is not UTF-8; leaving the
 * type implicit makes every pane containing Unicode compare unequal.
 */
export function buildUnchangedContentsGuard(expectedPath: string, changedResult: string): string {
  return `set expectedContents to read POSIX file "${escapeAppleScript(expectedPath)}" as «class utf8»
         if ((contents as string) & (ASCII character 10)) is not expectedContents then return "${escapeAppleScript(changedResult)}"`;
}

/** Quote a string for a POSIX shell (single-quote style), e.g. for `cd <dir>`. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Shell snippet that titles the pane from INSIDE the launch command (the
 * cc-conductor pattern). Emitted before the runtime starts, as part of the
 * same atomic command line: the shell's own preexec title escape fires first,
 * then these printfs, then the runtime (which never touches the title) — so
 * the last writer is us, by construction. No AppleScript, no timing.
 */
export function buildTitleShellPrefix(displayName: string, badge: boolean, badgeName = displayName): string {
  // The title is data, never the printf format string. Tags commonly contain
  // percentages (for example context readings); interpolating one into the
  // format makes zsh parse it as a directive and abort the runtime launch.
  const parts = [`printf '\\033]0;%s\\a' ${shellQuote(displayName)}`];
  if (badge) {
    const badgeB64 = Buffer.from(badgeName, 'utf-8').toString('base64');
    parts.push(`printf '\\033]1337;SetBadgeFormat=%s\\a' ${shellQuote(badgeB64)}`);
  }
  return parts.join(' && ');
}

/**
 * Multi-line text must use bracketed paste or the shell treats embedded newlines
 * as submit keystrokes; long text must use it to avoid PTY canonical-mode
 * truncation (MAX_CANON ~1024 bytes).
 */
export function shouldUseBracketedPaste(text: string, threshold: number): boolean {
  return text.includes('\n') || text.length > threshold;
}

/** Wrap text in bracketed-paste markers (ESC[200~ ... ESC[201~). */
export function wrapBracketedPaste(text: string): string {
  return `${ESC}[200~${text}${ESC}[201~`;
}

/** Known-good TUI delivery payload: inert pasted text plus one trailing newline. */
export function bracketedPastePayload(text: string): string {
  return wrapBracketedPaste(text.endsWith('\n') ? text : `${text}\n`);
}

/**
 * True when the LAST non-empty line of the capture looks like a shell prompt.
 * Scanning the whole capture is wrong: scrollback almost always contains an
 * old prompt, so a whole-capture check reports "ready" while the shell is
 * still executing — and text delivered then splices into the command line
 * (raw canonical-mode input: literal ^[[200~, truncation at ~1024 bytes).
 */
export function containsPromptMarker(contents: string): boolean {
  const lines = contents
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) return false;
  // `%` preceded by a digit is progress output (`42%`), not a zsh prompt.
  return /(?:(?<!\d)%|[$#❯>])$/.test(last);
}

/**
 * Clear whatever sits on a shell's input line, sending no signal to do it.
 *
 * `^E` moves to end of line and `^U` kills backwards from there, which clears
 * the whole line under both editors: zsh binds `^U` to `kill-whole-line` and
 * bash to `unix-line-discard` (backwards only), so the `^E` is what makes the
 * kill total on bash. Both are no-ops on an already-empty line.
 *
 * This cannot ride along inside a bracketed-paste payload — everything between
 * the paste markers is delivered as literal text, never as editing commands.
 */
export const CLEAR_INPUT_LINE_OPERATIONS = 'write text ((ASCII character 5) & (ASCII character 21)) newline false';

/** Injected observations for {@link awaitLaunchReadiness}. */
export interface LaunchReadinessProbe {
  /** Current pane contents. */
  contents: () => Promise<string>;
  /**
   * Whether the pane's interactive shell owns its tty's foreground process
   * group. Must resolve false when the tty cannot be read: a pane nobody could
   * observe is not a pane known to be sitting at a prompt, and the difference
   * decides whether control characters are safe to send.
   */
  shellIdle: () => Promise<boolean>;
  /** Apply {@link CLEAR_INPUT_LINE_OPERATIONS} to the pane; best effort. */
  clearInputLine: () => Promise<void>;
  /** Whether the launch timeout has elapsed. */
  expired: () => boolean;
  /** Wait one poll interval. */
  pause: () => Promise<void>;
}

/**
 * Wait until a pane can accept a launch command.
 *
 * A rendered prompt marker is the primary signal, but it is blind to the case
 * this exists for. A keystroke that lands in a pane while it is being created
 * leaves the input line reading `~/repo ❯ he`, which `containsPromptMarker`
 * rejects and will never accept, so the poll burned its entire timeout and then
 * spliced the launch command onto the operator's characters — one dead agent
 * per stray keystroke.
 *
 * The tty's foreground process group is the independent signal. A shell that
 * owns its own foreground group is sitting at a prompt whatever its input line
 * says, so on that evidence the line is cleared. If contamination was the
 * cause, the next poll sees a clean prompt and the launch proceeds normally
 * instead of waiting out the timeout; if the pane was merely still running
 * rc-file init, the control characters are inert and the poll is unchanged.
 *
 * Clearing happens at most once. The window in which a stray keystroke can
 * reach the pane closes when creation returns, so a second attempt could only
 * add osascript round trips to a pane that is slow rather than dirty.
 */
export async function awaitLaunchReadiness(probe: LaunchReadinessProbe): Promise<boolean> {
  let cleared = false;
  for (;;) {
    if (containsPromptMarker(await probe.contents())) return true;
    if (!cleared && (await probe.shellIdle())) {
      await probe.clearInputLine();
      cleared = true;
    }
    if (probe.expired()) return false;
    await probe.pause();
  }
}

/** Trailing `lines` content rows, ignoring the terminal viewport's empty tail. */
export function tailLines(contents: string, lines: number): string {
  if (lines <= 0) return '';
  const all = contents.split('\n');
  let end = all.length;
  while (end > 0) {
    const line = all[end - 1];
    if (line !== undefined && line.trim().length > 0) break;
    end -= 1;
  }
  return all.slice(Math.max(0, end - lines), end).join('\n');
}

/**
 * Encode `<fleetId>:<codename>` for storage in the iTerm2 user variable. The
 * fleet id scopes the marker: multiple conductors (and the legacy cc-conductor,
 * which uses the same variable name with a bare codename) share one iTerm
 * instance, and rediscovery must only ever adopt this fleet's panes.
 */
export function encodeSessionVar(fleetId: string, codename: string): string {
  return Buffer.from(`${fleetId}:${codename}`, 'utf-8').toString('base64');
}

/** Decode a stored user-variable value; null when empty, invalid, or another fleet's. */
export function decodeSessionVar(value: string, fleetId: string): string | null {
  const decoded = Buffer.from(value, 'base64').toString('utf-8');
  const prefix = `${fleetId}:`;
  if (!decoded.startsWith(prefix)) return null;
  const codename = decoded.slice(prefix.length);
  return codename.length > 0 ? codename : null;
}

/** Parse `windowId|sessionId` returned by the create-window script. */
export function parseWindowCreateResult(raw: string): { windowId: number; sessionId: string } | null {
  const [windowPart, sessionPart] = raw.trim().split('|');
  if (windowPart === undefined || sessionPart === undefined || sessionPart === '') return null;
  const windowId = Number.parseInt(windowPart, 10);
  if (Number.isNaN(windowId)) return null;
  return { windowId, sessionId: sessionPart };
}

/**
 * Parse rediscovery output: one `sessionId|base64Marker` pair per line.
 * Returns codename -> sessionId for THIS fleet's panes only; other fleets'
 * markers (and malformed lines) are skipped.
 */
export function parseRediscoveryOutput(raw: string, fleetId: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const [sessionId, encoded] = line.trim().split('|');
    if (sessionId === undefined || sessionId === '' || encoded === undefined || encoded === '') continue;
    const codename = decodeSessionVar(encoded, fleetId);
    if (codename !== null) result.set(codename, sessionId);
  }
  return result;
}

// ── Script builders (pure) ────────────────────────────────────────────────────

/** `exists window id N` — "true"/"false". */
export function buildWindowExistsScript(windowId: number): string {
  return `tell application "iTerm2" to return (exists window id ${windowId}) as string`;
}

/**
 * Set the name of the iTerm session attached to the given tty (best effort).
 * Used to label the conductor's own terminal — OSC titles can lose to iTerm's
 * job detection depending on profile settings, but the session name set via
 * AppleScript is what cc-conductor proved sticks.
 */
export function buildNameTtySessionScript(ttyPath: string, name: string): string {
  const escaped = escapeAppleScript(name);
  return `
    tell application "iTerm2"
      ${forEachSession(`if (tty of s) is "${escapeAppleScript(ttyPath)}" then
              tell s
                set name to "${escaped}"
              end tell
              return "OK"
            end if`)}
      return ""
    end tell
  `;
}

/**
 * Find the window containing the session attached to the given tty. Used to
 * adopt the window the conductor console itself runs in as the workspace —
 * sessions then open beside the console instead of in a separate window.
 * Returns the window id, or "" when the tty is not an iTerm session.
 */
export function buildFindTtyWindowScript(ttyPath: string): string {
  return `
    tell application "iTerm2"
      ${forEachSession(`if (tty of s) is "${escapeAppleScript(ttyPath)}" then
              return (id of w as string)
            end if`)}
      return ""
    end tell
  `;
}

/**
 * Create the conductor workspace window. Returns `windowId|sessionId` — the
 * seed session id matters: a fresh window unavoidably contains one shell, and
 * the FIRST session claims it instead of splitting, so the workspace never
 * shows an unexplained empty pane.
 */
export function buildCreateWindowScript(windowName: string, preserveFocus = false): string {
  return `
    tell application "iTerm2"
      ${preserveFocus ? '' : 'activate'}
      set newWin to (create window with default profile)
      tell current session of current tab of newWin
        set name to "${escapeAppleScript(windowName)}"
        set sessId to id as string
      end tell
      return (id of newWin as string) & "|" & sessId
    end tell
  `;
}

/**
 * Session setup lines shared by the session-pane creation scripts. The name
 * set here is provisional — the shell's title escape overwrites it when the
 * launch command runs, so the backend re-applies it once the runtime is up.
 */
export function sessionSetup(displayName: string, sessionVarB64: string): string {
  const escaped = escapeAppleScript(displayName);
  return `set name to "${escaped}"
            set variable named "${SESSION_USER_VAR}" to "${escapeAppleScript(sessionVarB64)}"`;
}

/**
 * Remember what the operator had selected, so pane creation can put it back.
 *
 * iTerm has no "create without selecting" verb: `create window`, `create tab`
 * and `split vertically` all select what they make. The only way not to steal
 * the cursor is to restore the previous selection immediately afterwards.
 * Wrapped in `try` because a fleet may legitimately be opening the first pane,
 * with no current window to remember.
 */
const REMEMBER_FOCUS = `set priorWindow to missing value
      set priorTab to missing value
      set priorSession to missing value
      try
        set priorWindow to current window
        set priorTab to current tab of priorWindow
        set priorSession to current session of priorTab
      end try`;

/**
 * Restore all three, outermost first.
 *
 * Selecting the session alone does NOT bring its window back — measured against
 * live iTerm: creating a tab moved the current window from 74 to 108, and a
 * session-only restore left it on 108. Window, then tab, then session returns
 * it to 74. Each is guarded because a pane the operator closed mid-creation
 * must not fail a creation that already succeeded.
 */
const RESTORE_FOCUS = `if priorWindow is not missing value then
        try
          select priorWindow
        end try
      end if
      if priorTab is not missing value then
        try
          select priorTab
        end try
      end if
      if priorSession is not missing value then
        try
          select priorSession
        end try
      end if`;

/** Bracket a creation body with focus restoration when the fleet asked for it. */
function preservingFocus(preserveFocus: boolean, body: string): string {
  if (!preserveFocus) return body;
  return `${REMEMBER_FOCUS}
      ${body}
      ${RESTORE_FOCUS}`;
}

/** Create a standalone window for a session. Returns the session id. */
export function buildCreateSessionWindowScript(
  displayName: string,
  sessionVarB64: string,
  preserveFocus = false,
): string {
  return `
    tell application "iTerm2"
      ${preservingFocus(
        preserveFocus,
        `set newWin to (create window with default profile)
      tell current session of current tab of newWin
        ${sessionSetup(displayName, sessionVarB64)}
        set sessId to id as string
      end tell`,
      )}
      return sessId
    end tell
  `;
}

/** Create a new tab in the conductor window for a session. Returns the session id. */
export function buildCreateTabScript(
  windowId: number,
  displayName: string,
  sessionVarB64: string,
  preserveFocus = false,
): string {
  return `
    tell application "iTerm2"
      ${preservingFocus(
        preserveFocus,
        `tell window id ${windowId}
        set newTab to (create tab with default profile)
        tell current session of newTab
          ${sessionSetup(displayName, sessionVarB64)}
          set sessId to id as string
        end tell
      end tell`,
      )}
      return sessId
    end tell
  `;
}

/**
 * Split the first tab of the conductor window vertically (flat side-by-side layout).
 * Returns the session id.
 */
export function buildSplitPaneScript(
  windowId: number,
  displayName: string,
  sessionVarB64: string,
  preserveFocus = false,
): string {
  return `
    tell application "iTerm2"
      ${preservingFocus(
        preserveFocus,
        `tell window id ${windowId}
        tell current session of first tab
          set newSession to (split vertically with default profile)
          tell newSession
            ${sessionSetup(displayName, sessionVarB64)}
            set sessId to id as string
          end tell
        end tell
      end tell`,
      )}
      return sessId
    end tell
  `;
}

/**
 * AppleScript error numbers that mean "the object this reference names is gone",
 * raised when iTerm resolves an element reference after the pane behind it has
 * closed: -1719 from the lazy `every session` specifier, and -1728 from a
 * snapshotted element (`Can't get session id "..." of tab 5 of window id 108`).
 *
 * Every scan below walks ALL of iTerm — one process cannot enumerate only its
 * own panes — so a pane closing anywhere, including in another fleet's window
 * or a human's unrelated tab, lands mid-scan. Untolerated, that aborts the whole
 * enumeration, and the resulting failure is indistinguishable from "your session
 * is gone". Skipping the vanished element and continuing is the only reading
 * that keeps one window's churn out of another window's answer.
 */
const VANISHED_ELEMENT_ERRORS = '{-1719, -1728}';

/**
 * Enumerate every session of every tab of every window, running `body` with `s`
 * bound to the session (and `w`/`t` to its window and tab), tolerating elements
 * that vanish mid-scan at all three levels. `body` may `return` to end the scan.
 *
 * Any error that is NOT a vanished element propagates: an unobservable iTerm is
 * a fact callers must be able to tell apart from an empty one.
 */
function forEachSession(body: string): string {
  const skipVanished = `on error errorMessage number errorNumber
              if not (${VANISHED_ELEMENT_ERRORS} contains errorNumber) then error errorMessage number errorNumber
            end try`;
  return `repeat with w in windows
        try
          repeat with t in tabs of w
            try
              -- Snapshot the session references before iterating: the lazy
              -- every-session specifier resolves elements as it walks, so a
              -- pane closing mid-walk breaks the iteration itself.
              set sessionList to every session of t
              repeat with s in sessionList
                try
                  ${body}
                ${skipVanished}
              end repeat
            ${skipVanished}
          end repeat
        ${skipVanished}
      end repeat`;
}

/**
 * Run `operations` inside a `tell` block for the session with the given UUID,
 * searching ALL windows — panes may have been moved out of the conductor window.
 * Direct `session id "X"` references are unreliable across osascript process
 * boundaries for recently-created sessions, so we iterate instead.
 * Returns `returnExpr` when found; stdout is empty when the session is gone.
 */
export function buildInSessionScript(sessionId: string, operations: string, returnExpr = '"OK"'): string {
  return `
    tell application "iTerm2"
      ${forEachSession(`if (id of s) is "${escapeAppleScript(sessionId)}" then
              tell s
                ${operations}
                return ${returnExpr}
              end tell
            end if`)}
      return "${SESSION_NOT_FOUND_RESULT}"
    end tell
  `;
}

/**
 * Read a liveness probe's output as an answer about the pane, or refuse to.
 *
 * Only a scan that ran to completion and reported the session missing means the
 * pane is gone. Anything else — a timeout killing osascript, a scripting error,
 * truncated output — means the terminal could not be asked, which is a
 * different fact and must not be returned as `false`: lifecycle reads false as
 * "pane died", marks the session stopped and forgets its pane mapping, and
 * since reconcile only visits mapped panes, nothing revisits that seat again.
 */
export function interpretLivenessResult(sessionId: string, result: string): boolean {
  const trimmed = result.trim();
  if (trimmed === 'ALIVE') return true;
  if (trimmed === SESSION_NOT_FOUND_RESULT) return false;
  throw new Error(`iTerm returned an unrecognized liveness result for session ${sessionId}: ${trimmed || '(empty)'}`);
}

/**
 * Confirm a completed missing scan before retiring an iTerm pane.
 *
 * iTerm can transiently throw -1728 for a live snapshotted session while its
 * window or tab is changing. The enumeration correctly skips that unstable
 * element, but that makes one otherwise-complete scan look exactly like true
 * absence. A second independent scan keeps that race from permanently
 * orphaning a healthy agent; errors still propagate as unobservable.
 */
export async function confirmLiveness(
  sessionId: string,
  probe: () => Promise<string>,
  pause: () => Promise<void>,
): Promise<boolean> {
  if (interpretLivenessResult(sessionId, await probe())) return true;
  await pause();
  return interpretLivenessResult(sessionId, await probe());
}

/** Return the tty path for an iTerm session UUID, or empty output if it is gone. */
export function buildSessionTtyScript(sessionId: string): string {
  return buildInSessionScript(sessionId, '', '(tty as string)');
}

/** Bring a session's window to the front and select its tab + pane. */
export function buildRevealSessionScript(sessionId: string): string {
  return `
    tell application "iTerm2"
      activate
      ${forEachSession(`if (id of s) is "${escapeAppleScript(sessionId)}" then
              select w
              select t
              select s
              return "OK"
            end if`)}
      return "NOT_FOUND"
    end tell
  `;
}

/** All live session UUIDs across all windows, one per line. */
export function buildListSessionIdsScript(): string {
  return `
    tell application "iTerm2"
      set out to ""
      ${forEachSession('set out to out & (id of s) & linefeed')}
      return out
    end tell
  `;
}

/**
 * Emit `sessionId|base64Codename` for every session carrying the conductor
 * session user variable, across all windows.
 */
export function buildRediscoverScript(): string {
  return `
    tell application "iTerm2"
      set out to ""
      ${forEachSession(`set sid to (id of s)
            set v to missing value
            try
              tell s to set v to (variable named "${SESSION_USER_VAR}")
            end try
            if v is not missing value and v is not "" then
              set out to out & sid & "|" & v & linefeed
            end if`)}
      return out
    end tell
  `;
}

/** Close the pane with the given session UUID, searching all windows. */
export function buildCloseSessionScript(sessionId: string): string {
  return `
    tell application "iTerm2"
      ${forEachSession(`if (id of s) is "${escapeAppleScript(sessionId)}" then
              close s
              return "OK"
            end if`)}
    end tell
  `;
}
