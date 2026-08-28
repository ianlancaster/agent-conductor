import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PS_TIMEOUT_MS = 5_000;
const PS_MAX_BUFFER = 1024 * 1024;

export interface ProcessGroupState {
  pid: number;
  parentPid: number;
  processGroupId: number;
  foregroundProcessGroupId: number;
  command?: string;
}

export interface TtyProcessGroupState extends ProcessGroupState {
  tty: string;
}

/** Parse `ps -o pid=,ppid=,pgid=,tpgid=,comm=` output. Exported for unit tests. */
export function parseProcessGroups(output: string): ProcessGroupState[] {
  const rows: ProcessGroupState[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)(?:\s+(.+?))?\s*$/.exec(line);
    if (match === null) continue;
    const [, pid, parentPid, processGroupId, foregroundProcessGroupId, command] = match;
    const row: ProcessGroupState = {
      pid: Number(pid),
      parentPid: Number(parentPid),
      processGroupId: Number(processGroupId),
      foregroundProcessGroupId: Number(foregroundProcessGroupId),
    };
    if (command !== undefined) row.command = command;
    rows.push(row);
  }
  return rows;
}

/** Parse the multi-tty liveness form of ps output. Exported for unit tests. */
export function parseTtyProcessGroups(output: string): TtyProcessGroupState[] {
  const rows: TtyProcessGroupState[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)(?:\s+(.+?))?\s*$/.exec(line);
    if (match === null) continue;
    const [, pid, parentPid, processGroupId, foregroundProcessGroupId, tty, command] = match;
    if (tty === undefined) continue;
    rows.push({
      pid: Number(pid),
      parentPid: Number(parentPid),
      processGroupId: Number(processGroupId),
      foregroundProcessGroupId: Number(foregroundProcessGroupId),
      tty,
      ...(command === undefined ? {} : { command }),
    });
  }
  return rows;
}

/** Classify each requested tty independently; omitted ttys remain unknown. */
export function foregroundJobsByTty(
  rows: readonly TtyProcessGroupState[],
  requestedTtys: readonly string[],
): ReadonlyMap<string, boolean> {
  const byTty = new Map<string, ProcessGroupState[]>();
  for (const row of rows) {
    const tty = basename(row.tty);
    const grouped = byTty.get(tty) ?? [];
    grouped.push(row);
    byTty.set(tty, grouped);
  }
  const result = new Map<string, boolean>();
  for (const tty of requestedTtys) {
    const shell = findInteractiveShell(byTty.get(tty) ?? []);
    if (shell !== undefined) result.set(tty, hasForegroundJob(shell));
  }
  return result;
}

/**
 * An interactive shell owns the terminal's foreground process group while it
 * is sitting at its prompt. A launched job (Claude, Codex, or any other
 * foreground process) takes that foreground group until it exits or is
 * interrupted. This distinguishes an agent process from its still-open pane
 * without relying on runtime-specific executable names.
 */
export function hasForegroundJob(shell: ProcessGroupState): boolean {
  return shell.foregroundProcessGroupId > 0 && shell.foregroundProcessGroupId !== shell.processGroupId;
}

const SHELL_COMMANDS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'nu', 'xonsh', 'elvish']);

function commandName(command: string | undefined): string | undefined {
  if (command === undefined) return undefined;
  return basename(command).replace(/^-+/, '');
}

/**
 * Select the actual interactive shell from all processes on an iTerm tty.
 * macOS normally inserts `/usr/bin/login` above it, so choosing the root tty
 * process produces a false "active" result even when zsh is at its prompt.
 */
export function findInteractiveShell(rows: ProcessGroupState[]): ProcessGroupState | undefined {
  const knownShells = rows.filter((row) => SHELL_COMMANDS.has(commandName(row.command) ?? ''));
  if (knownShells.length > 0) {
    return knownShells.sort((a, b) => a.pid - b.pid)[0];
  }

  const pids = new Set(rows.map((row) => row.pid));
  const roots = rows.filter((row) => !pids.has(row.parentPid));
  const login = roots.find((row) => commandName(row.command) === 'login');
  if (login !== undefined) {
    const child = rows.find((row) => row.parentPid === login.pid && row.pid === row.processGroupId);
    if (child !== undefined) return child;
  }
  return roots.sort((a, b) => a.pid - b.pid)[0];
}

/** Check a known interactive shell PID (tmux exposes this as `pane_pid`). */
export async function shellHasForegroundJob(shellPid: number): Promise<boolean> {
  const { stdout } = await execFileAsync('ps', ['-o', 'pid=,ppid=,pgid=,tpgid=', '-p', String(shellPid)], {
    timeout: PS_TIMEOUT_MS,
  });
  const shell = parseProcessGroups(stdout)[0];
  if (shell === undefined) throw new Error(`No process metadata for shell PID ${String(shellPid)}`);
  return hasForegroundJob(shell);
}

/**
 * Find the interactive shell attached to an iTerm tty, then compare its
 * process group with the tty's foreground process group.
 */
export async function ttyHasForegroundJob(ttyPath: string): Promise<boolean> {
  const tty = basename(ttyPath);
  if (tty.length === 0) throw new Error('iTerm returned an empty tty path');
  const { stdout } = await execFileAsync('ps', ['-o', 'pid=,ppid=,pgid=,tpgid=,comm=', '-t', tty], {
    timeout: PS_TIMEOUT_MS,
  });
  const rows = parseProcessGroups(stdout);
  const shell = findInteractiveShell(rows);
  if (shell === undefined) throw new Error(`No processes found for tty ${ttyPath}`);
  return hasForegroundJob(shell);
}

/**
 * Inspect all requested iTerm ttys with one bounded ps subprocess. The result
 * is keyed by normalized tty basename; missing/unusable rows are omitted so
 * callers can represent activity as unknown without guessing.
 */
export async function ttysHaveForegroundJobs(ttyPaths: readonly string[]): Promise<ReadonlyMap<string, boolean>> {
  const ttys = [
    ...new Set(
      ttyPaths.map((ttyPath) => basename(ttyPath)).filter((tty) => tty.length > 0 && /^[A-Za-z0-9._-]+$/.test(tty)),
    ),
  ];
  if (ttys.length === 0) return new Map();
  const { stdout } = await execFileAsync(
    '/bin/ps',
    ['-o', 'pid=,ppid=,pgid=,tpgid=,tty=,comm=', '-t', ttys.join(',')],
    { timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER },
  );
  return foregroundJobsByTty(parseTtyProcessGroups(stdout), ttys);
}
