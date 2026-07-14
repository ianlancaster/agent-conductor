import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store/index.js';

let store: Store;

beforeEach(() => {
  store = new Store(':memory:');
});

afterEach(() => {
  store.close();
});

describe('sessions', () => {
  it('round-trips a session lifecycle', () => {
    store.insertSession('s1', 'alpha', 'do the thing');
    const session = store.getSession('s1');
    expect(session?.agent).toBe('alpha');
    expect(session?.status).toBe('active');
    expect(session?.prompt_summary).toBe('do the thing');

    expect(store.getActiveSessions().map((s) => s.id)).toEqual(['s1']);

    store.completeSession('s1');
    expect(store.getSession('s1')?.status).toBe('completed');
    expect(store.getActiveSessions()).toEqual([]);
  });

  it('lists recent sessions per agent', () => {
    store.insertSession('s1', 'alpha');
    store.insertSession('s2', 'alpha');
    store.insertSession('s3', 'beta');
    expect(store.getRecentSessions('alpha').length).toBe(2);
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
  it('records and filters by agent', () => {
    store.logHealthEvent('alpha', 'stall', 'idle at prompt');
    store.logHealthEvent('beta', 'stall');
    expect(store.getHealthLog('alpha').length).toBe(1);
    expect(store.getHealthLog().length).toBe(2);
    expect(store.getHealthLog('alpha')[0]?.detail).toBe('idle at prompt');
  });
});

describe('agent state', () => {
  it('upserts and reads back state including pause JSON', () => {
    store.upsertAgentState({
      agent: 'alpha',
      autonomy: 'autonomous',
      tag: 'refactor',
      pause: { previousAutonomy: 'autonomous', pausedBy: 'manual' },
      activity: 'working',
    });
    const state = store.getAgentState('alpha');
    expect(state?.autonomy).toBe('autonomous');
    expect(state?.tag).toBe('refactor');
    expect(state?.pause?.pausedBy).toBe('manual');

    store.upsertAgentState({ agent: 'alpha', autonomy: 'facilitated', tag: null, pause: null, activity: 'stopped' });
    const updated = store.getAgentState('alpha');
    expect(updated?.autonomy).toBe('facilitated');
    expect(updated?.pause).toBeNull();
    expect(store.getAllAgentStates().length).toBe(1);
  });

  it('deletes state', () => {
    store.upsertAgentState({ agent: 'alpha', autonomy: 'facilitated', tag: null, pause: null, activity: 'stopped' });
    store.deleteAgentState('alpha');
    expect(store.getAgentState('alpha')).toBeUndefined();
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
