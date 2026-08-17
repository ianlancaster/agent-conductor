import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ShepherdMutationMutex } from '../src/shepherd/mutex.js';
import { SqliteShepherdStore } from '../src/shepherd/store.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Shepherd GitHub mutation mutex', () => {
  it('serializes operations across independent store connections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-mutex-'));
    dirs.push(dir);
    const path = join(dir, 'shepherd.db');
    const firstStore = new SqliteShepherdStore(path);
    const secondStore = new SqliteShepherdStore(path);
    const firstMutex = new ShepherdMutationMutex(firstStore);
    const secondMutex = new ShepherdMutationMutex(secondStore);
    const order: string[] = [];
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });

    const first = firstMutex.runExclusive(async () => {
      order.push('first-start');
      firstStarted();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push('first-end');
    });
    await started;
    const second = secondMutex.runExclusive(async () => {
      order.push('second');
    });
    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
    firstStore.close();
    secondStore.close();
  });

  it('recovers an expired crash lease and releases the lock after failure', async () => {
    const store = new SqliteShepherdStore(':memory:');
    expect(store.tryAcquireMutationLock('crashed-owner', '2026-08-17T09:00:00.000Z', '2026-08-17T09:01:00.000Z')).toBe(
      true,
    );
    const clock = () => new Date('2026-08-17T10:00:00.000Z');
    const mutex = new ShepherdMutationMutex(store, clock);
    await expect(
      mutex.runExclusive(async () => {
        throw new Error('operation failed');
      }),
    ).rejects.toThrow('operation failed');
    await expect(mutex.runExclusive(async () => 'recovered')).resolves.toBe('recovered');
    store.close();
  });
});
