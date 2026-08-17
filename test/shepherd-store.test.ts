import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEvent } from '../src/shepherd/events.js';
import { parseShepherdConfig } from '../src/shepherd/config.js';
import { SqliteShepherdStore } from '../src/shepherd/store.js';
import { openSqliteDatabase } from '../src/store/sqlite.js';

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
  it('migrates a Stage 1 tracked claim to the inert release-gate default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-release-migration-'));
    dirs.push(dir);
    const path = join(dir, 'shepherd.db');
    const stageOne = openSqliteDatabase(path);
    stageOne.exec(`
      CREATE TABLE shepherd_tracked_prs (
        repo_key TEXT NOT NULL,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        generation INTEGER NOT NULL,
        actor TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        unclaimed_at TEXT,
        terminal_state TEXT,
        baseline_pending INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (repo_key, pr_number)
      );
      INSERT INTO shepherd_tracked_prs VALUES
        ('acme/api', 'Acme/API', 7, 'active', 1, 'operator', '{}',
         '2026-08-17T00:00:00Z', '2026-08-17T00:00:00Z', NULL, NULL, 0);
      PRAGMA user_version = 2;
    `);
    stageOne.close();

    const migrated = new SqliteShepherdStore(path);
    expect(migrated.getTrackedPullRequest({ repo: 'acme/api', number: 7 })).toMatchObject({
      status: 'active',
      generation: 1,
      releaseGate: 'none',
    });
    expect(migrated.listReleaseControlOperations(10)).toEqual([]);
    migrated.close();
  });

  it('applies the additive tracked-PR migration without changing existing entity data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-migration-'));
    dirs.push(dir);
    const path = join(dir, 'shepherd.db');
    const legacy = openSqliteDatabase(path);
    legacy.exec(`
      CREATE TABLE shepherd_entities (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO shepherd_entities VALUES ('authored:acme/api#7', 'authored', '{"legacy":true}', '2026-08-17T00:00:00Z');
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const migrated = new SqliteShepherdStore(path);
    expect(migrated.getEntity('authored:acme/api#7')?.value).toEqual({ legacy: true });
    expect(migrated.listTrackedPullRequests()).toEqual([]);
    migrated.close();
  });

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
