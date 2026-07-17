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
  it('tracks pending and delivered messages', () => {
    const id = store.insertMessage('alpha', 'beta', 'notification', 'heads up');
    expect(store.getPendingMessages('beta').map((m) => m.id)).toEqual([id]);
    store.markMessageDelivered(id);
    expect(store.getPendingMessages('beta')).toEqual([]);
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
      autonomy: 'autonomous',
      tag: 'refactor',
      pause: { previousAutonomy: 'autonomous', pausedBy: 'manual' },
      activity: 'working',
    });
    const state = store.getSessionState('alpha');
    expect(state?.autonomy).toBe('autonomous');
    expect(state?.tag).toBe('refactor');
    expect(state?.pause?.pausedBy).toBe('manual');

    store.upsertSessionState({
      session: 'alpha',
      autonomy: 'facilitated',
      tag: null,
      pause: null,
      activity: 'stopped',
    });
    const updated = store.getSessionState('alpha');
    expect(updated?.autonomy).toBe('facilitated');
    expect(updated?.pause).toBeNull();
    expect(store.getAllSessionStates().length).toBe(1);
  });

  it('deletes state', () => {
    store.upsertSessionState({
      session: 'alpha',
      autonomy: 'facilitated',
      tag: null,
      pause: null,
      activity: 'stopped',
    });
    store.deleteSessionState('alpha');
    expect(store.getSessionState('alpha')).toBeUndefined();
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
