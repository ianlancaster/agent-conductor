import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store/index.js';
import { openSqliteDatabase } from '../src/store/sqlite.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('beta migration version collision recovery', () => {
  it('preserves accepted status and duplicate counts when an upgraded store has an older user_version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-status-version-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'conductor.db');
    const seeded = new Store(dbPath);
    seeded.workStatus.report('fleet', 'alpha', { state: 'working', work_id: 'TASK-1', summary: 'Build' }, '1', 100);
    const done = seeded.workStatus.report(
      'fleet',
      'alpha',
      {
        state: 'done',
        work_id: 'TASK-1',
        summary: 'Built',
        evidence: ['artifact://1'],
      },
      '1',
      200,
    );
    seeded.workStatus.report(
      'fleet',
      'alpha',
      {
        state: 'done',
        work_id: 'TASK-1',
        summary: 'Built',
        evidence: ['artifact://1'],
      },
      '1',
      250,
    );
    seeded.workStatus.accept(
      'fleet',
      'TASK-1',
      'operator',
      {
        attemptId: done.attemptId,
        claimEventId: done.eventId,
      },
      undefined,
      300,
    );
    seeded.close();
    const oldVersion = openSqliteDatabase(dbPath);
    oldVersion.exec('PRAGMA user_version = 14');
    oldVersion.close();
    const reopened = new Store(dbPath);
    expect(reopened.workStatus.current('fleet')[0]).toMatchObject({
      disposition: 'accepted',
      completion_revision: 1,
    });
    expect(reopened.workStatus.events('fleet').find((event) => event.id === done.sequence)?.duplicate_count).toBe(1);
    reopened.close();
  });

  it('rebuilds the current status projection and keyed receipts from a prior journal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-status-projection-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'conductor.db');
    const seeded = new Store(dbPath);
    const first = seeded.workStatus.report(
      'fleet',
      'alpha',
      {
        state: 'working',
        work_id: 'TASK-1',
        summary: 'Build',
        idempotencyKey: 'first',
      },
      '1',
      100,
    );
    seeded.workStatus.report(
      'fleet',
      'alpha',
      {
        state: 'waiting',
        work_id: 'TASK-1',
        summary: 'CI',
        waiting_on: 'CI',
      },
      '1',
      200,
    );
    seeded.close();
    const old = openSqliteDatabase(dbPath);
    old.exec(`
      DROP TABLE work_status_current;
      DROP TABLE work_status_idempotency;
      ALTER TABLE work_status_events DROP COLUMN duplicate_count;
      PRAGMA user_version = 18;
    `);
    old.close();
    const migrated = new Store(dbPath);
    expect(migrated.workStatus.current('fleet')[0]).toMatchObject({
      state: 'waiting',
      state_entered_at_ms: 200,
      work_started_at_ms: 100,
    });
    expect(
      migrated.workStatus.report(
        'fleet',
        'alpha',
        {
          state: 'working',
          work_id: 'TASK-1',
          summary: 'Build',
          idempotencyKey: 'first',
        },
        '1',
        300,
      ),
    ).toMatchObject({ eventId: first.eventId, unchanged: true });
    expect(migrated.workStatus.current('fleet')[0]?.state).toBe('waiting');
    migrated.close();
  });

  it('opens an already-upgraded store after rollback without deleting its records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-rollback-schema-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'conductor.db');
    const seeded = new Store(dbPath);
    const id = seeded.insertMessage('beta', 'alpha', 'message', 'Existing uncertain message');
    seeded.close();
    const upgraded = openSqliteDatabase(dbPath);
    upgraded.prepare("UPDATE messages SET status = 'uncertain' WHERE id = ?").run(id);
    upgraded
      .prepare(
        "INSERT INTO message_reconciliations VALUES (?, 'abandoned', 'operator', 'Preserved evidence', '2026-09-17T00:00:00Z')",
      )
      .run(id);
    upgraded.close();
    const reopened = new Store(dbPath);
    expect(reopened.getMessage(id)).toMatchObject({ status: 'uncertain' });
    const next = reopened.insertMessage('beta', 'alpha', 'message', 'Ordinary new message');
    expect(reopened.getMessage(next)).toMatchObject({ status: 'pending' });
    reopened.close();
    const inspected = openSqliteDatabase(dbPath);
    expect(inspected.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 20 });
    expect(
      inspected.prepare('SELECT evidence FROM message_reconciliations WHERE message_id = ?').get(id),
    ).toMatchObject({ evidence: 'Preserved evidence' });
    expect(inspected.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' });
    inspected.close();
  }, 30_000);

  it.each([13, 14])('repairs the rooms lineage at version %i without losing data', (version) => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-beta-schema-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'conductor.db');
    const seeded = new Store(dbPath);
    const oldId = seeded.insertMessage('peer@remote-fleet', 'alpha', 'message', 'Existing message', 'existing');
    seeded.upsertSessionState({
      session: 'alpha',
      auto: false,
      paused: true,
      pausedAt: '2026-08-01T00:00:00.000Z',
      tag: 'retained',
      activeRuntime: 'codex',
      activeEffort: 'high',
      activity: 'idle',
    });
    seeded.close();

    const legacy = openSqliteDatabase(dbPath);
    legacy.exec(`
      ALTER TABLE messages DROP COLUMN delivery_policy;
      ALTER TABLE messages DROP COLUMN delivery_envelope;
      CREATE TABLE rooms (room TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE room_members (
        room TEXT NOT NULL REFERENCES rooms(room) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('session', 'operator')),
        member TEXT NOT NULL,
        joined_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (room, kind, member)
      );
      INSERT INTO rooms (room) VALUES ('review');
      INSERT INTO room_members (room, kind, member) VALUES ('review', 'session', 'alpha');
      PRAGMA user_version = ${String(version)};
    `);
    if (version === 13) legacy.exec('ALTER TABLE session_state DROP COLUMN paused_at');
    const oldRow = legacy.prepare('SELECT * FROM messages WHERE id = ?').get(oldId);
    legacy.close();

    const migrated = new Store(dbPath);
    expect(migrated.getMessage(oldId)).toMatchObject({ ...oldRow, delivery_policy: 'hold', delivery_envelope: null });
    expect(migrated.getSessionState('alpha')).toMatchObject({ paused: true, tag: 'retained' });
    expect(migrated.getSessionState('alpha')?.pausedAt).toEqual(expect.any(String));
    if (version === 14) expect(migrated.getSessionState('alpha')?.pausedAt).toBe('2026-08-01T00:00:00.000Z');

    // Exercise the remote sender, ordinary local send, and idempotent path on the repaired store.
    const receipt = migrated.insertDirectMessage('peer@remote-fleet', 'alpha', 'Remote message', 'retry', {
      policy: 'hold',
      envelope: '[Message from peer@remote-fleet] Remote message',
    });
    expect(receipt.row.delivery_policy).toBe('hold');
    expect(migrated.insertDirectMessage('peer@remote-fleet', 'alpha', 'Remote message', 'retry').deduplicated).toBe(
      true,
    );
    const local = migrated.insertDirectMessage('beta', 'alpha', 'Local message');
    expect(local.row.delivery_policy).toBe('hold');
    const operator = migrated.insertDirectMessage('operator', 'alpha', 'Operator message', undefined, {
      policy: 'bypass',
      envelope: 'Operator message',
    });
    expect(operator.row.delivery_policy).toBe('bypass');
    migrated.close();

    const reopened = new Store(dbPath);
    expect(reopened.getMessage(receipt.row.id)).toEqual(receipt.row);
    expect(reopened.getMessage(operator.row.id)).toEqual(operator.row);
    reopened.close();
    const inspected = openSqliteDatabase(dbPath);
    expect(inspected.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 20 });
    expect(inspected.prepare('SELECT room, kind, member FROM room_members').all()).toEqual([
      { room: 'review', kind: 'session', member: 'alpha' },
    ]);
    expect(() => inspected.exec("UPDATE messages SET delivery_policy = 'invalid'")).toThrow();
    expect(inspected.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' });
    inspected.close();
  });

  it('preserves protected policies and envelopes in a normal version 14 database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-current-schema-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'conductor.db');
    const seeded = new Store(dbPath);
    const receipt = seeded.insertDirectMessage('operator', 'alpha', 'Keep this', 'stable', {
      policy: 'bypass',
      envelope: 'Keep this envelope',
    });
    seeded.close();
    const legacy = openSqliteDatabase(dbPath);
    legacy.exec('PRAGMA user_version = 14');
    legacy.close();
    const migrated = new Store(dbPath);
    expect(migrated.getMessage(receipt.row.id)).toEqual(receipt.row);
    migrated.close();
  });
});
