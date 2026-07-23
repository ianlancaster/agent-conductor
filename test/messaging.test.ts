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
    blockedRuntime.inputState = 'draft';
    const firstQueue = makeQueue(blockedRuntime, pane.id);
    const firstMessaging = makeMessaging(firstQueue);

    expect(await firstMessaging.sendToSession('alpha', 'beta', 'durable payload')).toEqual({
      messageId: 1,
      recipient: 'beta',
      status: 'queued',
      deduplicated: false,
    });
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

  it('deduplicates a sender-scoped key without scheduling a second delivery', async () => {
    const pane = await backend.createPane('beta', 'pane');
    states.setSession('beta', pane.id);
    states.setReady('beta');
    const runtime = new FakeRuntime();
    const queue = makeQueue(runtime, pane.id);
    const messaging = makeMessaging(queue);

    const first = await messaging.sendToSession('alpha', 'beta', 'once', 'stable-key');
    const repeated = await messaging.sendToSession('alpha', 'beta', 'changed payload', 'stable-key');

    expect(first).toEqual({ messageId: 1, recipient: 'beta', status: 'delivered', deduplicated: false });
    expect(repeated).toEqual({ messageId: 1, recipient: 'beta', status: 'delivered', deduplicated: true });
    expect(backend.panes.get(pane.id)?.received).toEqual(['[Message from alpha] once']);
  });

  it('exposes flush diagnostics and cancels a pending receipt without later delivery', async () => {
    const pane = await backend.createPane('beta', 'pane');
    states.setSession('beta', pane.id);
    states.setReady('beta');
    const runtime = new FakeRuntime();
    runtime.inputState = 'draft';
    const queue = makeQueue(runtime, pane.id);
    const messaging = makeMessaging(queue);

    expect(await messaging.sendToSession('alpha', 'beta', 'fallback candidate')).toMatchObject({
      messageId: 1,
      status: 'queued',
    });
    expect(JSON.parse(messaging.messageStatus(1, 'alpha'))).toMatchObject({
      status: 'pending',
      deliveredAt: null,
      flushSkipReason: 'input-occupied',
    });
    expect(messaging.cancelMessage(1, 'alpha')).toBe('Message #1 cancelled.');
    const cancelledStatus = JSON.parse(messaging.messageStatus(1, 'alpha')) as { cancelledAt: unknown };
    expect(cancelledStatus).toMatchObject({
      status: 'cancelled',
      inMemoryPendingForRecipient: 0,
    });
    expect(cancelledStatus.cancelledAt).toBeTypeOf('string');

    runtime.inputState = 'clear';
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual([]);
  });

  it("does not let a recipient cancel another sender's receipt", async () => {
    const pane = await backend.createPane('beta', 'pane');
    states.setSession('beta', pane.id);
    states.setReady('beta');
    const runtime = new FakeRuntime();
    runtime.inputState = 'draft';
    const queue = makeQueue(runtime, pane.id);
    const messaging = makeMessaging(queue);

    await messaging.sendToSession('alpha', 'beta', 'sender owns cancellation');
    expect(messaging.cancelMessage(1, 'beta')).toBe('Message #1 was not found.');
    expect(store.getMessage(1)?.status).toBe('pending');
  });

  it('directs qualified targets to federation instead of conditionally changing send_to_session semantics', async () => {
    const queue = makeQueue(new FakeRuntime(), 'missing-pane');
    const messaging = makeMessaging(queue);
    await expect(messaging.sendToSession('alpha', 'beta@other-fleet', 'hello')).rejects.toThrow(
      /Use send_to_peer.*send_to_session is local/,
    );
  });

  it('returns the original receipt on retry even when the recipient left the roster', async () => {
    const pane = await backend.createPane('beta', 'pane');
    states.setSession('beta', pane.id);
    states.setReady('beta');
    const queue = makeQueue(new FakeRuntime(), pane.id);
    const messaging = makeMessaging(queue);

    const first = await messaging.sendToSession('alpha', 'beta', 'once', 'stable-key');
    sessions.delete('beta');

    await expect(messaging.sendToSession('alpha', 'beta', 'retry', 'stable-key')).resolves.toEqual({
      ...first,
      deduplicated: true,
    });
  });

  it('accepts a federated final hop without starting a stopped recipient and deduplicates retries', async () => {
    const queue = makeQueue(new FakeRuntime(), 'missing-pane');
    let starts = 0;
    const messaging = new Messaging({
      store,
      delivery: queue,
      states,
      sessions: () => sessions,
      startSession: async () => {
        starts += 1;
        return 'beta started.';
      },
    });
    const first = await messaging.acceptInboundFederated({
      messageId: '11111111-1111-4111-8111-111111111111',
      sourceInstanceId: '22222222-2222-4222-8222-222222222222',
      sourceAddress: 'alpha@other',
      recipient: 'beta',
      message: 'peer hello',
      receivedAt: 100,
      expiresAt: Date.now() + 60_000,
    });
    const repeated = await messaging.acceptInboundFederated({
      messageId: '11111111-1111-4111-8111-111111111111',
      sourceInstanceId: '22222222-2222-4222-8222-222222222222',
      sourceAddress: 'alpha@other',
      recipient: 'beta',
      message: 'changed',
      receivedAt: 200,
      expiresAt: Date.now() + 60_000,
    });
    expect(first).toEqual({
      messageId: '11111111-1111-4111-8111-111111111111',
      status: 'received',
      deduplicated: false,
    });
    expect(repeated).toMatchObject({ status: 'received', deduplicated: true });
    expect(starts).toBe(0);
    expect(states.get('beta')?.running).toBe(false);
    expect(store.getPendingMessages('beta')).toHaveLength(1);
  });

  it('delivers an accepted federated final hop through the protected queue when the recipient is running', async () => {
    const pane = await backend.createPane('beta', 'pane');
    states.setSession('beta', pane.id);
    states.setReady('beta');
    const queue = makeQueue(new FakeRuntime(), pane.id);
    const messaging = makeMessaging(queue);

    await expect(
      messaging.acceptInboundFederated({
        messageId: '22222222-2222-4222-8222-222222222222',
        sourceInstanceId: '33333333-3333-4333-8333-333333333333',
        sourceAddress: 'alpha@other',
        recipient: 'beta',
        message: 'peer hello',
        receivedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      }),
    ).resolves.toMatchObject({ status: 'delivered', deduplicated: false });
    expect(backend.panes.get(pane.id)?.received).toEqual(['[Message from alpha@other] peer hello']);
    expect(store.getFederationInboxMessage('22222222-2222-4222-8222-222222222222')?.status).toBe('delivered');
  });

  function makeQueue(runtime: FakeRuntime, paneId: string): DeliveryQueue {
    const queue = new DeliveryQueue({
      backend,
      runtimeFor: () => runtime,
      getPane: (session) => (session === 'beta' ? { backend: 'fake', id: paneId } : undefined),
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
