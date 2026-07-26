import type { ReadStream, WriteStream } from 'node:tty';
import { PR_SHEPHERD_ONLINE_STATUS } from '../core/status.js';
import { formatTerminalReply } from './terminal-format.js';

const ALT_SCREEN_ON = '\u001b[?1049h';
const ALT_SCREEN_OFF = '\u001b[?1049l';
// Clear both the visible viewport and terminal history before every frame.
// This is the same sequence as the console's proven `/clear` implementation.
const CLEAR_SCREEN = '\u001b[2J\u001b[3J\u001b[H';
const HIDE_CURSOR = '\u001b[?25l';
const SHOW_CURSOR = '\u001b[?25h';
const BOLD = '\u001b[1m';
const NORMAL_INTENSITY = '\u001b[22m';
const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const DIM = '\u001b[2m';
const NORMAL = '\u001b[22m';
const DEFAULT_FOREGROUND = '\u001b[39m';

export const DEFAULT_STATUS_INTERVAL = '15s';

export type StatusConnection = 'checking' | 'online' | 'offline';

export interface StatusDashboardState {
  connection: StatusConnection;
  status?: string;
  updatedAt?: Date;
}

export interface StatusDashboardOptions {
  command: string;
  fleetDir: string;
  intervalMs: number;
  fetchStatus(signal: AbortSignal): Promise<string>;
  input?: ReadStream;
  output?: WriteStream;
  now?: () => Date;
}

const CANONICAL_STATUS_HEADING = 'Agent Conductor Status';
const PR_SHEPHERD_STATUS_HEADING = 'PR Shepherd Status';

function statusContent(status: string | undefined): {
  body: string | undefined;
  fleetWatchActive: boolean;
  shepherdOnline: boolean;
} {
  if (status === undefined) return { body: undefined, fleetWatchActive: false, shepherdOnline: false };
  const [firstLine, ...remaining] = status.split('\n');
  if (firstLine !== CANONICAL_STATUS_HEADING && firstLine !== `${CANONICAL_STATUS_HEADING} 🔄`) {
    return { body: status, fleetWatchActive: false, shepherdOnline: false };
  }
  const shepherdOnline = remaining[0] === PR_SHEPHERD_ONLINE_STATUS;
  if (shepherdOnline) remaining.shift();
  if (remaining[0] === '') remaining.shift();
  return { body: remaining.join('\n'), fleetWatchActive: firstLine.endsWith(' 🔄'), shepherdOnline };
}

/** Parse a dashboard refresh duration such as `2`, `2s`, or `500ms`. */
export function parseStatusInterval(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s)?$/i.exec(value.trim());
  if (match === null)
    throw new Error(`Invalid status refresh interval '${value}'. Use seconds (2s) or milliseconds (500ms).`);
  const amount = Number(match[1]);
  const milliseconds = match[2]?.toLowerCase() === 'ms' ? amount : amount * 1000;
  if (!Number.isFinite(milliseconds) || milliseconds < 250 || milliseconds > 60_000) {
    throw new Error('Status refresh interval must be between 250ms and 60s.');
  }
  return milliseconds;
}

function connectionLabel(connection: StatusConnection, colors: boolean): string {
  if (connection === 'online') return colors ? `${GREEN}● ONLINE${DEFAULT_FOREGROUND}` : '● ONLINE';
  if (connection === 'offline') return colors ? `${RED}○ OFFLINE${DEFAULT_FOREGROUND}` : '○ OFFLINE';
  return colors ? `${YELLOW}◌ CHECKING${DEFAULT_FOREGROUND}` : '◌ CHECKING';
}

function updatedLabel(state: StatusDashboardState): string {
  if (state.updatedAt === undefined) {
    return state.connection === 'offline' ? 'No successful connection yet.' : 'Contacting the conductor…';
  }
  const prefix = state.connection === 'offline' ? 'Last successful update' : 'Updated';
  return `${prefix}: ${state.updatedAt.toLocaleTimeString()}`;
}

/** Pure terminal rendering for the live view; all fleet content remains canonical `/status` output. */
export function renderStatusDashboard(
  state: StatusDashboardState,
  options: Pick<StatusDashboardOptions, 'command' | 'fleetDir' | 'intervalMs'>,
  colors: boolean,
): string {
  const canonical = statusContent(state.status);
  const heading = colors ? `${BOLD}${CANONICAL_STATUS_HEADING}${NORMAL_INTENSITY}` : CANONICAL_STATUS_HEADING;
  const fleetWatch = canonical.fleetWatchActive ? ' 🔄 fleet watch on' : '';
  const shepherd =
    state.connection === 'online' && canonical.shepherdOnline
      ? colors
        ? `${BOLD}${PR_SHEPHERD_STATUS_HEADING}${NORMAL_INTENSITY}  ${connectionLabel('online', true)}`
        : `${PR_SHEPHERD_STATUS_HEADING}  ${connectionLabel('online', false)}`
      : undefined;
  const metadata = colors
    ? `${DIM}${updatedLabel(state)} · fleet: ${options.fleetDir}${NORMAL}`
    : `${updatedLabel(state)} · fleet: ${options.fleetDir}`;
  const retry = state.connection === 'offline' ? `Retrying every ${String(options.intervalMs / 1000)}s.` : undefined;
  const status =
    canonical.body === undefined
      ? state.connection === 'offline'
        ? '(status unavailable)'
        : '(loading status…)'
      : formatTerminalReply(options.command, canonical.body, colors);
  const previous = state.connection === 'offline' && canonical.body !== undefined ? 'Last known status:' : undefined;
  const footer = colors ? `${DIM}q quit · r refresh${NORMAL}` : 'q quit · r refresh';

  return [
    `${heading}  ${connectionLabel(state.connection, colors)}${fleetWatch}`,
    ...(shepherd === undefined ? [] : [shepherd]),
    metadata,
    ...(retry === undefined ? [] : [retry]),
    '',
    ...(previous === undefined ? [] : [previous]),
    status,
    '',
    footer,
  ].join('\n');
}

/**
 * Own the current terminal until the operator quits. Refreshes are serialized;
 * a manual refresh requested during an in-flight check runs immediately after it.
 */
export async function runStatusDashboard(options: StatusDashboardOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const now = options.now ?? (() => new Date());
  const colors = output.isTTY === true;
  let state: StatusDashboardState = { connection: 'checking' };
  let stopped = false;
  let refreshing = false;
  let refreshAgain = false;
  let timer: NodeJS.Timeout | undefined;
  let requestAbort: AbortController | undefined;
  const wasRaw = input.isRaw;

  const render = (): void => {
    output.write(`${CLEAR_SCREEN}${renderStatusDashboard(state, options, colors)}`);
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => void refresh(), options.intervalMs);
    timer.unref();
  };

  const refresh = async (): Promise<void> => {
    if (stopped) return;
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const abort = new AbortController();
    requestAbort = abort;
    try {
      const status = await options.fetchStatus(abort.signal);
      state = { connection: 'online', status, updatedAt: now() };
    } catch {
      state = {
        connection: 'offline',
        ...(state.status !== undefined ? { status: state.status } : {}),
        ...(state.updatedAt !== undefined ? { updatedAt: state.updatedAt } : {}),
      };
    } finally {
      refreshing = false;
      if (requestAbort === abort) requestAbort = undefined;
    }
    if (stopped) return;
    render();
    if (refreshAgain) {
      refreshAgain = false;
      void refresh();
    } else {
      schedule();
    }
  };

  let finish: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    requestAbort?.abort();
    finish?.();
  };
  const onData = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    if (text.includes('q') || text.includes('Q') || text.includes('\u0003')) {
      stop();
    } else if (text.includes('r') || text.includes('R')) {
      void refresh();
    }
  };
  const onResize = (): void => render();

  output.write(`${ALT_SCREEN_ON}${HIDE_CURSOR}`);
  render();
  if (input.isTTY) {
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.on('SIGWINCH', onResize);
  void refresh();

  try {
    await done;
  } finally {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    input.off('data', onData);
    if (input.isTTY) {
      input.setRawMode(wasRaw);
      input.pause();
    }
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    process.off('SIGWINCH', onResize);
    output.write(`${SHOW_CURSOR}${ALT_SCREEN_OFF}`);
  }
}
