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

  it('renews a short lease throughout a long asynchronous operation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-mutex-renewal-'));
    dirs.push(dir);
    const path = join(dir, 'shepherd.db');
    const firstStore = new SqliteShepherdStore(path);
    const secondStore = new SqliteShepherdStore(path);
    const firstMutex = new ShepherdMutationMutex(firstStore, () => new Date(), 1_000, 30);
    const secondMutex = new ShepherdMutationMutex(secondStore, () => new Date(), 1_000, 30);
    const order: string[] = [];
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });

    const first = firstMutex.runExclusive(async () => {
      order.push('first-start');
      firstStarted();
      await new Promise<void>((resolve) => setTimeout(resolve, 120));
      order.push('first-end');
    });
    await started;
    const second = secondMutex.runExclusive(async () => {
      order.push('second');
    });

    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
    firstStore.close();
    secondStore.close();
  });

  it('does not steal an expired lease from a still-live owner process', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const liveOwner = `${String(process.pid)}:suspended-operation`;
    expect(store.tryAcquireMutationLock(liveOwner, '2026-08-17T09:00:00.000Z', '2026-08-17T09:00:00.001Z')).toBe(true);
    const mutex = new ShepherdMutationMutex(store, () => new Date('2026-08-17T10:00:00.000Z'), 25, 10);

    await expect(mutex.runExclusive(async () => undefined)).rejects.toThrow(
      'Timed out waiting for the Shepherd GitHub mutation mutex.',
    );
    expect(store.getMutationLock()?.owner).toBe(liveOwner);
    store.releaseMutationLock(liveOwner);
    await expect(mutex.runExclusive(async () => 'acquired')).resolves.toBe('acquired');
    store.close();
  });

  it('fails closed when durable ownership is lost during an operation', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const mutex = new ShepherdMutationMutex(store, () => new Date(), 1_000, 300);
    let resume!: () => void;
    let started!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const running = mutex.runExclusive(async () => {
      started();
      await new Promise<void>((resolve) => {
        resume = resolve;
      });
      return 'must-not-commit';
    });
    await operationStarted;
    const owner = store.getMutationLock()?.owner;
    expect(owner).toBeDefined();
    if (owner === undefined) throw new Error('expected acquired mutation owner');
    store.releaseMutationLock(owner);
    resume();

    await expect(running).rejects.toThrow('Lost ownership of the Shepherd GitHub mutation mutex.');
    store.close();
  });
});
