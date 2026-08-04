import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Placement } from '../../core/types.js';

const execFileAsync = promisify(execFile);

/** Hard timeout for any tmux invocation so a hung server can't wedge the heartbeat loop. */
const TMUX_TIMEOUT_MS = 15_000;

/** Error from a tmux invocation, including tmux's stderr when available. */
export class TmuxError extends Error {
  constructor(args: readonly string[], cause: string) {
    super(`tmux ${args.join(' ')} failed: ${cause}`);
    this.name = 'TmuxError';
  }
}

function describeExecError(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const e = error as { stderr?: unknown; message?: unknown };
    const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
    const message = typeof e.message === 'string' ? e.message : 'unknown error';
    return stderr.length > 0 ? `${message} (stderr: ${stderr})` : message;
  }
  return String(error);
}

/**
 * Run a tmux command and return its stdout. Arguments are passed as an
 * execFile array — never through a shell — so no quoting/escaping is needed.
 */
export async function tmux(args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('tmux', [...args], { timeout: TMUX_TIMEOUT_MS });
    return stdout;
  } catch (error) {
    throw new TmuxError(args, describeExecError(error));
  }
}

/**
 * Whether a tmux failure means "there is no server", which is a real answer
 * about the panes (there are none), as opposed to "tmux could not be asked",
 * which is no answer at all. Liveness checks must not read the second as the
 * first: a timed-out `list-panes` would otherwise report every live pane dead.
 */
export function isNoServerError(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes('no server running') ||
    text.includes('error connecting to') ||
    text.includes('no current client') ||
    text.includes('server exited unexpectedly')
  );
}

/** Run a tmux command purely for its exit status (e.g. `has-session`). */
export async function tmuxSucceeds(args: readonly string[]): Promise<boolean> {
  try {
    await tmux(args);
    return true;
  } catch {
    return false;
  }
}

// ── pure helpers (no tmux required; unit-tested) ─────────────────────────────

/** Pane-scoped tmux user option used to mark which session owns a pane. */
export const SESSION_OPTION = '@conductor_session';

/**
 * Marker value stored in SESSION_OPTION: `<fleetId>:<codename>`. The fleet id
 * scopes the marker — `list-panes -a` scans the whole tmux server, which may
 * host several conductors' sessions, and rediscovery must only ever adopt
 * this fleet's panes.
 */
export function encodeSessionOption(fleetId: string, codename: string): string {
  return `${fleetId}:${codename}`;
}

/** Parse `list-panes -a -F '#{pane_id}'` output into pane ids (e.g. `%3`). */
export function parsePaneIds(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('%'));
}

/**
 * Parse writable tmux clients attached to one session. Delivery briefly makes
 * these clients read-only while it verifies and submits an empty composer, so
 * physical keyboard input cannot land between the two operations. Clients
 * that were already read-only are deliberately omitted and never modified.
 */
export function parseWritableClients(output: string, sessionId: string): string[] {
  const clients = new Set<string>();
  for (const line of output.split('\n')) {
    const [name, clientSessionId, rawFlags = ''] = line.split('\t');
    if (name === undefined || name.length === 0 || clientSessionId !== sessionId) continue;
    const flags = new Set(rawFlags.split(',').map((flag) => flag.trim()));
    if (!flags.has('read-only')) clients.add(name);
  }
  return [...clients];
}

/**
 * Parse `list-panes -a -F '#{pane_id} #{@conductor_session}'` output into a
 * codename -> pane id map for THIS fleet only. Panes without a marker, or
 * marked by another fleet, are skipped. If two panes carry the same codename,
 * the last one listed wins.
 */
export function parseSessionPanes(output: string, fleetId: string): Map<string, string> {
  const result = new Map<string, string>();
  const prefix = `${fleetId}:`;
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('%')) continue;
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) continue; // pane id only — no marker
    const paneId = line.slice(0, spaceIdx);
    const marker = line.slice(spaceIdx + 1).trim();
    if (!marker.startsWith(prefix)) continue;
    const session = marker.slice(prefix.length);
    if (session.length === 0) continue;
    result.set(session, paneId);
  }
  return result;
}

export interface CreateTmuxSessionSpec {
  sessionName: string;
  /** Name for the initial tmux window. */
  windowName: string;
  cwd?: string;
}

/**
 * Create the detached tmux session AND hand its unavoidable initial pane to
 * the caller (`-P -F '#{pane_id}'` prints it). The first conductor session
 * claims that pane instead of splitting, so the tmux session never carries an
 * unexplained empty shell.
 */
export function buildCreateSessionArgs(spec: CreateTmuxSessionSpec): string[] {
  const cwdArgs = spec.cwd !== undefined ? ['-c', spec.cwd] : [];
  return ['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', spec.sessionName, '-n', spec.windowName, ...cwdArgs];
}

export interface CreatePaneSpec {
  placement: Placement;
  sessionName: string;
  /** Used as the window name for 'tab'/'window' placements. */
  session: string;
  cwd?: string;
}

/**
 * Map a conductor Placement to a tmux command.
 *
 * - 'pane'   -> `split-window` on the session's first window (`{start}` token,
 *               robust against non-zero `base-index`).
 * - 'tab'    -> `new-window` (a tmux window is the analogue of a tab).
 * - 'window' -> also `new-window`: tmux is a single-server multiplexer with no
 *               concept of separate OS windows, so 'window' degrades to a new
 *               tmux window.
 *
 * All variants use `-P -F '#{pane_id}'` so the new pane id is printed, and
 * `-d` so the currently active pane is left untouched. The trailing-colon
 * target (`session:`) tells tmux to pick the next unused window index.
 */
export function buildCreatePaneArgs(spec: CreatePaneSpec): string[] {
  const cwdArgs = spec.cwd !== undefined ? ['-c', spec.cwd] : [];
  // `=name` forces an exact session match so we never target a user's
  // prefix-colliding session (e.g. `conductor-dev`).
  const session = `=${spec.sessionName}`;
  switch (spec.placement) {
    case 'pane':
      return ['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', `${session}:{start}`, ...cwdArgs];
    case 'tab':
    case 'window':
      return ['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', `${session}:`, '-n', spec.session, ...cwdArgs];
  }
}

export interface CreateAttachedPaneSpec {
  placement: Placement;
  /** Pane id of the conductor console's own tmux pane ($TMUX_PANE). */
  attachPane: string;
  /** Name of the tmux session that owns attachPane (for tab/window placements). */
  targetSession: string;
  /** Used as the window name for 'tab'/'window' placements. */
  session: string;
  cwd?: string;
}

/**
 * Attached-mode variant of buildCreatePaneArgs: the conductor was launched
 * from inside tmux, so panes join the OPERATOR'S session instead of a
 * detached one — 'pane' splits the console's own window (like the iTerm
 * backend splitting the conductor window), 'tab'/'window' add a tmux window
 * to the console's session.
 */
export function buildAttachedPaneArgs(spec: CreateAttachedPaneSpec): string[] {
  const cwdArgs = spec.cwd !== undefined ? ['-c', spec.cwd] : [];
  switch (spec.placement) {
    case 'pane':
      return ['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', spec.attachPane, ...cwdArgs];
    case 'tab':
    case 'window':
      return [
        'new-window',
        '-d',
        '-P',
        '-F',
        '#{pane_id}',
        '-t',
        `=${spec.targetSession}:`,
        '-n',
        spec.session,
        ...cwdArgs,
      ];
  }
}

/**
 * Per-pane buffer name for multiline paste delivery. Deriving it from the pane
 * id (e.g. `%3` → `conductor-paste-3`) keeps concurrent deliveries to different
 * panes from clobbering each other's buffer mid-paste.
 */
export function pasteBufferName(paneId: string): string {
  return `conductor-paste-${paneId.replace(/[^a-zA-Z0-9]/g, '')}`;
}

/**
 * Build the sequence of tmux commands that delivers `text` to a pane and
 * presses Enter.
 *
 * Single-line text goes through `send-keys -l --` (literal flag, `--` so text
 * beginning with `-` is not parsed as an option). Multiline text is loaded
 * into a named buffer and pasted with `paste-buffer -p` (bracketed paste), so
 * embedded newlines are not interpreted as submit keystrokes; `-d` deletes
 * the buffer after the paste. Enter is always a separate `send-keys` call.
 */
export function buildDeliveryCommands(paneId: string, text: string): string[][] {
  const enter = ['send-keys', '-t', paneId, 'Enter'];
  // Carriage returns take the literal path otherwise and a raw \r submits
  // mid-message, so treat any embedded newline OR CR as multiline.
  if (/[\n\r]/.test(text)) {
    const buffer = pasteBufferName(paneId);
    return [['set-buffer', '-b', buffer, '--', text], ['paste-buffer', '-d', '-p', '-b', buffer, '-t', paneId], enter];
  }
  return [['send-keys', '-t', paneId, '-l', '--', text], enter];
}

/**
 * Whether a pane capture ends in something that looks like a shell prompt.
 *
 * tmux trims trailing whitespace from captured lines, so we match the last
 * non-empty line *ending* with one of the marker characters ($ % # ❯) rather
 * than requiring a trailing space. A `%` preceded by a digit is excluded so
 * progress output like `42%` is not mistaken for a zsh prompt.
 */
export function hasShellPrompt(capture: string): boolean {
  const lines = capture
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) return false;
  // `>` covers custom prompts like `myproject ==>`; a false positive only means
  // delivering slightly early — the same behavior as the poll-timeout fallback.
  return /(?:(?<!\d)%|[$#❯>])$/.test(last);
}

/** Trailing `lines` lines of `text`, with trailing blank lines stripped first. */
export function trimToTrailingLines(text: string, lines: number): string {
  const all = text.split('\n');
  let end = all.length;
  while (end > 0) {
    const line = all[end - 1];
    if (line !== undefined && line.trim().length > 0) break;
    end -= 1;
  }
  return all.slice(Math.max(0, end - lines), end).join('\n');
}
