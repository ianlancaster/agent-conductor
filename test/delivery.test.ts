import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeliveryQueue } from '../src/core/delivery.js';
import type { PaneRef } from '../src/core/types.js';
import { parseClaudeInputState } from '../src/runtimes/claude-code/chrome.js';
import { CodexRuntime } from '../src/runtimes/codex/index.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';

const CONFIG = { queueDrainMs: 2000, queueMaxAgeMs: 60_000 };

let backend: FakeTerminalBackend;
let runtime: FakeRuntime;
let queue: DeliveryQueue;
let pane: PaneRef;
let deliveryEvents: string[];
let runtimeObservations: string[];

beforeEach(async () => {
  vi.useFakeTimers();
  backend = new FakeTerminalBackend();
  runtime = new FakeRuntime();
  deliveryEvents = [];
  runtimeObservations = [];
  pane = await backend.createPane('alpha', 'pane');
  queue = new DeliveryQueue({
    backend,
    runtimeFor: () => runtime,
    getPane: (session) => (session === 'alpha' ? pane : undefined),
    onRuntimeObserved: (session) => runtimeObservations.push(session),
    onDelivered: (session) => deliveryEvents.push(session),
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
    expect(deliveryEvents).toEqual(['alpha']);
  });

  it("delivers to Codex's plain-text idle placeholder on iTerm", async () => {
    runtime.parseInputState = (capture: string, session?: string) =>
      new CodexRuntime({ config: { binary: 'codex', toolTimeoutSec: 600 }, baseDir: '/tmp' }).parseInputState(
        capture,
        session,
      );
    backend.setPaneContent(pane.id, "finished previous turn\n\n› What's on your mind?\n  gpt-5.6 medium · /repo");

    await expect(queue.deliverOrQueue('alpha', 'the stalled envelope')).resolves.toBe('delivered');
    expect(backend.panes.get(pane.id)?.received).toEqual(['the stalled envelope']);
  });

  it('returns no-pane for sessions without a pane', async () => {
    expect(await queue.deliverOrQueue('ghost', 'hello')).toBe('no-pane');
  });

  it('keeps a durable no-pane delivery in the periodic queue during a restart', async () => {
    expect(await queue.deliverOrQueue('ghost', 'survive restart', { deliveryId: 42 })).toBe('queued');
    expect(queue.pendingCount('ghost')).toBe(1);
    expect(queue.cancel('ghost', 42)).toBe('cancelled');
  });

  it('queues when the input line is busy and drains when it clears', async () => {
    runtime.inputState = 'draft';
    expect(await queue.deliverOrQueue('alpha', 'one')).toBe('queued');
    expect(await queue.deliverOrQueue('alpha', 'two')).toBe('queued');
    expect(queue.pendingCount('alpha')).toBe(2);
    expect(backend.panes.get(pane.id)?.received).toEqual([]);
    expect(deliveryEvents).toEqual([]);

    // Still busy — drain does nothing.
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual([]);

    // Input clears — messages drain ONE per pass (back-to-back paste+Enter
    // bursts leave later messages concatenated and unsubmitted in the composer).
    runtime.inputState = 'clear';
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual(['one']);
    expect(queue.pendingCount('alpha')).toBe(1);
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual(['one', 'two']);
    expect(queue.pendingCount('alpha')).toBe(0);
    expect(deliveryEvents).toEqual(['alpha', 'alpha']);
  });

  it('does not clobber text typed after the clear-composer capture', async () => {
    runtime.parseInputState = (capture: string) => parseClaudeInputState(capture);
    backend.setPaneContent(pane.id, 'output\n❯ ');
    const captureForDelivery = backend.captureForDelivery.bind(backend);
    let first = true;
    backend.captureForDelivery = async (target, lines) => {
      const observation = await captureForDelivery(target, lines);
      if (first) {
        first = false;
        // Reproduce the operator beginning a draft after delivery observed an
        // empty composer but before it attempted the pane write.
        backend.setPaneContent(pane.id, 'output\n❯ operator draft must survive');
      }
      return observation;
    };

    const attempts: (string | null)[] = [];
    expect(
      await queue.deliverOrQueue('alpha', '[Stall] incoming', {
        onAttempt: (reason) => attempts.push(reason),
      }),
    ).toBe('queued');
    expect(backend.panes.get(pane.id)?.received).toEqual([]);
    expect(queue.pendingCount('alpha')).toBe(1);
    expect(attempts).toEqual(['pane-changed']);

    backend.setPaneContent(pane.id, 'output\n❯ ');
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual(['[Stall] incoming']);
  });

  it('rechecks a durable cancellation policy before draining a previously safe message', async () => {
    runtime.inputState = 'draft';
    let expired = false;
    let cancellations = 0;
    expect(
      await queue.deliverOrQueue('alpha', 'expires while queued', {
        deliveryId: 42,
        shouldCancel: () => expired,
        onCancelled: () => {
          cancellations += 1;
        },
      }),
    ).toBe('queued');

    expired = true;
    runtime.inputState = 'clear';
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual([]);
    expect(queue.pendingCount('alpha')).toBe(0);
    expect(cancellations).toBe(1);
  });

  it('reports why a flush was skipped and clears the reason on delivery', async () => {
    const attempts: (string | null)[] = [];
    runtime.inputState = 'draft';
    await queue.deliverOrQueue('alpha', 'observable', {
      deliveryId: 42,
      onAttempt: (reason) => attempts.push(reason),
    });
    expect(attempts).toEqual(['input-occupied']);

    runtime.inputState = 'clear';
    await queue.drainNow();
    expect(attempts).toEqual(['input-occupied', null]);
  });

  it('cancels a queued delivery by durable receipt id', async () => {
    runtime.inputState = 'draft';
    await queue.deliverOrQueue('alpha', 'do not send', { deliveryId: 42 });
    expect(queue.cancel('alpha', 42)).toBe('cancelled');

    runtime.inputState = 'clear';
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual([]);
    expect(queue.pendingCount('alpha')).toBe(0);
  });

  it('refuses cancellation once a pane write has begun', async () => {
    let releaseWrite: (() => void) | undefined;
    backend.run = async () => {
      await new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
    };
    const delivery = queue.deliverOrQueue('alpha', 'already going', { deliveryId: 42 });
    await Promise.resolve();
    await Promise.resolve();
    expect(releaseWrite).toBeDefined();
    expect(queue.cancel('alpha', 42)).toBe('in-flight');
    releaseWrite?.();
    await expect(delivery).resolves.toBe('delivered');
  });

  it('preserves FIFO order across queued and later messages', async () => {
    runtime.inputState = 'draft';
    await queue.deliverOrQueue('alpha', 'first');
    // Input clears, but a queued message exists — new sends must not jump the queue.
    runtime.inputState = 'clear';
    expect(await queue.deliverOrQueue('alpha', 'second')).toBe('queued');
    await queue.drainNow();
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual(['first', 'second']);
  });

  it('NEVER force-delivers over a signed Conductor draft, regardless of age', async () => {
    runtime.inputState = 'draft';
    await queue.deliverOrQueue('alpha', 'stuck');
    vi.advanceTimersByTime(CONFIG.queueMaxAgeMs * 10);
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual([]);
    expect(queue.pendingCount('alpha')).toBe(1);

    runtime.inputState = 'clear';
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual(['stuck']);
  });

  it('NEVER force-delivers over an unsigned draft, regardless of age', async () => {
    runtime.inputState = 'draft';
    await queue.deliverOrQueue('alpha', 'polite-one');
    await queue.deliverOrQueue('alpha', 'polite-two');

    vi.advanceTimersByTime(CONFIG.queueMaxAgeMs * 10);
    await queue.drainNow();
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual([]);
    expect(queue.pendingCount('alpha')).toBe(2);

    // Operator submits (or deletes) their draft — the queue releases in order.
    runtime.inputState = 'clear';
    await queue.drainNow();
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual(['polite-one', 'polite-two']);
    expect(queue.pendingCount('alpha')).toBe(0);
  });

  it('releases held messages on the timer as soon as the operator input clears', async () => {
    runtime.inputState = 'draft';
    await queue.deliverOrQueue('alpha', 'waiting');
    vi.advanceTimersByTime(CONFIG.queueMaxAgeMs * 2);
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual([]);

    runtime.inputState = 'clear';
    await vi.advanceTimersByTimeAsync(CONFIG.queueDrainMs + 1);
    expect(backend.panes.get(pane.id)?.received).toEqual(['waiting']);
  });

  it('never delivers into a booting or otherwise unclassified pane', async () => {
    // helper1-restart regression: notify envelopes went overdue while the pane
    // was relaunching, got typed over the boot sequence, and piled up
    // concatenated + unsubmitted in the composer.
    runtime.inputState = null;
    await queue.deliverOrQueue('alpha', 'patient');
    vi.advanceTimersByTime(CONFIG.queueMaxAgeMs + 1);
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual([]);
    expect(queue.pendingCount('alpha')).toBe(1);

    // Only explicit empty composer chrome releases the message.
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual([]);
    runtime.inputState = 'clear';
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual(['patient']);
  });

  it('holds every queued message behind a draft, then drains one per clear pass', async () => {
    runtime.inputState = 'draft';
    await queue.deliverOrQueue('alpha', 'old-one');
    await queue.deliverOrQueue('alpha', 'old-two');
    vi.advanceTimersByTime(CONFIG.queueMaxAgeMs * 10);
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual([]);

    runtime.inputState = 'clear';
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual(['old-one']);
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual(['old-one', 'old-two']);
  });

  it('drains automatically on the timer', async () => {
    runtime.inputState = 'draft';
    await queue.deliverOrQueue('alpha', 'later');
    runtime.inputState = 'clear';
    await vi.advanceTimersByTimeAsync(CONFIG.queueDrainMs + 1);
    expect(backend.panes.get(pane.id)?.received).toEqual(['later']);
  });

  it('retains queued messages across an agent pane restart', async () => {
    runtime.inputState = 'draft';
    await queue.deliverOrQueue('alpha', 'doomed');
    await backend.kill(pane);
    await queue.drainNow();
    expect(queue.pendingCount('alpha')).toBe(1);

    pane = await backend.createPane('alpha', 'pane');
    runtime.inputState = 'clear';
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual(['doomed']);
    expect(queue.pendingCount('alpha')).toBe(0);
  });

  it('queues unknown input state even after the session is ready', async () => {
    runtime.inputState = null;
    expect(await queue.deliverOrQueue('alpha', 'go')).toBe('queued');
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual([]);

    runtime.inputState = 'clear';
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual(['go']);
  });

  it.each([
    {
      runtimeName: 'Claude Code',
      firstLine: '❯ a very long unsigned operator draft',
      clearCapture: 'output\n❯ ',
      parse: (capture: string) => parseClaudeInputState(capture),
    },
    {
      runtimeName: 'Codex',
      firstLine: '› a very long unsigned operator draft',
      clearCapture: 'output\n› \n  gpt-5.6 medium · /repo',
      parse: (capture: string) =>
        new CodexRuntime({ config: { binary: 'codex', toolTimeoutSec: 600 }, baseDir: '/tmp' }).parseInputState(
          capture,
        ),
    },
  ])('does not clobber a multiline $runtimeName draft whose prompt glyph scrolled out of capture', async (sample) => {
    runtime.parseInputState = sample.parse;
    backend.setPaneContent(
      pane.id,
      [sample.firstLine, ...Array.from({ length: 30 }, (_, index) => `  continuation line ${String(index)}`)].join(
        '\n',
      ),
    );

    // Delivery captures only the trailing 10 lines. The opening composer
    // glyph is outside that window, so the runtime returns unknown. Unknown
    // must queue indefinitely, never fall through readiness to a write.
    expect(await queue.deliverOrQueue('alpha', 'incoming peer message')).toBe('queued');
    vi.advanceTimersByTime(CONFIG.queueMaxAgeMs * 100);
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual([]);

    backend.setPaneContent(pane.id, sample.clearCapture);
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual(['incoming peer message']);
  });

  it('queues while the session is booting: no runtime chrome AND not yet ready', async () => {
    // The launch-corruption bug: a message typed while the pane still shows a
    // shell executing the launch command splices into it. No chrome (null) +
    // no lifecycle event yet must queue, not type.
    runtime.inputState = null;
    expect(await queue.deliverOrQueue('alpha', 'PING-42')).toBe('queued');
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual([]);

    // No lifecycle/readiness signal can override uncertain input.
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual([]);
    runtime.inputState = 'clear';
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual(['PING-42']);
  });

  it('visible runtime chrome proves the process is up even before any event', async () => {
    // Codex sends no start event — a visible, empty input line must unblock delivery.
    runtime.inputState = 'clear';
    expect(await queue.deliverOrQueue('alpha', 'go')).toBe('delivered');
    expect(runtimeObservations).toEqual(['alpha']);
  });

  it('queues on capture failure and releases only after a clear capture', async () => {
    const captureForDelivery = backend.captureForDelivery.bind(backend);
    backend.captureForDelivery = () => Promise.reject(new Error('osascript exploded'));
    expect(await queue.deliverOrQueue('alpha', 'resilient')).toBe('queued');
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual([]);

    backend.captureForDelivery = captureForDelivery;
    await queue.drainNow();
    expect(backend.panes.get(pane.id)?.received).toEqual(['resilient']);
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

  it('retains a queued item when its drain write throws, then retries it', async () => {
    runtime.inputState = 'draft';
    const receipts: string[] = [];
    await queue.deliverOrQueue('alpha', 'important', { onDelivered: () => receipts.push('done') });
    runtime.inputState = 'clear';

    let failNext = true;
    backend.run = (targetPane, text) => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('osascript timed out'));
      }
      return FakeTerminalBackend.prototype.run.call(backend, targetPane, text);
    };

    await queue.drainNow();
    expect(queue.pendingCount('alpha')).toBe(1);
    expect(receipts).toEqual([]);
    await queue.drainNow();
    expect(queue.pendingCount('alpha')).toBe(0);
    expect(backend.panes.get(pane.id)?.received).toEqual(['important']);
    expect(receipts).toEqual(['done']);
  });
});
