import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store/index.js';

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
    store.markMessageDelivered(id);
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

    const raw = new Database(dbPath);
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
      activity: 'working',
    });
    const state = store.getSessionState('alpha');
    expect(state?.auto).toBe(true);
    expect(state?.tag).toBe('refactor');
    expect(state?.paused).toBe(true);
    expect(state?.activeRuntime).toBe('codex');

    store.upsertSessionState({
      session: 'alpha',
      auto: false,
      tag: null,
      paused: false,
      activeRuntime: null,
      activity: 'stopped',
    });
    const updated = store.getSessionState('alpha');
    expect(updated?.auto).toBe(false);
    expect(updated?.paused).toBe(false);
    expect(store.getAllSessionStates().length).toBe(1);
  });

  it('deletes state', () => {
    store.upsertSessionState({
      session: 'alpha',
      auto: false,
      tag: null,
      paused: false,
      activeRuntime: null,
      activity: 'stopped',
    });
    store.deleteSessionState('alpha');
    expect(store.getSessionState('alpha')).toBeUndefined();
  });

  it('migrates existing mode and pause state to auto booleans without legacy columns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-store-migration-'));
    const dbPath = join(dir, 'conductor.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE session_state (
        session TEXT PRIMARY KEY,
        autonomy TEXT NOT NULL DEFAULT 'facilitated',
        tag TEXT,
        pause_json TEXT,
        activity TEXT NOT NULL DEFAULT 'stopped',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

    const inspected = new Database(dbPath);
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
    ]);
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
