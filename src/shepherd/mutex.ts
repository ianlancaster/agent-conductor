import { randomUUID } from 'node:crypto';
import type { MutationMutexStore } from './types.js';

export interface ShepherdMutationLease {
  assertOwned(): void;
}

function ownerProcessIsAlive(owner: string): boolean {
  const match = /^(\d+):/.exec(owner);
  if (match === null) return false;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export class ShepherdMutationMutex {
  constructor(
    private readonly store: MutationMutexStore,
    private readonly clock: () => Date = () => new Date(),
    private readonly timeoutMs = 35_000,
    private readonly leaseMs = 300_000,
  ) {}

  async runExclusive<T>(operation: (lease: ShepherdMutationLease) => Promise<T>): Promise<T> {
    const owner = `${String(process.pid)}:${randomUUID()}`;
    const deadline = Date.now() + this.timeoutMs;
    while (true) {
      const now = this.clock();
      const expiresAt = new Date(now.getTime() + this.leaseMs).toISOString();
      if (this.store.tryAcquireMutationLock(owner, now.toISOString(), expiresAt)) break;
      const current = this.store.getMutationLock();
      if (
        current !== undefined &&
        current.expiresAt <= now.toISOString() &&
        !ownerProcessIsAlive(current.owner) &&
        this.store.tryTakeoverMutationLock(owner, current.owner, now.toISOString(), expiresAt)
      ) {
        break;
      }
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the Shepherd GitHub mutation mutex.');
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    let lost = false;
    const renew = (): boolean => {
      if (lost) return false;
      const now = this.clock();
      try {
        if (this.store.renewMutationLock(owner, new Date(now.getTime() + this.leaseMs).toISOString())) return true;
      } catch {
        // A transient SQLite failure is treated as lost ownership. Provider mutations must fail
        // closed until a new mutex acquisition succeeds.
      }
      lost = true;
      return false;
    };
    const lease: ShepherdMutationLease = {
      assertOwned: () => {
        if (!renew()) throw new Error('Lost ownership of the Shepherd GitHub mutation mutex.');
      },
    };
    const renewal = setInterval(
      () => {
        renew();
      },
      Math.max(10, Math.floor(this.leaseMs / 3)),
    );
    renewal.unref();
    try {
      lease.assertOwned();
      const result = await operation(lease);
      lease.assertOwned();
      return result;
    } finally {
      clearInterval(renewal);
      this.store.releaseMutationLock(owner);
    }
  }
}
