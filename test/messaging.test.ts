import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionConfig } from '../src/config/schema.js';
import { DeliveryQueue } from '../src/core/delivery.js';
import { Messaging } from '../src/core/messaging.js';
import { SessionStateManager } from '../src/core/state.js';
import { Store } from '../src/store/index.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';

const CONFIG = { queueDrainMs: 2_000, queueMaxAgeMs: 60_000 };

describe('Messaging durable delivery recovery', () => {
  let store: Store;
  let backend: FakeTerminalBackend;
  let states: SessionStateManager;
  let sessions: Map<string, SessionConfig>;
  const queues: DeliveryQueue[] = [];

  beforeEach(() => {
    store = new Store(':memory:');
    backend = new FakeTerminalBackend();
    states = new SessionStateManager(store, false);
    sessions = new Map([
      ['alpha', { codename: 'alpha', repo: '/tmp/alpha', runtime: 'claude-code', additionalDirs: [], schedules: [] }],
      ['beta', { codename: 'beta', repo: '/tmp/beta', runtime: 'codex', additionalDirs: [], schedules: [] }],
    ]);
    states.register('alpha', false);
    states.register('beta', false);
  });

  afterEach(() => {
    for (const queue of queues) queue.stop();
    queues.length = 0;
    store.close();
  });

  it('rebuilds a queued direct message from SQLite after a conductor restart', async () => {
    const pane = await backend.createPane('beta', 'pane');
    states.setSession('beta', pane.id);
    states.setReady('beta');

    const blockedRuntime = new FakeRuntime();
    blockedRuntime.inputState = 'operator-draft';
    const firstQueue = makeQueue(blockedRuntime, pane.id);
    const firstMessaging = makeMessaging(firstQueue);

    expect(await firstMessaging.sendToSession('alpha', 'beta', 'durable payload')).toBe(
      'Queued message #1 for beta (input is occupied; 1 pending).',
    );
    expect(store.getMessage(1)?.status).toBe('pending');
    firstQueue.stop();

    const recoveredRuntime = new FakeRuntime();
    recoveredRuntime.inputState = 'clear';
    const recoveredQueue = makeQueue(recoveredRuntime, pane.id);
    const recoveredMessaging = makeMessaging(recoveredQueue);
    await recoveredMessaging.recoverPendingMessages('beta');

    expect(backend.panes.get(pane.id)?.received).toEqual(['[Message from alpha] durable payload']);
    expect(store.getMessage(1)?.status).toBe('delivered');
  });

  function makeQueue(runtime: FakeRuntime, paneId: string): DeliveryQueue {
    const queue = new DeliveryQueue({
      backend,
      runtimeFor: () => runtime,
      getPane: (session) => (session === 'beta' ? { backend: 'fake', id: paneId } : undefined),
      isReady: (session) => states.isReady(session),
      config: CONFIG,
    });
    queues.push(queue);
    return queue;
  }

  function makeMessaging(delivery: DeliveryQueue): Messaging {
    return new Messaging({
      store,
      delivery,
      states,
      sessions: () => sessions,
      startSession: async () => 'started',
    });
  }
});
