import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportEventJournalJsonl, Store } from '../src/store/index.js';
import { ConductorEventBus } from '../src/events/bus.js';
import { openSqliteDatabase } from '../src/store/sqlite.js';
import { evaluateEventJsonl } from './fakes/fake-event-evaluator.js';

let store: Store;

beforeEach(() => {
  store = new Store(':memory:');
});

afterEach(() => {
  store.close();
});

describe('runs', () => {
  it('round-trips a run lifecycle', () => {
    store.insertRun('r1', 'alpha', 'do the thing');
    const run = store.getRun('r1');
    expect(run?.session).toBe('alpha');
    expect(run?.status).toBe('active');
    expect(run?.prompt_summary).toBe('do the thing');

    expect(store.getActiveRuns().map((r) => r.id)).toEqual(['r1']);

    store.completeRun('r1');
    expect(store.getRun('r1')?.status).toBe('completed');
    expect(store.getActiveRuns()).toEqual([]);
  });

  it('lists recent runs per session', () => {
    store.insertRun('r1', 'alpha');
    store.insertRun('r2', 'alpha');
    store.insertRun('r3', 'beta');
    expect(store.getRecentRuns('alpha').length).toBe(2);
  });
});

describe('messages', () => {
  it('records and marks delivered messages', () => {
    const id = store.insertMessage('alpha', 'beta', 'message', 'heads up');
    expect(store.getPendingMessages('beta').map((row) => row.id)).toEqual([id]);
    expect(store.getMessage(id)?.status).toBe('pending');
    store.recordMessageFlushAttempt(id, 'input-occupied');
    expect(store.getMessage(id)).toMatchObject({ flush_skip_reason: 'input-occupied' });
    store.markMessageDelivered(id);
    const delivered = store.getMessage(id);
    expect(delivered).toMatchObject({
      status: 'delivered',
      flush_skip_reason: null,
    });
    expect(delivered?.delivered_at).toBeTypeOf('string');
    expect(delivered?.last_flush_attempt_at).toBeTypeOf('string');
    expect(store.getPendingMessages('beta')).toEqual([]);
  });

  it('cancels only pending messages', () => {
    const id = store.insertMessage('alpha', 'beta', 'message', 'fallback race');
    expect(store.markMessageCancelled(id)).toBe(true);
    expect(store.markMessageCancelled(id)).toBe(false);
    const cancelled = store.getMessage(id);
    expect(cancelled).toMatchObject({ status: 'cancelled' });
    expect(cancelled?.cancelled_at).toBeTypeOf('string');
    expect(store.getPendingMessages('beta')).toEqual([]);
  });

  it('cancels stale queues on restart', () => {
    const local = store.insertDirectMessage('alpha', 'beta', 'local').row;
    expect(store.cancelPendingLocalMessagesOnRestart().map((row) => row.id)).toEqual([local.id]);
    expect(store.getMessage(local.id)).toMatchObject({
      status: 'cancelled',
      flush_skip_reason: 'conductor-restarted',
    });
  });

  it('persists sender-scoped idempotency keys', () => {
    const first = store.insertDirectMessage('alpha', 'beta', 'first', 'key-1');
    const duplicate = store.insertDirectMessage('alpha', 'beta', 'ignored', 'key-1');
    const otherSender = store.insertDirectMessage('watch', 'beta', 'separate', 'key-1');
    expect(first.deduplicated).toBe(false);
    expect(duplicate).toEqual({ row: first.row, deduplicated: true });
    expect(otherSender.row.id).not.toBe(first.row.id);
  });

  it('lists recent direct-message metadata without content or broadcasts', () => {
    const first = store.insertMessage('alpha', 'beta', 'message', 'private first body');
    store.markMessageDelivered(first);
    store.insertMessage('alpha', '*', 'broadcast', 'private broadcast body');
    const latest = store.insertMessage('gamma', 'alpha', 'message', 'private latest body');

    const activity = store.getRecentMessageActivity('alpha', 2);
    expect(activity.map((row) => row.id)).toEqual([latest, first]);
    expect(activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sender: 'gamma', recipient: 'alpha', status: 'pending' }),
        expect.objectContaining({ sender: 'alpha', recipient: 'beta', status: 'delivered' }),
      ]),
    );
    expect(JSON.stringify(activity)).not.toContain('private');
  });

  it('lets an explicit idempotent retry revive a queue cancelled by restart', () => {
    const first = store.insertDirectMessage('alpha', 'beta', 'first attempt', 'key-1');
    expect(store.cancelPendingLocalMessagesOnRestart()).toHaveLength(1);

    const retried = store.insertDirectMessage('alpha', 'beta', 'explicit retry', 'key-1');
    expect(retried).toMatchObject({ deduplicated: false });
    expect(retried.row).toMatchObject({
      id: first.row.id,
      content: 'explicit retry',
      status: 'pending',
      cancelled_at: null,
      flush_skip_reason: null,
    });
  });
});

describe('event journal', () => {
  it('exports live WAL rows in insertion order and preserves unknown future envelopes verbatim', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-events-'));
    const dbPath = join(dir, 'conductor.db');
    const persistent = new Store(dbPath);
    try {
      const bus = new ConductorEventBus('fleet', [], { conductorInstanceId: 'instance', journal: persistent });
      bus.emit({ type: 'session.ready', session: 'alpha' });
      bus.emit({ type: 'session.ready', session: 'beta' });
      const future = {
        schemaVersion: 1,
        id: 'future:1',
        seq: 1,
        occurredAt: '2099-01-01T00:00:00.000Z',
        conductorInstanceId: 'future',
        fleetId: 'fleet',
        type: 'future.event',
        opaque: { retained: true },
      };
      persistent.appendEvent(future as never);

      const exported = [...exportEventJournalJsonl(dbPath)];
      expect(exported.map((line) => JSON.parse(line) as unknown)).toEqual([
        expect.objectContaining({ id: 'instance:1', session: 'alpha' }),
        expect.objectContaining({ id: 'instance:2', session: 'beta' }),
        future,
      ]);
      expect(exported[2]).toBe(JSON.stringify(future));
      expect([...exportEventJournalJsonl(dbPath, '2099-01-01T00:00:00.000Z')]).toEqual([JSON.stringify(future)]);
      expect(evaluateEventJsonl(exported)).toEqual({
        ids: ['instance:1', 'instance:2', 'future:1'],
        types: ['session.ready', 'session.ready', 'future.event'],
        sequenceGaps: 0,
      });
    } finally {
      persistent.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates a pre-journal beta database without replacing existing schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-events-migration-'));
    const dbPath = join(dir, 'conductor.db');
    const legacy = openSqliteDatabase(dbPath);
    legacy.exec(`
      CREATE TABLE legacy_fact (value TEXT);
      CREATE TABLE session_state (
        session TEXT PRIMARY KEY,
        auto INTEGER NOT NULL DEFAULT 0,
        tag TEXT,
        is_paused INTEGER NOT NULL DEFAULT 0,
        activity TEXT NOT NULL DEFAULT 'stopped',
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        active_runtime TEXT,
        active_effort TEXT
      );
      PRAGMA user_version = 8;
    `);
    legacy.close();

    const migrated = new Store(dbPath);
    try {
      const bus = new ConductorEventBus('fleet', [], { journal: migrated });
      bus.emit({ type: 'session.ready', session: 'alpha' });
      expect([...exportEventJournalJsonl(dbPath)]).toHaveLength(1);
    } finally {
      migrated.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes second-precision and offset --since timestamps before comparison', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-events-since-'));
    const dbPath = join(dir, 'conductor.db');
    const persistent = new Store(dbPath);
    const boundary = {
      schemaVersion: 1,
      id: 'instance:1',
      seq: 1,
      occurredAt: '2026-07-26T00:00:00.000Z',
      conductorInstanceId: 'instance',
      fleetId: 'fleet',
      type: 'session.ready',
      session: 'alpha',
    };
    try {
      persistent.appendEvent(boundary as never);
      expect([...exportEventJournalJsonl(dbPath, '2026-07-26T00:00:00Z')]).toEqual([JSON.stringify(boundary)]);
      expect([...exportEventJournalJsonl(dbPath, '2026-07-26T02:00:00+02:00')]).toEqual([JSON.stringify(boundary)]);
    } finally {
      persistent.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('operator requests', () => {
  it('round-trips requests and enforces atomic claim/finalize transitions', () => {
    const id = store.insertOperatorRequest('alpha', 'Deploy?', ['Staging', 'Production']);
    expect(store.getOperatorRequest(id)).toMatchObject({
      session: 'alpha',
      options: ['Staging', 'Production'],
      status: 'pending',
    });
    expect(store.claimOperatorRequest(id)).toBe(true);
    expect(store.claimOperatorRequest(id)).toBe(false);
    expect(store.finalizeOperatorRequest(id, 1)).toBe(true);
    expect(store.getOperatorRequest(id)).toMatchObject({ status: 'responded', selectedIndex: 1 });
  });

  it('resets stale responding claims during recovery', () => {
    const id = store.insertOperatorRequest('alpha', 'Deploy?', ['Yes']);
    store.claimOperatorRequest(id);
    expect(store.resetRespondingOperatorRequests()).toBe(1);
    expect(store.getOperatorRequest(id)?.status).toBe('pending');
  });

  it('guards against malformed stored option JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-request-corrupt-'));
    const dbPath = join(dir, 'conductor.db');
    const persisted = new Store(dbPath);
    const id = persisted.insertOperatorRequest('alpha', 'Choose', ['one']);
    persisted.close();

    const raw = openSqliteDatabase(dbPath);
    raw.prepare('UPDATE operator_requests SET options_json = ? WHERE id = ?').run('{secret-looking-bad-json', id);
    raw.close();

    const reopened = new Store(dbPath);
    expect(() => reopened.getOperatorRequest(id)).toThrow(
      `Operator request #${String(id)} has invalid stored options.`,
    );
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('health log', () => {
  it('records and filters by session', () => {
    store.logHealthEvent('alpha', 'stall', 'idle at prompt');
    store.logHealthEvent('beta', 'stall');
    expect(store.getHealthLog('alpha').length).toBe(1);
    expect(store.getHealthLog().length).toBe(2);
    expect(store.getHealthLog('alpha')[0]?.detail).toBe('idle at prompt');
  });
});

describe('session state', () => {
  it('upserts and reads back state including pause JSON', () => {
    store.upsertSessionState({
      session: 'alpha',
      auto: true,
      tag: 'refactor',
      paused: true,
      activeRuntime: 'codex',
      activeEffort: 'xhigh',
      activeModel: 'gpt-5.6-sol',
      activeLaunchedAt: '2026-07-29T07:48:13.577Z',
      activeHooksRenderedDigest: 'd'.repeat(64),
      activity: 'working',
    });
    const state = store.getSessionState('alpha');
    expect(state?.auto).toBe(true);
    expect(state?.tag).toBe('refactor');
    expect(state?.paused).toBe(true);
    expect(state?.activeRuntime).toBe('codex');
    expect(state?.activeEffort).toBe('xhigh');
    // The launch record has to survive a conductor restart: it is the only thing
    // that distinguishes what an adopted process was started with from what its
    // config says today.
    expect(state?.activeModel).toBe('gpt-5.6-sol');
    expect(state?.activeLaunchedAt).toBe('2026-07-29T07:48:13.577Z');
    expect(state?.activeHooksRenderedDigest).toBe('d'.repeat(64));

    store.upsertSessionState({
      session: 'alpha',
      auto: false,
      tag: null,
      paused: false,
      activeRuntime: null,
      activeEffort: null,
      activeModel: null,
      activeLaunchedAt: null,
      activeHooksRenderedDigest: null,
      activity: 'stopped',
    });
    const updated = store.getSessionState('alpha');
    expect(updated?.auto).toBe(false);
    expect(updated?.paused).toBe(false);
    expect(updated?.activeHooksRenderedDigest).toBeNull();
    expect(store.getAllSessionStates().length).toBe(1);
  });

  it('deletes state', () => {
    store.upsertSessionState({
      session: 'alpha',
      auto: false,
      tag: null,
      paused: false,
      activeRuntime: null,
      activeEffort: null,
      activeModel: null,
      activeLaunchedAt: null,
      activity: 'stopped',
    });
    store.deleteSessionState('alpha');
    expect(store.getSessionState('alpha')).toBeUndefined();
  });

  it('migrates existing mode and pause state to auto booleans without legacy columns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-store-migration-'));
    const dbPath = join(dir, 'conductor.db');
    const legacy = openSqliteDatabase(dbPath);
    legacy.exec(`
      CREATE TABLE session_state (
        session TEXT PRIMARY KEY,
        autonomy TEXT NOT NULL DEFAULT 'facilitated',
        tag TEXT,
        pause_json TEXT,
        activity TEXT NOT NULL DEFAULT 'stopped',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'message',
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO session_state (session, autonomy, tag, pause_json, activity)
      VALUES ('alpha', 'facilitated', 'legacy', '{"previousAutonomy":"autonomous"}', 'working');
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const migrated = new Store(dbPath);
    expect(migrated.getSessionState('alpha')).toMatchObject({ auto: true, paused: true, tag: 'legacy' });
    const requestId = migrated.insertOperatorRequest('alpha', 'Still there?', ['Yes']);
    expect(migrated.getOperatorRequest(requestId)?.options).toEqual(['Yes']);
    migrated.close();

    const inspected = openSqliteDatabase(dbPath);
    const columns = inspected.prepare('PRAGMA table_info(session_state)').all() as { name: string }[];
    inspected.close();
    rmSync(dir, { recursive: true, force: true });
    expect(columns.map((column) => column.name)).toEqual([
      'session',
      'auto',
      'tag',
      'is_paused',
      'activity',
      'updated_at',
      'active_runtime',
      'active_effort',
      'active_model',
      'active_launched_at',
      'active_hooks_rendered_digest',
    ]);
  });

  it('normalizes the retired stalled activity when opening the preceding beta schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-activity-migration-'));
    const dbPath = join(dir, 'conductor.db');
    const seeded = new Store(dbPath);
    seeded.upsertSessionState({
      session: 'alpha',
      auto: false,
      tag: null,
      paused: false,
      activeRuntime: 'codex',
      activeEffort: null,
      activeModel: null,
      activeLaunchedAt: null,
      activity: 'idle',
    });
    seeded.close();

    // Reconstruct the older schema rather than only rewinding the version
    // counter: rewinding replays every migration after that point, so a later
    // migration that adds a column would be re-applied and fail. Drop what the
    // migrations under replay are supposed to add, and they can do their work.
    const legacy = openSqliteDatabase(dbPath);
    const versionRow = legacy.prepare('PRAGMA user_version').get() as { user_version: number };
    const currentVersion = versionRow.user_version;
    legacy.exec('ALTER TABLE session_state DROP COLUMN active_model');
    legacy.exec('ALTER TABLE session_state DROP COLUMN active_launched_at');
    legacy.exec('ALTER TABLE session_state DROP COLUMN active_hooks_rendered_digest');
    legacy.exec("UPDATE session_state SET activity = 'stalled' WHERE session = 'alpha'");
    legacy.exec(`PRAGMA user_version = ${String(currentVersion - 3)}`);
    legacy.close();

    const migrated = new Store(dbPath);
    expect(migrated.getSessionState('alpha')?.activity).toBe('idle');
    migrated.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('workspace KV', () => {
  it('stores structured values', () => {
    store.setWorkspaceValue('window', { id: 42, panes: { alpha: 'uuid-1' } });
    expect(store.getWorkspaceValue<{ id: number }>('window')?.id).toBe(42);
    store.setWorkspaceValue('window', { id: 43 });
    expect(store.getWorkspaceValue<{ id: number }>('window')?.id).toBe(43);
    store.deleteWorkspaceValue('window');
    expect(store.getWorkspaceValue('window')).toBeUndefined();
  });
});
