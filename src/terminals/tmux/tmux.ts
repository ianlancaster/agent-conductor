import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Placement } from '../../core/types.js';

const execFileAsync = promisify(execFile);

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
    const { stdout } = await execFileAsync('tmux', [...args]);
    return stdout;
  } catch (error) {
    throw new TmuxError(args, describeExecError(error));
  }
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

/** Pane-scoped tmux user option used to mark which agent owns a pane. */
export const AGENT_OPTION = '@conductor_agent';

/** Parse `list-panes -a -F '#{pane_id}'` output into pane ids (e.g. `%3`). */
export function parsePaneIds(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('%'));
}

/**
 * Parse `list-panes -a -F '#{pane_id} #{@conductor_agent}'` output into a
 * codename -> pane id map. Panes without a marker are skipped. If two panes
 * carry the same codename, the last one listed wins.
 */
export function parseAgentPanes(output: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('%')) continue;
    const spaceIdx = line.indexOf(' ');
    if (spaceIdx === -1) continue; // pane id only — no marker
    const paneId = line.slice(0, spaceIdx);
    const agent = line.slice(spaceIdx + 1).trim();
    if (agent.length === 0) continue;
    result.set(agent, paneId);
  }
  return result;
}

export interface CreatePaneSpec {
  placement: Placement;
  sessionName: string;
  /** Used as the window name for 'tab'/'window' placements. */
  agent: string;
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
  switch (spec.placement) {
    case 'pane':
      return ['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', `${spec.sessionName}:{start}`, ...cwdArgs];
    case 'tab':
    case 'window':
      return ['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', `${spec.sessionName}:`, '-n', spec.agent, ...cwdArgs];
  }
}

/** Buffer name used for multiline paste delivery so we never clobber buffer 0. */
export const PASTE_BUFFER = 'conductor-paste';

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
  if (text.includes('\n')) {
    return [
      ['set-buffer', '-b', PASTE_BUFFER, '--', text],
      ['paste-buffer', '-d', '-p', '-b', PASTE_BUFFER, '-t', paneId],
      enter,
    ];
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
