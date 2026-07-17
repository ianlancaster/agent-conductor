import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface LockPayload {
  pid: number;
  startedAt: string;
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
  ) {}

  /** Acquire the lock or throw a descriptive error naming the holder. */
  acquire(): void {
    const existing = this.read();
    if (existing !== undefined && existing.pid !== this.pid && isProcessAlive(existing.pid)) {
      throw new Error(
        `Another conductor (pid ${String(existing.pid)}, since ${existing.startedAt}) is already running this fleet directory. ` +
          `Stop it first, or use a separate fleet directory (each fleet needs its own).`,
      );
    }
    mkdirSync(dirname(this.path), { recursive: true });
    const payload: LockPayload = { pid: this.pid, startedAt: new Date().toISOString() };
    writeFileSync(this.path, JSON.stringify(payload));
    this.held = true;
  }

  /** Release the lock if this instance holds it. Safe to call repeatedly. */
  release(): void {
    if (!this.held) return;
    this.held = false;
    // Only remove our own lock — a newer conductor may have reclaimed a stale one.
    if (this.read()?.pid === this.pid) {
      rmSync(this.path, { force: true });
    }
  }

  private read(): LockPayload | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<LockPayload>;
      if (typeof parsed.pid !== 'number') return undefined;
      return { pid: parsed.pid, startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : 'unknown' };
    } catch {
      // Corrupt lockfile — treat as stale.
      return undefined;
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by someone else — alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
