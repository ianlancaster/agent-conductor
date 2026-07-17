import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FleetLock } from '../src/core/lock.js';

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conductor-lock-'));
  lockPath = join(dir, 'data', 'conductor.lock');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Pid of a process that existed but is certainly dead now. */
function deadPid(): number {
  const result = spawnSync('true');
  if (result.pid === undefined) throw new Error('could not spawn a process');
  return result.pid;
}

describe('FleetLock', () => {
  it('acquires, writes its pid, and releases', () => {
    const lock = new FleetLock(lockPath);
    lock.acquire();
    expect((JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number }).pid).toBe(process.pid);
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('refuses to acquire while a live process holds the lock', () => {
    const first = new FleetLock(lockPath);
    first.acquire();
    // A different "conductor" (distinct pid) targeting the same fleet dir.
    const second = new FleetLock(lockPath, process.pid + 1_000_000);
    expect(() => {
      second.acquire();
    }).toThrow(/Another conductor \(pid \d+/);
    first.release();
  });

  it('reclaims a stale lock left by a dead process', () => {
    const stale = new FleetLock(lockPath, deadPid());
    stale.acquire();
    const lock = new FleetLock(lockPath);
    lock.acquire(); // must not throw
    expect((JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number }).pid).toBe(process.pid);
    lock.release();
  });

  it('reclaims a corrupt lockfile', () => {
    const lock = new FleetLock(lockPath);
    lock.acquire();
    lock.release();
    writeFileSync(lockPath, 'not json at all');
    lock.acquire(); // must not throw
    lock.release();
  });

  it('does not delete a newer holder’s lock on release', () => {
    const original = new FleetLock(lockPath, deadPid());
    original.acquire();
    // A new conductor reclaims the stale lock...
    const successor = new FleetLock(lockPath);
    successor.acquire();
    // ...then the zombie's release must leave the successor's lock intact.
    original.release();
    expect((JSON.parse(readFileSync(lockPath, 'utf8')) as { pid: number }).pid).toBe(process.pid);
    successor.release();
  });

  it('release is idempotent and safe before acquire', () => {
    const lock = new FleetLock(lockPath);
    lock.release();
    lock.acquire();
    lock.release();
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });
});
