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

/** iTerm2 session user variable holding the base64-encoded agent codename (used for restart rediscovery). */
export const AGENT_USER_VAR = 'user.conductor_agent';

/** Shell prompt markers polled for before delivering the first command to a fresh pane. */
export const PROMPT_MARKERS: readonly string[] = [' ==> ', '$ ', '% ', '❯'];

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

/** Quote a string for a POSIX shell (single-quote style), e.g. for `cd <dir>`. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
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

/** True when captured pane contents show a shell prompt marker. */
export function containsPromptMarker(contents: string): boolean {
  return PROMPT_MARKERS.some((marker) => contents.includes(marker));
}

/** Trailing `lines` lines of pane contents (a single trailing newline is ignored). */
export function tailLines(contents: string, lines: number): string {
  const trimmed = contents.endsWith('\n') ? contents.slice(0, -1) : contents;
  if (lines <= 0) return '';
  return trimmed.split('\n').slice(-lines).join('\n');
}

/**
 * Encode `<fleetId>:<codename>` for storage in the iTerm2 user variable. The
 * fleet id scopes the marker: multiple conductors (and the legacy cc-conductor,
 * which uses the same variable name with a bare codename) share one iTerm
 * instance, and rediscovery must only ever adopt this fleet's panes.
 */
export function encodeAgentVar(fleetId: string, codename: string): string {
  return Buffer.from(`${fleetId}:${codename}`, 'utf-8').toString('base64');
}

/** Decode a stored user-variable value; null when empty, invalid, or another fleet's. */
export function decodeAgentVar(value: string, fleetId: string): string | null {
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
    const codename = decodeAgentVar(encoded, fleetId);
    if (codename !== null) result.set(codename, sessionId);
  }
  return result;
}

// ── Script builders (pure) ────────────────────────────────────────────────────

/** `exists window id N` — "true"/"false". */
export function buildWindowExistsScript(windowId: number): string {
  return `tell application "iTerm2" to return (exists window id ${windowId}) as string`;
}

/** Create the conductor workspace window. Returns `windowId|sessionId`. */
export function buildCreateWindowScript(windowName: string): string {
  return `
    tell application "iTerm2"
      activate
      set newWin to (create window with default profile)
      tell current session of current tab of newWin
        set name to "${escapeAppleScript(windowName)}"
        set sessId to id as string
      end tell
      return (id of newWin as string) & "|" & sessId
    end tell
  `;
}

/** Session setup lines shared by the agent-pane creation scripts. */
function agentSessionSetup(displayName: string, agentVarB64: string): string {
  return `set name to "${escapeAppleScript(displayName)}"
            set variable named "${AGENT_USER_VAR}" to "${escapeAppleScript(agentVarB64)}"`;
}

/** Create a standalone window for an agent. Returns the session id. */
export function buildCreateAgentWindowScript(displayName: string, agentVarB64: string): string {
  return `
    tell application "iTerm2"
      set newWin to (create window with default profile)
      tell current session of current tab of newWin
        ${agentSessionSetup(displayName, agentVarB64)}
        return id as string
      end tell
    end tell
  `;
}

/** Create a new tab in the conductor window for an agent. Returns the session id. */
export function buildCreateTabScript(windowId: number, displayName: string, agentVarB64: string): string {
  return `
    tell application "iTerm2"
      tell window id ${windowId}
        set newTab to (create tab with default profile)
        tell current session of newTab
          ${agentSessionSetup(displayName, agentVarB64)}
          return id as string
        end tell
      end tell
    end tell
  `;
}

/**
 * Split the first tab of the conductor window vertically (flat side-by-side layout).
 * Returns the session id.
 */
export function buildSplitPaneScript(windowId: number, displayName: string, agentVarB64: string): string {
  return `
    tell application "iTerm2"
      tell window id ${windowId}
        tell current session of first tab
          set newSession to (split vertically with default profile)
          tell newSession
            ${agentSessionSetup(displayName, agentVarB64)}
            return id as string
          end tell
        end tell
      end tell
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
          repeat with s in sessions of t
            if (id of s) is "${escapeAppleScript(sessionId)}" then
              tell s
                ${operations}
                return ${returnExpr}
              end tell
            end if
          end repeat
        end repeat
      end repeat
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
 * agent user variable, across all windows.
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
              tell s to set v to (variable named "${AGENT_USER_VAR}")
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

/** Session UUID of the focused pane in the conductor window. */
export function buildFocusedSessionScript(windowId: number): string {
  return `
    tell application "iTerm2"
      tell window id ${windowId}
        return id of current session of current tab
      end tell
    end tell
  `;
}

/** Bring the conductor window to the foreground. */
export function buildFocusWindowScript(windowId: number): string {
  return `
    tell application "iTerm2"
      activate
      try
        select window id ${windowId}
      end try
    end tell
  `;
}
