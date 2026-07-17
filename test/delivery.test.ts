import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeliveryQueue } from '../src/core/delivery.js';
import type { PaneRef } from '../src/core/types.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';

const CONFIG = { queueDrainMs: 2000, queueMaxAgeMs: 60_000 };

let backend: FakeTerminalBackend;
let runtime: FakeRuntime;
let queue: DeliveryQueue;
let pane: PaneRef;

beforeEach(async () => {
  vi.useFakeTimers();
  backend = new FakeTerminalBackend();
  runtime = new FakeRuntime();
  pane = await backend.createPane('alpha', 'pane');
  queue = new DeliveryQueue({
    backend,
    runtimeFor: () => runtime,
    getPane: (session) => (session === 'alpha' ? pane : undefined),
    config: CONFIG,
  });
});

afterEach(() => {
  queue.stop();
  vi.useRealTimers();
});

describe('DeliveryQueue', () => {
  it('delivers immediately when the input line is clear', async () => {
    const result = await queue.deliverOrQueue('alpha', 'hello');
    expect(result).toBe('delivered');
    expect(backend.panes.get(pane.id)?.received).toEqual(['hello']);
  });

  it('returns no-pane for sessions without a pane', async () => {
    expect(await queue.deliverOrQueue('ghost', 'hello')).toBe('no-pane');
  });

  it('queues when the input line is busy and drains when it clears', async () => {
    runtime.inputClear = false;
    expect(await queue.deliverOrQueue('alpha', 'one')).toBe('queued');
    expect(await queue.deliverOrQueue('alpha', 'two')).toBe('queued');
    expect(queue.pendingCount('alpha')).toBe(2);
    expect(backend.panes.get(pane.id)?.received).toEqual([]);

    // Still busy — drain does nothing.
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual([]);

    // Input clears — next drain delivers both, in order.
    runtime.inputClear = true;
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual(['one', 'two']);
    expect(queue.pendingCount('alpha')).toBe(0);
  });

  it('preserves FIFO order across queued and later messages', async () => {
    runtime.inputClear = false;
    await queue.deliverOrQueue('alpha', 'first');
    // Input clears, but a queued message exists — new sends must not jump the queue.
    runtime.inputClear = true;
    expect(await queue.deliverOrQueue('alpha', 'second')).toBe('queued');
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual(['first', 'second']);
  });

  it('force-delivers after queueMaxAgeMs even if input stays busy', async () => {
    runtime.inputClear = false;
    await queue.deliverOrQueue('alpha', 'stuck');
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual([]);

    vi.advanceTimersByTime(CONFIG.queueMaxAgeMs + 1);
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual(['stuck']);
  });

  it('drains automatically on the timer', async () => {
    runtime.inputClear = false;
    await queue.deliverOrQueue('alpha', 'later');
    runtime.inputClear = true;
    await vi.advanceTimersByTimeAsync(CONFIG.queueDrainMs + 1);
    expect(backend.panes.get(pane.id)?.received).toEqual(['later']);
  });

  it('drops queued messages when the pane dies', async () => {
    runtime.inputClear = false;
    await queue.deliverOrQueue('alpha', 'doomed');
    await backend.kill(pane);
    await queue.drainNow();
    expect(queue.pendingCount('alpha')).toBe(0);
  });

  it('treats unknown input state (null) as clear', async () => {
    runtime.inputClear = null;
    expect(await queue.deliverOrQueue('alpha', 'go')).toBe('delivered');
  });

  it('treats capture failures as clear rather than blocking forever', async () => {
    backend.capture = () => Promise.reject(new Error('osascript exploded'));
    expect(await queue.deliverOrQueue('alpha', 'resilient')).toBe('delivered');
  });

  it('queues instead of rejecting when the direct write throws (H1)', async () => {
    let failNext = true;
    backend.run = (pane, text) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('pane closed'));
      }
      return FakeTerminalBackend.prototype.run.call(backend, pane, text);
    };
    // The direct path throws; instead of an unhandled rejection it queues.
    expect(await queue.deliverOrQueue('alpha', 'important')).toBe('queued');
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual(['important']);
  });
});
