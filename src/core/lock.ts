import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface FleetLockOwner {
  pid: number;
  startedAt: string;
  /** Added for fleet-scoped recovery commands; absent on pre-upgrade lockfiles. */
  fleetDir?: string;
  /** OS process birth identity protects recovery commands from PID reuse. */
  processStartToken?: string;
}

/** Read the current lock owner. Invalid or missing lockfiles have no trustworthy owner. */
export function readFleetLock(path: string): FleetLockOwner | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<FleetLockOwner>;
    if (typeof parsed.pid !== 'number' || !Number.isSafeInteger(parsed.pid) || parsed.pid < 1) return undefined;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : 'unknown',
      ...(typeof parsed.fleetDir === 'string' ? { fleetDir: resolve(parsed.fleetDir) } : {}),
      ...(typeof parsed.processStartToken === 'string' ? { processStartToken: parsed.processStartToken } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Remove a stale lock only while it still names the expected process. */
export function clearFleetLock(path: string, expectedPid: number): boolean {
  if (readFleetLock(path)?.pid !== expectedPid) return false;
  rmSync(path, { force: true });
  return true;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by someone else — alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Stable for one OS process lifetime on macOS/Linux; undefined when unavailable. */
export function processStartToken(pid: number): string | undefined {
  try {
    const value = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pid lockfile guarding a fleet directory: two conductors managing the same
 * data dir (same SQLite store, same panes) would fight each other, so the
 * second one refuses to start. Stale locks — a conductor that died without
 * releasing — are detected by pid liveness and reclaimed.
 *
 * Different fleet dirs have different lock paths and never interact.
 */
export class FleetLock {
  private held = false;

  constructor(
    private readonly path: string,
    private readonly pid: number = process.pid,
    private readonly fleetDir?: string,
  ) {}

  /** Acquire the lock or throw a descriptive error naming the holder. */
  acquire(): void {
    const existing = this.read();
    const currentStartToken = existing?.processStartToken === undefined ? undefined : processStartToken(existing.pid);
    const existingProcessMatches =
      existing?.processStartToken === undefined ||
      currentStartToken === undefined ||
      currentStartToken === existing.processStartToken;
    if (existing !== undefined && existing.pid !== this.pid && isProcessAlive(existing.pid) && existingProcessMatches) {
      throw new Error(
        `Another conductor (pid ${String(existing.pid)}, since ${existing.startedAt}) is already running this fleet directory. ` +
          `Stop it first, or use a separate fleet directory (each fleet needs its own).`,
      );
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const startToken = processStartToken(this.pid);
    const payload: FleetLockOwner = {
      pid: this.pid,
      startedAt: new Date().toISOString(),
      ...(this.fleetDir !== undefined ? { fleetDir: resolve(this.fleetDir) } : {}),
      ...(startToken !== undefined ? { processStartToken: startToken } : {}),
    };
    writeFileSync(this.path, JSON.stringify(payload));
    this.held = true;
  }

  /** Release the lock if this instance holds it. Safe to call repeatedly. */
  release(): void {
    if (!this.held) return;
    this.held = false;
    // Only remove our own lock — a newer conductor may have reclaimed a stale one.
    clearFleetLock(this.path, this.pid);
  }

  private read(): FleetLockOwner | undefined {
    return readFleetLock(this.path);
  }
}
