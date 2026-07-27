import { execFileSync } from 'node:child_process';
import { existsSync, readlinkSync, realpathSync } from 'node:fs';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { clearFleetLock, isProcessAlive, processStartToken, readFleetLock } from '../core/lock.js';

const GRACEFUL_TIMEOUT_MS = 5_000;
const FORCE_TIMEOUT_MS = 2_000;
const EXIT_POLL_MS = 100;

interface KillDependencies {
  isAlive(pid: number): boolean;
  matchesFleet(pid: number, fleetDir: string): boolean;
  startToken(pid: number): string | undefined;
  signal(pid: number, signal: NodeJS.Signals): void;
  waitForExit(pid: number, timeoutMs: number): Promise<boolean>;
}

export interface KillConductorResult {
  outcome: 'not-running' | 'stale-lock-cleared' | 'terminated' | 'killed';
  message: string;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function processCommand(pid: number): string | undefined {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function processWorkingDirectory(pid: number): string | undefined {
  if (platform() === 'linux') {
    try {
      return readlinkSync(`/proc/${String(pid)}/cwd`);
    } catch {
      return undefined;
    }
  }
  if (platform() === 'darwin') {
    try {
      const output = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const pathLine = output.split('\n').find((line) => line.startsWith('n'));
      return pathLine?.slice(1);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Guard against PID reuse before signaling a lock owner. Interactive starts
 * carry the fleet path in argv; daemon starts carry it as their cwd.
 */
export function processMatchesFleetConductor(pid: number, fleetDir: string): boolean {
  const command = processCommand(pid);
  if (command === undefined) return false;
  if (!command.includes('conductor') || !/(?:^|\s)start(?:\s|$)/u.test(command) || !command.includes('--foreground')) {
    return false;
  }

  const expected = canonicalPath(fleetDir);
  const cwd = processWorkingDirectory(pid);
  if (cwd !== undefined && canonicalPath(cwd) === expected) return true;

  // `conductor start` spawns its child with `-C <absolute fleet path>`.
  // Comparing the full resolved path, not a basename, keeps fleets distinct.
  return command.includes(resolve(fleetDir)) || command.includes(expected);
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(EXIT_POLL_MS);
  }
  return true;
}

const DEFAULT_DEPENDENCIES: KillDependencies = {
  isAlive: isProcessAlive,
  matchesFleet: processMatchesFleetConductor,
  startToken: processStartToken,
  signal: (pid, signal) => process.kill(pid, signal),
  waitForExit: waitForProcessExit,
};

/** Terminate only the process identified by this fleet's ownership lock. */
export async function killFleetConductor(
  fleetDir: string,
  lockPath: string,
  dependencies: Partial<KillDependencies> = {},
): Promise<KillConductorResult> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const lockExists = existsSync(lockPath);
  const owner = readFleetLock(lockPath);
  if (owner === undefined) {
    if (lockExists) {
      throw new Error(
        `Cannot safely identify this fleet's Conductor because ${lockPath} is invalid. ` +
          'Inspect the file and process list before removing it; no process was signaled.',
      );
    }
    return { outcome: 'not-running', message: 'No Conductor is running for this fleet.' };
  }

  const expectedFleetDir = canonicalPath(fleetDir);
  if (owner.fleetDir !== undefined && canonicalPath(owner.fleetDir) !== expectedFleetDir) {
    throw new Error(
      `Refusing to signal pid ${String(owner.pid)}: the fleet lock belongs to ${owner.fleetDir}, not ${expectedFleetDir}.`,
    );
  }

  if (!deps.isAlive(owner.pid)) {
    clearFleetLock(lockPath, owner.pid);
    return {
      outcome: 'stale-lock-cleared',
      message: `No Conductor process is running; removed stale fleet lock for pid ${String(owner.pid)}.`,
    };
  }

  const processIdentityMatches =
    owner.processStartToken !== undefined
      ? deps.startToken(owner.pid) === owner.processStartToken
      : deps.matchesFleet(owner.pid, expectedFleetDir);
  if (!processIdentityMatches) {
    throw new Error(
      `Refusing to signal pid ${String(owner.pid)} because it does not match this fleet's Conductor process. ` +
        'The lock may contain a recycled PID; no process was signaled.',
    );
  }

  try {
    deps.signal(owner.pid, 'SIGTERM');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') throw error;
  }
  if (await deps.waitForExit(owner.pid, GRACEFUL_TIMEOUT_MS)) {
    clearFleetLock(lockPath, owner.pid);
    return {
      outcome: 'terminated',
      message: `Stopped this fleet's Conductor (pid ${String(owner.pid)}). Session panes were left running.`,
    };
  }

  deps.signal(owner.pid, 'SIGKILL');
  if (!(await deps.waitForExit(owner.pid, FORCE_TIMEOUT_MS))) {
    throw new Error(`Conductor pid ${String(owner.pid)} is still alive after SIGKILL; the fleet lock was preserved.`);
  }
  clearFleetLock(lockPath, owner.pid);
  return {
    outcome: 'killed',
    message: `Force-killed this fleet's unresponsive Conductor (pid ${String(owner.pid)}). Session panes were left running.`,
  };
}
