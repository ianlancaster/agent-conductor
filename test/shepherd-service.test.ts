import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseShepherdConfig } from '../src/shepherd/config.js';
import { buildEvent } from '../src/shepherd/events.js';
import { ShepherdService } from '../src/shepherd/service.js';
import { SqliteShepherdStore } from '../src/shepherd/store.js';
import { PermanentDeliveryError, type CoordinatorSink, type OutboxItem } from '../src/shepherd/types.js';

afterEach(() => {
  vi.useRealTimers();
});

function service(store: SqliteShepherdStore, sink: CoordinatorSink): ShepherdService {
  const config = parseShepherdConfig({ version: 2, profile: { githubUser: 'octocat' } });
  return new ShepherdService(
    config,
    { pollOnce: () => Promise.resolve({ discovered: 0, emitted: 0, mutations: 0, warnings: [] }) },
    store,
    sink,
  );
}

function seed(store: SqliteShepherdStore): void {
  const config = parseShepherdConfig({ version: 2, profile: { githubUser: 'octocat' } });
  const event = buildEvent(config, 'comment', { repo: 'acme/api', number: 1 }, { commentId: '1' }, { author: 'sam' });
  store.commit([], [event], 'coord');
}

describe('Shepherd outbox delivery', () => {
  it('retries an ambiguous failure with the exact persisted idempotency key', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));
    const store = new SqliteShepherdStore(':memory:');
    seed(store);
    const keys: string[] = [];
    let attempts = 0;
    const sink: CoordinatorSink = {
      send: (item: OutboxItem) => {
        keys.push(item.idempotencyKey);
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error('ambiguous timeout'));
        return Promise.resolve({
          messageId: 9,
          recipient: item.recipient,
          status: attempts === 2 ? 'queued' : 'delivered',
          deduplicated: true,
        });
      },
    };
    const worker = service(store, sink);
    await worker.drainOutbox();
    vi.advanceTimersByTime(1_000);
    await worker.drainOutbox();
    vi.advanceTimersByTime(2_000);
    await worker.drainOutbox();
    expect(keys).toEqual([keys[0], keys[0], keys[0]]);
    expect(store.listOutbox()).toEqual([]);
    store.close();
  });

  it('parks permanent recipient validation failures instead of consuming retries', async () => {
    const store = new SqliteShepherdStore(':memory:');
    seed(store);
    let sends = 0;
    const worker = service(store, {
      send: () => {
        sends += 1;
        return Promise.reject(new PermanentDeliveryError('Unknown session: coord'));
      },
    });
    await worker.drainOutbox();
    await worker.drainOutbox();
    expect(sends).toBe(1);
    expect(store.listOutbox()).toHaveLength(1);
    store.close();
  });

  it('attempts each due outbox item only once per drain when delivery is slow and failing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-20T00:00:00Z'));
    const store = new SqliteShepherdStore(':memory:');
    const eventConfig = parseShepherdConfig({ version: 2, profile: { githubUser: 'octocat' } });
    for (const commentId of ['1', '2']) {
      store.commit(
        [],
        [buildEvent(eventConfig, 'comment', { repo: 'acme/api', number: 1 }, { commentId }, { author: 'sam' })],
        'coord',
      );
    }
    let sends = 0;
    const worker = service(store, {
      send: () => {
        sends += 1;
        vi.setSystemTime(Date.now() + 1_500);
        return Promise.reject(new Error('conductor unavailable'));
      },
    });

    await worker.drainOutbox();

    expect(sends).toBe(2);
    expect(store.listOutbox()).toHaveLength(2);
    store.close();
  });
});
