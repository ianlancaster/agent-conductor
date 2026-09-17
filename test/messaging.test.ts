import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '../src/config/schema.js';
import { DeliveryQueue } from '../src/core/delivery.js';
import { Messaging } from '../src/core/messaging.js';
import { SessionStateManager } from '../src/core/state.js';
import { Store } from '../src/store/index.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';
import { FakeEventPublisher } from './fakes/fake-event-publisher.js';

const CONFIG = { queueDrainMs: 2_000, queueMaxAgeMs: 60_000 };

describe('Messaging delivery receipts', () => {
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

  it('does not replay a queued local message after a conductor restart', async () => {
    const pane = await backend.createPane('beta', 'pane');
    states.setSession('beta', pane.id);
    states.setReady('beta');

    const blockedRuntime = new FakeRuntime();
    blockedRuntime.inputState = 'draft';
    const firstQueue = makeQueue(blockedRuntime, pane.id);
    const firstMessaging = makeMessaging(firstQueue);

    expect(await firstMessaging.sendToSession('alpha', 'beta', 'old payload', 'stable-key')).toEqual({
      messageId: 1,
      recipient: 'beta',
      status: 'queued',
      deduplicated: false,
    });
    expect(store.getMessage(1)?.status).toBe('pending');
    firstQueue.stop();

    expect(store.cancelPendingLocalMessagesOnRestart()).toHaveLength(1);

    const restartedQueue = makeQueue(new FakeRuntime(), pane.id);
    const restartedMessaging = makeMessaging(restartedQueue);
    await restartedMessaging.recoverPendingMessages('beta');

    expect(backend.panes.get(pane.id)?.received).toEqual([]);
    expect(store.getMessage(1)).toMatchObject({
      status: 'cancelled',
      flush_skip_reason: 'conductor-restarted',
    });

    await expect(restartedMessaging.sendToSession('alpha', 'beta', 'explicit retry', 'stable-key')).resolves.toEqual({
      messageId: 1,
      recipient: 'beta',
      status: 'delivered',
      deduplicated: false,
    });
    expect(backend.panes.get(pane.id)?.received).toEqual(['[Message from alpha] explicit retry']);
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

  it('holds peer messages while paused and drains them after ordinary resume', async () => {
    const pane = await backend.createPane('beta', 'pane');
    states.setSession('beta', pane.id);
    states.setReady('beta');
    const queue = makeQueue(new FakeRuntime(), pane.id);
    const messaging = makeMessaging(queue);
    states.pause('beta');

    await expect(messaging.sendToSession('alpha', 'beta', 'wait here')).resolves.toMatchObject({ status: 'queued' });
    expect(store.getMessage(1)).toMatchObject({ delivery_policy: 'hold', status: 'pending' });
    expect(backend.panes.get(pane.id)?.received).toEqual([]);

    states.resume('beta');
    await messaging.recoverPendingMessages('beta');
    expect(backend.panes.get(pane.id)?.received).toEqual(['[Message from alpha] wait here']);
    expect(store.getMessage(1)?.status).toBe('delivered');
  });

  it('reconstructs the exact persisted envelope after a messaging restart', async () => {
    const pane = await backend.createPane('beta', 'pane');
    states.setSession('beta', pane.id);
    states.setReady('beta');
    states.pause('beta');
    const firstQueue = makeQueue(new FakeRuntime(), pane.id);
    const first = makeMessaging(firstQueue);

    await first.sendToSession('alpha', 'beta', 'survive restart');
    firstQueue.stop();
    states.resume('beta');

    const restartedQueue = makeQueue(new FakeRuntime(), pane.id);
    const restarted = makeMessaging(restartedQueue);
    await restarted.recoverPendingMessages('beta');

    expect(backend.panes.get(pane.id)?.received).toEqual(['[Message from alpha] survive restart']);
    expect(store.getMessage(1)).toMatchObject({ status: 'delivered' });
  });

  it('persists broadcast recipients and preserves direct-broadcast FIFO', async () => {
    const pane = await backend.createPane('beta', 'pane');
    states.setSession('beta', pane.id);
    states.setReady('beta');
    states.pause('beta');
    const queue = makeQueue(new FakeRuntime(), pane.id);
    const messaging = makeMessaging(queue);

    await messaging.sendToSession('alpha', 'beta', 'first');
    await expect(messaging.broadcast('alpha', 'second')).resolves.toContain('1 queued');
    await messaging.sendToSession('alpha', 'beta', 'third');
    expect(store.getPendingDeliveries('beta').map((row) => row.type)).toEqual(['message', 'broadcast', 'message']);

    states.resume('beta');
    await messaging.recoverPendingMessages('beta');
    await queue.drainNow();
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual([
      '[Message from alpha] first',
      '[Broadcast from alpha] second',
      '[Message from alpha] third',
    ]);
  });

  it('mints integration identity on the narrow path without trusting a normal sender prefix', async () => {
    const pane = await backend.createPane('beta', 'pane');
    states.setSession('beta', pane.id);
    states.setReady('beta');
    const events = new FakeEventPublisher();
    const messaging = makeMessaging(makeQueue(new FakeRuntime(), pane.id), events);

    const integration = await messaging.sendIntegrationToSession('water-cooler', 'beta', 'changed', 'commit-a');
    const ordinary = await messaging.sendToSession('integration:spoof', 'beta', 'ordinary', 'commit-b');

    expect(integration).toMatchObject({ status: 'delivered', deduplicated: false });
    expect(ordinary).toMatchObject({ status: 'delivered', deduplicated: false });
    expect(backend.panes.get(pane.id)?.received).toEqual([
      '[Integration: water-cooler] changed',
      '[Message from integration:spoof] ordinary',
    ]);
    expect(store.getMessage(integration.messageId)?.sender).toBe('integration:water-cooler');
    expect(events.events).toContainEqual({
      type: 'message.created',
      receiptId: integration.messageId,
      sender: 'integration:water-cooler',
      recipient: 'beta',
      byteCount: 7,
    });
  });

  it('refuses new integration delivery while holding peer messages for resume', async () => {
    const pane = await backend.createPane('beta', 'pane');
    states.setSession('beta', pane.id);
    states.setReady('beta');
    const messaging = makeMessaging(makeQueue(new FakeRuntime(), pane.id));
    states.pause('beta');

    await expect(
      messaging.sendIntegrationToSession('water-cooler', 'beta', 'scheduled bulletin', 'bulletin:paused'),
    ).rejects.toThrow('beta is paused');
    await expect(messaging.sendToSession('alpha', 'beta', 'peer follow-up')).resolves.toMatchObject({
      status: 'queued',
    });
    expect(store.getMessage(1)?.sender).toBe('alpha');
    expect(store.getMessage(2)).toBeUndefined();
    expect(backend.panes.get(pane.id)?.received).toEqual([]);

    states.resume('beta');
    await messaging.recoverPendingMessages('beta');
    await expect(
      messaging.sendIntegrationToSession('water-cooler', 'beta', 'scheduled bulletin', 'bulletin:paused'),
    ).resolves.toMatchObject({ status: 'delivered' });
    expect(backend.panes.get(pane.id)?.received).toEqual([
      '[Message from alpha] peer follow-up',
      '[Integration: water-cooler] scheduled bulletin',
    ]);
  });

  it('warns both the operator and recipient when direct interaction reaches a paused session', async () => {
    const pane = await backend.createPane('beta', 'pane');
    states.setSession('beta', pane.id);
    states.setReady('beta');
    states.pause('beta', '2026-08-26T21:16:20.638Z');
    const notice =
      '[Conductor pause notice] This session is paused since 2026-08-26T21:16:20.638Z. ' +
      'Call resume_session with {"codename":"beta"}.';
    const messaging = makeMessaging(makeQueue(new FakeRuntime(), pane.id), undefined, () => notice);

    const receipt = await messaging.sendToSession('operator', 'beta', 'Did CI arrive?', undefined, 'bypass');

    expect(receipt).toMatchObject({ status: 'delivered', notice });
    expect(backend.panes.get(pane.id)?.received).toEqual([`${notice}\n\n[Message from operator] Did CI arrive?`]);
    expect(store.getMessage(receipt.messageId)?.content).toBe('Did CI arrive?');
  });

  it('lets an operator broadcast bypass a paused peer queue with the pause notice', async () => {
    const pane = await backend.createPane('beta', 'pane');
    states.setSession('beta', pane.id);
    states.setReady('beta');
    states.pause('beta', '2026-08-26T21:16:20.638Z');
    const notice = '[Conductor pause notice] Peer traffic is held.';
    const queue = makeQueue(new FakeRuntime(), pane.id);
    const messaging = makeMessaging(queue, undefined, () => notice);

    await messaging.sendToSession('alpha', 'beta', 'held first');
    await expect(messaging.broadcast('operator', 'urgent update', () => true, 'bypass')).resolves.toBe(
      'Broadcast delivered to 1 session(s).',
    );

    expect(backend.panes.get(pane.id)?.received).toEqual([`${notice}\n\n[Broadcast from operator] urgent update`]);
    expect(store.getPendingDeliveries('beta').map((row) => row.content)).toEqual(['held first']);
  });

  it('keeps a stopped paused recipient asleep for peers but lets later operator input start it', async () => {
    states.pause('beta');
    const pane = await backend.createPane('beta', 'pane');
    const starts: string[] = [];
    const queue = makeQueue(new FakeRuntime(), pane.id);
    const messaging = new Messaging({
      store,
      delivery: queue,
      states,
      sessions: () => sessions,
      startSession: async (_codename, options) => {
        starts.push(options.prompt ?? '');
        states.setSession('beta', pane.id);
        states.setReady('beta');
        return 'beta started.';
      },
    });

    await expect(messaging.sendToSession('alpha', 'beta', 'hold me')).resolves.toMatchObject({ status: 'queued' });
    expect(starts).toEqual([]);
    await expect(messaging.sendToSession('operator', 'beta', 'wake now', undefined, 'bypass')).resolves.toMatchObject({
      status: 'delivered',
    });

    expect(starts).toEqual(['[Message from operator] wake now']);
    expect(store.getMessage(1)).toMatchObject({ status: 'pending', delivery_policy: 'hold' });
    expect(store.getMessage(2)).toMatchObject({ status: 'delivered', delivery_policy: 'bypass' });
    expect(backend.panes.get(pane.id)?.received).toEqual([]);
  });

  it('revives a restart-cancelled integration delivery with the same identity and envelope', async () => {
    const pane = await backend.createPane('beta', 'pane');
    states.setSession('beta', pane.id);
    states.setReady('beta');
    const blocked = new FakeRuntime();
    blocked.inputState = 'draft';
    const firstQueue = makeQueue(blocked, pane.id);
    const first = makeMessaging(firstQueue);

    expect(await first.sendIntegrationToSession('water-cooler', 'beta', 'first attempt', 'repo:one:two')).toMatchObject(
      { status: 'queued' },
    );
    firstQueue.stop();
    expect(store.cancelPendingLocalMessagesOnRestart()).toHaveLength(1);

    const restarted = makeMessaging(makeQueue(new FakeRuntime(), pane.id));
    expect(await restarted.sendIntegrationToSession('water-cooler', 'beta', 'retry', 'repo:one:two')).toEqual({
      messageId: 1,
      recipient: 'beta',
      status: 'delivered',
      deduplicated: false,
    });
    expect(backend.panes.get(pane.id)?.received).toEqual(['[Integration: water-cooler] retry']);
  });

  it('keeps persisted integration content authoritative across a pending same-key retry', async () => {
    const pane = await backend.createPane('beta', 'pane');
    const runtime = new FakeRuntime();
    const queue = makeQueue(runtime, pane.id);
    const messaging = makeMessaging(queue);

    expect(await messaging.sendIntegrationToSession('water-cooler', 'beta', 'original', 'repo:one:two')).toEqual({
      messageId: 1,
      recipient: 'beta',
      status: 'queued',
      deduplicated: false,
    });
    expect(await messaging.sendIntegrationToSession('water-cooler', 'beta', 'changed retry', 'repo:one:two')).toEqual({
      messageId: 1,
      recipient: 'beta',
      status: 'queued',
      deduplicated: true,
    });
    expect(store.getMessage(1)?.content).toBe('original');

    states.setSession('beta', pane.id);
    states.setReady('beta');
    await messaging.recoverPendingMessages('beta');

    expect(backend.panes.get(pane.id)?.received).toEqual(['[Integration: water-cooler] original']);
    expect(store.getMessage(1)).toMatchObject({ content: 'original', status: 'delivered' });
  });

  it('coalesces repeated post-commit admission failures until the durable row is delivered', async () => {
    const pane = await backend.createPane('beta', 'pane');
    states.setSession('beta', pane.id);
    states.setReady('beta');
    let attempts = 0;
    const delivery = {
      enqueueOnly: (_recipient: string, _text: string, options: { onDelivered?: () => void }) => {
        attempts += 1;
        if (attempts < 3) throw new Error(`admission failure ${String(attempts)}`);
        options.onDelivered?.();
      },
      drainNow: async () => undefined,
      queueDrainMs: () => 1,
      pendingCount: () => 0,
      cancel: () => 'not-found' as const,
      acquireSubmissionLease: () => () => undefined,
    } as unknown as DeliveryQueue;
    const messaging = makeMessaging(delivery);

    await expect(messaging.sendToSession('alpha', 'beta', 'retry admission')).resolves.toMatchObject({
      status: 'queued',
    });
    await expect.poll(() => store.getMessage(1)?.status).toBe('delivered');
    expect(attempts).toBe(3);
    messaging.stop();
  });

  it('retries start-if-needed after the first stopped-recipient launch fails', async () => {
    const pane = await backend.createPane('beta', 'pane');
    let starts = 0;
    const delivery = {
      enqueueOnly: () => undefined,
      drainNow: async () => undefined,
      queueDrainMs: () => 1,
      pendingCount: () => 0,
      cancel: () => 'not-found' as const,
      acquireSubmissionLease: () => () => undefined,
    } as unknown as DeliveryQueue;
    const messaging = new Messaging({
      store,
      delivery,
      states,
      sessions: () => sessions,
      startSession: async () => {
        starts += 1;
        if (starts === 1) throw new Error('launch failed');
        states.setSession('beta', pane.id);
        states.setReady('beta');
        return 'beta started.';
      },
    });

    await expect(messaging.sendToSession('alpha', 'beta', 'retry launch')).resolves.toMatchObject({
      status: 'queued',
    });
    await expect.poll(() => store.getMessage(1)?.status).toBe('delivered');
    expect(starts).toBe(2);
    messaging.stop();
  });

  it('does not let a cancelled start trigger launch a stopped recipient for older pending traffic', async () => {
    store.insertDirectMessage('source', 'beta', 'older pending');
    let starts = 0;
    const delivery = {
      enqueueOnly: () => undefined,
      drainNow: async () => undefined,
      queueDrainMs: () => 1,
      pendingCount: () => 0,
      cancel: () => 'not-found' as const,
      acquireSubmissionLease: () => () => undefined,
    } as unknown as DeliveryQueue;
    const messaging = new Messaging({
      store,
      delivery,
      states,
      sessions: () => sessions,
      startSession: async () => {
        starts += 1;
        if (starts === 1) throw new Error('launch failed');
        return 'beta started.';
      },
    });

    const trigger = await messaging.sendToSession('alpha', 'beta', 'start trigger');
    expect(trigger).toMatchObject({ messageId: 2, status: 'queued' });
    expect(await messaging.cancelMessage(trigger.messageId, 'alpha')).toBe('Message #2 cancelled.');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(starts).toBe(1);
    expect(store.getMessage(1)?.status).toBe('pending');
    expect(store.getMessage(2)?.status).toBe('cancelled');
    messaging.stop();
  });

  it('revalidates a queued start retry after cancellation wins the recipient serializer', async () => {
    store.insertDirectMessage('source', 'beta', 'older pending');
    let starts = 0;
    let rejectSecond: ((reason: Error) => void) | undefined;
    let markSecondStarted: (() => void) | undefined;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const secondLaunch = new Promise<string>((_resolve, reject) => {
      rejectSecond = reject;
    });
    const delivery = {
      enqueueOnly: () => undefined,
      drainNow: async () => undefined,
      queueDrainMs: () => 50,
      pendingCount: () => 0,
      cancel: () => 'not-found' as const,
      acquireSubmissionLease: () => () => undefined,
    } as unknown as DeliveryQueue;
    const messaging = new Messaging({
      store,
      delivery,
      states,
      sessions: () => sessions,
      startSession: async () => {
        starts += 1;
        if (starts === 1) throw new Error('first launch failed');
        if (starts === 2) {
          markSecondStarted?.();
          return secondLaunch;
        }
        return 'beta started.';
      },
    });

    const trigger = await messaging.sendToSession('alpha', 'beta', 'start trigger', 'trigger-key');
    const duplicate = messaging.sendToSession('alpha', 'beta', 'duplicate', 'trigger-key');
    await secondStarted;
    const cancellation = messaging.cancelMessage(trigger.messageId, 'alpha');
    await new Promise((resolve) => setTimeout(resolve, 60));
    rejectSecond?.(new Error('second launch failed'));

    await expect(duplicate).resolves.toMatchObject({ messageId: trigger.messageId, status: 'queued' });
    await expect(cancellation).resolves.toBe(`Message #${String(trigger.messageId)} cancelled.`);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(starts).toBe(2);
    expect(store.getMessage(1)?.status).toBe('pending');
    expect(store.getMessage(trigger.messageId)?.status).toBe('cancelled');
    messaging.stop();
  });

  it('revalidates an idempotent duplicate start after queued cancellation completes', async () => {
    store.insertDirectMessage('source', 'beta', 'older pending');
    let starts = 0;
    let rejectSecond: ((reason: Error) => void) | undefined;
    let markSecondStarted: (() => void) | undefined;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const secondLaunch = new Promise<string>((_resolve, reject) => {
      rejectSecond = reject;
    });
    const delivery = {
      enqueueOnly: () => undefined,
      drainNow: async () => undefined,
      queueDrainMs: () => 1_000,
      pendingCount: () => 0,
      cancel: () => 'not-found' as const,
      acquireSubmissionLease: () => () => undefined,
    } as unknown as DeliveryQueue;
    const messaging = new Messaging({
      store,
      delivery,
      states,
      sessions: () => sessions,
      startSession: async () => {
        starts += 1;
        if (starts === 1) throw new Error('first launch failed');
        if (starts === 2) {
          markSecondStarted?.();
          return secondLaunch;
        }
        return 'beta started.';
      },
    });

    const trigger = await messaging.sendToSession('alpha', 'beta', 'start trigger', 'trigger-key');
    const firstDuplicate = messaging.sendToSession('alpha', 'beta', 'first duplicate', 'trigger-key');
    await secondStarted;
    const cancellation = messaging.cancelMessage(trigger.messageId, 'alpha');
    const queuedDuplicate = messaging.sendToSession('alpha', 'beta', 'queued duplicate', 'trigger-key');
    rejectSecond?.(new Error('second launch failed'));

    await firstDuplicate;
    await expect(cancellation).resolves.toBe(`Message #${String(trigger.messageId)} cancelled.`);
    await expect(queuedDuplicate).resolves.toMatchObject({ messageId: trigger.messageId, status: 'cancelled' });
    expect(starts).toBe(2);
    expect(store.getMessage(1)?.status).toBe('pending');
    expect(store.getMessage(trigger.messageId)?.status).toBe('cancelled');
    messaging.stop();
  });

  it('contains repeated recovery-query failures and keeps retrying the durable row', async () => {
    const pane = await backend.createPane('beta', 'pane');
    states.setSession('beta', pane.id);
    states.setReady('beta');
    const queue = new DeliveryQueue({
      backend,
      runtimeFor: () => new FakeRuntime(),
      getPane: (session) => (session === 'beta' ? { backend: 'fake', id: pane.id } : undefined),
      isPaused: (session) => states.isPaused(session),
      config: { ...CONFIG, queueDrainMs: 1 },
    });
    queues.push(queue);
    const messaging = makeMessaging(queue);
    const originalPending = store.getPendingDeliveries.bind(store);
    let queries = 0;
    const pending = vi.spyOn(store, 'getPendingDeliveries').mockImplementation((recipient) => {
      queries += 1;
      if (queries <= 3) throw new Error(`query failure ${String(queries)}`);
      return originalPending(recipient);
    });

    try {
      await expect(messaging.sendToSession('alpha', 'beta', 'retry query')).resolves.toMatchObject({
        status: 'queued',
      });
      await expect.poll(() => store.getMessage(1)?.status).toBe('delivered');
      expect(queries).toBeGreaterThan(3);
    } finally {
      pending.mockRestore();
      messaging.stop();
    }
  });

  it('emits content-free direct-message lifecycle facts and excludes broadcasts', async () => {
    const pane = await backend.createPane('beta', 'pane');
    states.setSession('beta', pane.id);
    states.setReady('beta');
    const runtime = new FakeRuntime();
    const queue = makeQueue(runtime, pane.id);
    const events = new FakeEventPublisher();
    const messaging = makeMessaging(queue, events);

    await messaging.sendToSession('alpha', 'beta', 'héllo secret');
    await messaging.broadcast('alpha', 'broadcast secret');

    expect(events.events).toEqual([
      { type: 'message.created', receiptId: 1, sender: 'alpha', recipient: 'beta', byteCount: 13 },
      { type: 'message.delivered', receiptId: 1, sender: 'alpha', recipient: 'beta' },
    ]);
    expect(JSON.stringify(events.events)).not.toContain('secret');
  });

  it('emits requested cancellation only after the pending receipt changes state', async () => {
    const pane = await backend.createPane('beta', 'pane');
    states.setSession('beta', pane.id);
    states.setReady('beta');
    const runtime = new FakeRuntime();
    runtime.inputState = 'draft';
    const queue = makeQueue(runtime, pane.id);
    const events = new FakeEventPublisher();
    const messaging = makeMessaging(queue, events);

    await messaging.sendToSession('alpha', 'beta', 'cancel me');
    expect(await messaging.cancelMessage(1, 'alpha')).toBe('Message #1 cancelled.');
    expect(events.events.at(-1)).toEqual({
      type: 'message.cancelled',
      receiptId: 1,
      sender: 'alpha',
      recipient: 'beta',
      reason: 'requested',
    });
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
    expect(await messaging.cancelMessage(1, 'alpha')).toBe('Message #1 cancelled.');
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

  it('records a specific flush state for sequential receipts waiting behind an occupied head', async () => {
    const pane = await backend.createPane('beta', 'pane');
    states.setSession('beta', pane.id);
    states.setReady('beta');
    const runtime = new FakeRuntime();
    runtime.inputState = 'draft';
    const queue = makeQueue(runtime, pane.id);
    const messaging = makeMessaging(queue);

    await messaging.sendToSession('alpha', 'beta', 'first');
    await messaging.sendToSession('alpha', 'beta', 'second');

    expect(JSON.parse(messaging.messageStatus(1, 'alpha'))).toMatchObject({
      status: 'pending',
      flushSkipReason: 'input-occupied',
    });
    expect(JSON.parse(messaging.messageStatus(2, 'alpha'))).toMatchObject({
      status: 'pending',
      flushSkipReason: 'waiting-behind-earlier-message',
    });
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
    expect(await messaging.cancelMessage(1, 'beta')).toBe('Message #1 was not found.');
    expect(store.getMessage(1)?.status).toBe('pending');
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

  function makeQueue(runtime: FakeRuntime, paneId: string): DeliveryQueue {
    const queue = new DeliveryQueue({
      backend,
      runtimeFor: () => runtime,
      getPane: (session) => (session === 'beta' ? { backend: 'fake', id: paneId } : undefined),
      isPaused: (session) => states.isPaused(session),
      config: CONFIG,
    });
    queues.push(queue);
    return queue;
  }

  function makeMessaging(
    delivery: DeliveryQueue,
    events?: FakeEventPublisher,
    pausedNotice?: (codename: string) => string | undefined,
  ): Messaging {
    return new Messaging({
      store,
      delivery,
      states,
      sessions: () => sessions,
      startSession: async () => 'started',
      pausedNotice,
      events,
    });
  }
});
