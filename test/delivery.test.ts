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
let ready: boolean;

beforeEach(async () => {
  vi.useFakeTimers();
  backend = new FakeTerminalBackend();
  runtime = new FakeRuntime();
  ready = true;
  pane = await backend.createPane('alpha', 'pane');
  queue = new DeliveryQueue({
    backend,
    runtimeFor: () => runtime,
    getPane: (session) => (session === 'alpha' ? pane : undefined),
    isReady: () => ready,
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

    // Input clears — messages drain ONE per pass (back-to-back paste+Enter
    // bursts leave later messages concatenated and unsubmitted in the composer).
    runtime.inputClear = true;
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual(['one']);
    expect(queue.pendingCount('alpha')).toBe(1);
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

  it('never force-delivers into a booting pane, even when overdue', async () => {
    // helper1-restart regression: notify envelopes went overdue while the pane
    // was relaunching, got typed over the boot sequence, and piled up
    // concatenated + unsubmitted in the composer. Overdue overrides busy, not not-up.
    runtime.inputClear = null;
    ready = false;
    await queue.deliverOrQueue('alpha', 'patient');
    vi.advanceTimersByTime(CONFIG.queueMaxAgeMs + 1);
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual([]);
    expect(queue.pendingCount('alpha')).toBe(1);

    // Runtime comes up → delivery proceeds.
    ready = true;
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual(['patient']);
  });

  it('force-delivers overdue messages one per pass, not as a burst', async () => {
    runtime.inputClear = false;
    await queue.deliverOrQueue('alpha', 'old-one');
    await queue.deliverOrQueue('alpha', 'old-two');
    vi.advanceTimersByTime(CONFIG.queueMaxAgeMs + 1);
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual(['old-one']);
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual(['old-one', 'old-two']);
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

  it('treats unknown input state (null) as clear once the session is ready', async () => {
    runtime.inputClear = null;
    expect(await queue.deliverOrQueue('alpha', 'go')).toBe('delivered');
  });

  it('queues while the session is booting: no runtime chrome AND not yet ready', async () => {
    // The launch-corruption bug: a message typed while the pane still shows a
    // shell executing the launch command splices into it. No chrome (null) +
    // no lifecycle event yet must queue, not type.
    runtime.inputClear = null;
    ready = false;
    expect(await queue.deliverOrQueue('alpha', 'PING-42')).toBe('queued');
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual([]);

    // First lifecycle event arrives → ready → next drain delivers.
    ready = true;
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual(['PING-42']);
  });

  it('visible runtime chrome proves the process is up even before any event', async () => {
    // Codex sends no start event — a visible, empty input line must unblock delivery.
    runtime.inputClear = true;
    ready = false;
    expect(await queue.deliverOrQueue('alpha', 'go')).toBe('delivered');
  });

  it('treats capture failures as clear rather than blocking forever (when ready)', async () => {
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
