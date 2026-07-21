import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEvent } from '../src/shepherd/events.js';
import { parseShepherdConfig } from '../src/shepherd/config.js';
import { SqliteShepherdStore } from '../src/shepherd/store.js';

const dirs: string[] = [];
const config = parseShepherdConfig({
  version: 2,
  profile: { githubUser: 'octocat' },
  delivery: { type: 'conductor', endpoint: 'http://localhost:3000', coordinatorSession: 'coord' },
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('PR Shepherd SQLite store', () => {
  it('atomically commits cursor state, event, and outbox and deduplicates on restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-store-'));
    dirs.push(dir);
    const path = join(dir, 'shepherd.db');
    const event = buildEvent(
      config,
      'ci-failed',
      { repo: 'acme/api', number: 7 },
      { headSha: 'abc', checkRunId: 9 },
      {
        failedChecks: ['test'],
      },
      '2026-07-20T00:00:00.000Z',
    );
    const first = new SqliteShepherdStore(path);
    expect(first.commit([{ key: 'cursor:7', kind: 'cursor', value: { checkRunId: 9 } }], [event], 'coord')).toEqual([
      event,
    ]);
    first.close();

    const reopened = new SqliteShepherdStore(path);
    expect(reopened.getEntity<{ checkRunId: number }>('cursor:7')?.value.checkRunId).toBe(9);
    expect(reopened.listEvents()).toHaveLength(1);
    expect(reopened.listOutbox()).toHaveLength(1);
    expect(reopened.commit([], [event], 'coord')).toEqual([]);
    expect(reopened.listOutbox()).toHaveLength(1);
    reopened.close();
  });

  it('rolls back cursor state when event serialization fails mid-transaction', () => {
    const store = new SqliteShepherdStore(':memory:');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const event = {
      ...buildEvent(config, 'comment', { repo: 'acme/api', number: 8 }, { commentId: '1' }, { author: 'sam' }),
      source: cyclic,
    };
    expect(() =>
      store.commit([{ key: 'cursor:8', kind: 'cursor', value: { commentId: '1' } }], [event], 'coord'),
    ).toThrow();
    expect(store.getEntity('cursor:8')).toBeUndefined();
    expect(store.listEvents()).toEqual([]);
    expect(store.listOutbox()).toEqual([]);
    store.close();
  });

  it('recovers claimed outbox rows after process restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-outbox-'));
    dirs.push(dir);
    const path = join(dir, 'shepherd.db');
    const event = buildEvent(
      config,
      'stale',
      { repo: 'acme/api', number: 9 },
      { headSha: 'abc', staleCycle: 1 },
      {
        hoursStale: 24,
      },
    );
    const first = new SqliteShepherdStore(path);
    first.commit([], [event], 'coord');
    expect(first.claimOutbox(new Date('2100-01-01'))).toHaveLength(1);
    first.close();
    const reopened = new SqliteShepherdStore(path);
    expect(reopened.claimOutbox(new Date('2100-01-01'))).toEqual([]);
    reopened.recoverInFlight();
    expect(reopened.claimOutbox(new Date('2100-01-01'))).toHaveLength(1);
    reopened.close();
  });

  it('claims each outbox row only once under competing workers', () => {
    const store = new SqliteShepherdStore(':memory:');
    const event = buildEvent(
      config,
      'comment',
      { repo: 'acme/api', number: 10 },
      { commentId: '42' },
      { author: 'sam' },
    );
    store.commit([], [event], 'coord');
    expect(store.claimOutbox(new Date('2100-01-01'))).toHaveLength(1);
    expect(store.claimOutbox(new Date('2100-01-01'))).toEqual([]);
    store.close();
  });

  it('makes newly committed outbox work ready even when the source timestamp is in the future', () => {
    const store = new SqliteShepherdStore(':memory:');
    const event = buildEvent(
      config,
      'comment',
      { repo: 'acme/api', number: 11 },
      { commentId: 'future' },
      { author: 'sam' },
      '2100-01-01T00:00:00.000Z',
    );
    store.commit([], [event], 'coord');
    expect(store.claimOutbox(new Date(Date.now() + 1_000))).toHaveLength(1);
    store.close();
  });
});
