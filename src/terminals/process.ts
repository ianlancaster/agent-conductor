import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PS_TIMEOUT_MS = 5_000;

export interface ProcessGroupState {
  pid: number;
  parentPid: number;
  processGroupId: number;
  foregroundProcessGroupId: number;
  command?: string;
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

/** One row of cumulative-CPU process accounting. */
export interface ProcessCpuRow {
  pid: number;
  parentPid: number;
  /** Cumulative CPU consumed since the process started, in centiseconds. */
  cpuCentiseconds: number;
}

/**
 * Parse a cumulative CPU time as `ps` reports it. Formats vary by platform and
 * by magnitude: macOS prints `MM:SS.ss` with unbounded minutes (`70:24.21` is
 * seventy minutes, not an hour and ten), while GNU `ps` rolls into `HH:MM:SS`
 * and prefixes whole days as `D-`. Returns undefined for anything it does not
 * recognise, so an unparseable row becomes a probe failure rather than a zero.
 */
export function parseCpuCentiseconds(field: string): number | undefined {
  const match = /^(?:(\d+)-)?(\d+):(\d+)(?::(\d+))?(?:\.(\d{1,2}))?$/u.exec(field.trim());
  if (match === null) return undefined;
  const [, days, first, second, third, fraction] = match;
  // With a third group the layout is HH:MM:SS; without it, MM:SS.
  const hours = third !== undefined ? Number(first) : 0;
  const minutes = third !== undefined ? Number(second) : Number(first);
  const seconds = third !== undefined ? Number(third) : Number(second);
  const centiseconds = fraction === undefined ? 0 : Number(fraction.padEnd(2, '0'));
  return ((Number(days ?? 0) * 24 + hours) * 3600 + minutes * 60 + seconds) * 100 + centiseconds;
}

/** Parse `ps -eo pid=,ppid=,time=` output. Exported for unit tests. */
export function parseProcessCpuRows(output: string): ProcessCpuRow[] {
  const rows: ProcessCpuRow[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/u.exec(line);
    if (match === null) continue;
    const [, pid, parentPid, time] = match;
    const cpuCentiseconds = parseCpuCentiseconds(time ?? '');
    if (cpuCentiseconds === undefined) continue;
    rows.push({ pid: Number(pid), parentPid: Number(parentPid), cpuCentiseconds });
  }
  return rows;
}

/**
 * Every process reachable downward from `rootPid`, including the root itself.
 * A seat's real work lives here: the agent process spawns builds, test runners
 * and tool subprocesses that never appear on the pane's tty.
 */
export function collectDescendants(rows: readonly ProcessCpuRow[], rootPid: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const siblings = children.get(row.parentPid);
    if (siblings === undefined) children.set(row.parentPid, [row.pid]);
    else siblings.push(row.pid);
  }
  const seen = new Set<number>();
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    // A pid can legitimately be its own parent's parent only in corrupt output;
    // `seen` makes the walk terminate regardless.
    stack.push(...(children.get(pid) ?? []));
  }
  return seen;
}

/**
 * CPU consumed between two samples by the processes present in BOTH of them.
 *
 * Only the stable intersection is measured, and deliberately so. A process that
 * exited during the window took its accumulated total with it, which would
 * otherwise register as a large negative delta; one that appeared during the
 * window may simply have been reparented, carrying a lifetime of unrelated CPU
 * that would register as a large positive one. Neither can be attributed to the
 * window, and this probe exists to recognise *sustained* work in flight — which
 * a stable set shows plainly.
 */
export function cpuDeltaCentiseconds(
  before: readonly ProcessCpuRow[],
  after: readonly ProcessCpuRow[],
  rootPid: number,
): { deltaCentiseconds: number; sampledProcesses: number } {
  const beforeSet = collectDescendants(before, rootPid);
  const afterSet = collectDescendants(after, rootPid);
  const beforeCpu = new Map(before.map((row) => [row.pid, row.cpuCentiseconds]));
  let deltaCentiseconds = 0;
  let sampledProcesses = 0;
  for (const row of after) {
    if (!afterSet.has(row.pid) || !beforeSet.has(row.pid)) continue;
    const previous = beforeCpu.get(row.pid);
    if (previous === undefined) continue;
    sampledProcesses += 1;
    // Clamp per process: cumulative CPU cannot fall, so a decrease means pid
    // reuse rather than negative work.
    deltaCentiseconds += Math.max(0, row.cpuCentiseconds - previous);
  }
  return { deltaCentiseconds, sampledProcesses };
}

/** Snapshot every process on the machine with its cumulative CPU. */
export async function sampleProcessCpu(): Promise<ProcessCpuRow[]> {
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,time='], { timeout: PS_TIMEOUT_MS });
  const rows = parseProcessCpuRows(stdout);
  if (rows.length === 0) throw new Error('ps returned no parseable process rows');
  return rows;
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
 * The pid of the interactive shell attached to an iTerm tty. The agent process
 * and everything it spawns sit beneath this pid, including subprocesses that
 * detached from the tty and so never appear in a tty-scoped listing.
 */
export async function ttyInteractiveShellPid(ttyPath: string): Promise<number> {
  const tty = basename(ttyPath);
  if (tty.length === 0) throw new Error('iTerm returned an empty tty path');
  const { stdout } = await execFileAsync('ps', ['-o', 'pid=,ppid=,pgid=,tpgid=,comm=', '-t', tty], {
    timeout: PS_TIMEOUT_MS,
  });
  const shell = findInteractiveShell(parseProcessGroups(stdout));
  if (shell === undefined) throw new Error(`No processes found for tty ${ttyPath}`);
  return shell.pid;
}
