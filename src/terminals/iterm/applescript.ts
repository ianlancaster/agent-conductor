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
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if (tty of s) is "${escapeAppleScript(ttyPath)}" then
              tell s
                set name to "${escaped}"
              end tell
              return "OK"
            end if
          end repeat
        end repeat
      end repeat
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
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if (tty of s) is "${escapeAppleScript(ttyPath)}" then
              return (id of w as string)
            end if
          end repeat
        end repeat
      end repeat
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
 * Run `operations` inside a `tell` block for the session with the given UUID,
 * searching ALL windows — panes may have been moved out of the conductor window.
 * Direct `session id "X"` references are unreliable across osascript process
 * boundaries for recently-created sessions, so we iterate instead.
 * Returns `returnExpr` when found; stdout is empty when the session is gone.
 */
export function buildInSessionScript(sessionId: string, operations: string, returnExpr = '"OK"'): string {
  return `
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          try
            -- Snapshot object references before iterating. iTerm mutates its
            -- live session collection while panes open/close; iterating the
            -- lazy every-session specifier can otherwise raise -1719 and
            -- make unrelated captures and deliveries fail.
            set sessionList to every session of t
            repeat with s in sessionList
              try
                if (id of s) is "${escapeAppleScript(sessionId)}" then
                  tell s
                    ${operations}
                    return ${returnExpr}
                  end tell
                end if
              on error errorMessage number errorNumber
                if errorNumber is not -1719 then error errorMessage number errorNumber
              end try
            end repeat
          on error errorMessage number errorNumber
            if errorNumber is not -1719 then error errorMessage number errorNumber
          end try
        end repeat
      end repeat
      return "${SESSION_NOT_FOUND_RESULT}"
    end tell
  `;
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
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if (id of s) is "${escapeAppleScript(sessionId)}" then
              select w
              select t
              select s
              return "OK"
            end if
          end repeat
        end repeat
      end repeat
      return "NOT_FOUND"
    end tell
  `;
}

/** All live session UUIDs across all windows, one per line. */
export function buildListSessionIdsScript(): string {
  return `
    tell application "iTerm2"
      set out to ""
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            set out to out & (id of s) & linefeed
          end repeat
        end repeat
      end repeat
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
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            set sid to (id of s)
            set v to missing value
            try
              tell s to set v to (variable named "${SESSION_USER_VAR}")
            end try
            if v is not missing value and v is not "" then
              set out to out & sid & "|" & v & linefeed
            end if
          end repeat
        end repeat
      end repeat
      return out
    end tell
  `;
}

/** Close the pane with the given session UUID, searching all windows. */
export function buildCloseSessionScript(sessionId: string): string {
  return `
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if (id of s) is "${escapeAppleScript(sessionId)}" then
              close s
              return "OK"
            end if
          end repeat
        end repeat
      end repeat
    end tell
  `;
}
