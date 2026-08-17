import { randomUUID } from 'node:crypto';
import type { MutationMutexStore } from './types.js';

export class ShepherdMutationMutex {
  constructor(
    private readonly store: MutationMutexStore,
    private readonly clock: () => Date = () => new Date(),
    private readonly timeoutMs = 35_000,
    private readonly leaseMs = 300_000,
  ) {}

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const owner = `${String(process.pid)}:${randomUUID()}`;
    const deadline = Date.now() + this.timeoutMs;
    while (true) {
      const now = this.clock();
      if (
        this.store.tryAcquireMutationLock(
          owner,
          now.toISOString(),
          new Date(now.getTime() + this.leaseMs).toISOString(),
        )
      )
        break;
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the Shepherd GitHub mutation mutex.');
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    try {
      return await operation();
    } finally {
      this.store.releaseMutationLock(owner);
    }
  }
}
