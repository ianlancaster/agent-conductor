import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntegrationManager } from '../src/core/integration-manager.js';
import { ConductorEventBus } from '../src/events/bus.js';
import type {
  ConductorIntegration,
  ConductorIntegrationContext,
  IntegrationHealthUpdate,
} from '../src/integrations/types.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

describe('IntegrationManager', () => {
  it('rejects ambiguous, reserved, and duplicate integration names during construction', () => {
    const deps = baseOptions();
    expect(() => new IntegrationManager({ ...deps, integrations: [integration('Water-Cooler')] })).toThrow(
      'must be lowercase',
    );
    expect(() => new IntegrationManager({ ...deps, integrations: [integration('operator')] })).toThrow(
      "Integration name 'operator' is reserved",
    );
    expect(
      () =>
        new IntegrationManager({
          ...deps,
          integrations: [integration('water-cooler'), integration('water-cooler')],
        }),
    ).toThrow("Duplicate integration name 'water-cooler'");
    expect(
      () =>
        new IntegrationManager({
          ...deps,
          integrations: [{ name: 'missing-stop', start: () => undefined } as unknown as ConductorIntegration],
        }),
    ).toThrow('must define start(context) and stop()');
  });

  it('grants only the narrow context and preserves an owner-only durable state namespace', async () => {
    const contexts: ConductorIntegrationContext[] = [];
    const first = integration('water-cooler', {
      start: (context) => {
        contexts.push(context);
        context.reportHealth({ state: 'healthy' });
        writeFileSync(join(context.stateDir, 'cursor'), 'abc123');
      },
    });
    const options = baseOptions();
    const manager = new IntegrationManager({ ...options, integrations: [first] });

    await manager.start();
    const context = contexts[0];
    expect(context).toBeDefined();
    expect(Object.keys(context ?? {}).sort()).toEqual(['reportHealth', 'sendToSession', 'signal', 'stateDir']);
    expect(context?.stateDir).toBe(join(options.dataDir, 'integrations', 'water-cooler'));
    expect(statSync(context?.stateDir ?? '').mode & 0o777).toBe(0o700);
    expect(manager.status()).toMatchObject([
      {
        name: 'water-cooler',
        sender: 'integration:water-cooler',
        state: 'healthy',
      },
    ]);
    await manager.stop();

    const second = integration('water-cooler', {
      start: (nextContext) => {
        expect(readFileSync(join(nextContext.stateDir, 'cursor'), 'utf8')).toBe('abc123');
        nextContext.reportHealth({ state: 'healthy' });
      },
    });
    const restarted = new IntegrationManager({ ...options, integrations: [second] });
    await restarted.start();
    await restarted.stop();
  });

  it('hard-binds delivery identity, validates keys, and fences the capability after abort', async () => {
    let context: ConductorIntegrationContext | undefined;
    const send = vi.fn(async () => ({
      messageId: 7,
      recipient: 'assistant',
      status: 'delivered' as const,
      deduplicated: false,
    }));
    const manager = new IntegrationManager({
      ...baseOptions(),
      integrations: [
        integration('water-cooler', {
          start: (value) => {
            context = value;
            value.reportHealth({ state: 'healthy' });
          },
        }),
      ],
      sendToSession: send,
    });
    await manager.start();

    await expect(
      context?.sendToSession('assistant', 'changed', { idempotencyKey: 'repo:old:new' }),
    ).resolves.toMatchObject({ status: 'delivered' });
    expect(send).toHaveBeenCalledWith('water-cooler', 'assistant', 'changed', 'repo:old:new');
    await expect(context?.sendToSession('assistant', 'changed', { idempotencyKey: ' ' })).rejects.toThrow('non-blank');

    await manager.stop();
    await expect(context?.sendToSession('assistant', 'late', { idempotencyKey: 'repo:new:later' })).rejects.toThrow(
      'not active',
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not infer health from start success and bounds operator-visible health detail', async () => {
    let report: ((update: IntegrationHealthUpdate) => void) | undefined;
    const dates = [
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-01T00:00:01.000Z'),
      new Date('2026-01-01T00:00:02.000Z'),
    ];
    const manager = new IntegrationManager({
      ...baseOptions(),
      integrations: [
        integration('watcher', {
          start: (context) => {
            report = context.reportHealth;
          },
        }),
      ],
      now: () => dates.shift() ?? new Date('2026-01-01T00:00:03.000Z'),
    });

    await manager.start();
    expect(manager.status()[0]).toMatchObject({
      state: 'starting',
      updatedAt: '2026-01-01T00:00:01.000Z',
    });
    report?.({ state: 'degraded', detail: `  needs\n\u001battention ${'x'.repeat(300)} ` });
    const status = manager.status()[0];
    expect(status?.state).toBe('degraded');
    expect(status?.updatedAt).toBe('2026-01-01T00:00:02.000Z');
    expect(status?.detail).not.toContain('\n');
    expect(status?.detail).not.toContain('\u001b');
    expect(status?.detail).toHaveLength(240);
    await manager.stop();
  });

  it('isolates rejected and timed-out startup and invokes cleanup exactly once', async () => {
    const rejectedStop = vi.fn();
    const rejected = integration('rejected', {
      start: () => {
        throw new Error('credential-like private detail');
      },
      stop: rejectedStop,
    });
    let timedOutSignal: AbortSignal | undefined;
    const timedOutStop = vi.fn();
    const timedOut = integration('timed-out', {
      start: (context) => {
        timedOutSignal = context.signal;
        return new Promise<void>(() => undefined);
      },
      stop: timedOutStop,
    });
    const manager = new IntegrationManager({
      ...baseOptions(),
      integrations: [rejected, timedOut],
      startTimeoutMs: 10,
      stopTimeoutMs: 10,
    });

    await manager.start();
    expect(manager.status()).toMatchObject([
      { name: 'rejected', state: 'failed', detail: 'Integration failed to start.' },
      { name: 'timed-out', state: 'failed', detail: 'Integration failed to start.' },
    ]);
    expect(timedOutSignal?.aborted).toBe(true);
    expect(rejectedStop).toHaveBeenCalledTimes(1);
    expect(timedOutStop).toHaveBeenCalledTimes(1);

    await manager.stop();
    await manager.stop();
    expect(rejectedStop).toHaveBeenCalledTimes(1);
    expect(timedOutStop).toHaveBeenCalledTimes(1);
    expect(manager.status().every((status) => status.state === 'failed')).toBe(true);
  });

  it('withholds events until start succeeds and detaches before stopping', async () => {
    let releaseStart: (() => void) | undefined;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const received: number[] = [];
    let stopObservedAborted = false;
    let context: ConductorIntegrationContext | undefined;
    const events = new ConductorEventBus('fleet');
    const manager = new IntegrationManager({
      ...baseOptions(events),
      integrations: [
        integration('watcher', {
          start: async (value) => {
            context = value;
            await startGate;
            value.reportHealth({ state: 'healthy' });
          },
          stop: () => {
            stopObservedAborted = context?.signal.aborted === true;
          },
          onEvent: (event) => {
            received.push(event.seq);
          },
        }),
      ],
    });

    const starting = manager.start();
    events.emit({ type: 'session.ready', session: 'before' });
    await Promise.resolve();
    expect(received).toEqual([]);
    releaseStart?.();
    await starting;
    events.emit({ type: 'session.ready', session: 'after' });
    await until(() => received.length === 1);

    await manager.stop();
    expect(stopObservedAborted).toBe(true);
    events.emit({ type: 'session.ready', session: 'too-late' });
    await Promise.resolve();
    expect(received).toEqual([2]);
  });

  it('prevents an in-flight event callback from delivering after integration abort', async () => {
    let context: ConductorIntegrationContext | undefined;
    let releaseEvent: (() => void) | undefined;
    let markEntered: (() => void) | undefined;
    const eventGate = new Promise<void>((resolve) => {
      releaseEvent = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const send = vi.fn(async () => ({
      messageId: 1,
      recipient: 'assistant',
      status: 'delivered' as const,
      deduplicated: false,
    }));
    let deliveryError: unknown;
    const events = new ConductorEventBus('fleet');
    const manager = new IntegrationManager({
      ...baseOptions(events),
      integrations: [
        integration('watcher', {
          start: (value) => {
            context = value;
            value.reportHealth({ state: 'healthy' });
          },
          onEvent: async () => {
            markEntered?.();
            await eventGate;
            try {
              await context?.sendToSession('assistant', 'late event', { idempotencyKey: 'late' });
            } catch (error) {
              deliveryError = error;
            }
          },
        }),
      ],
      sendToSession: send,
    });
    await manager.start();
    events.emit({ type: 'session.ready', session: 'alpha' });
    await entered;

    await manager.stop();
    releaseEvent?.();
    await until(() => deliveryError !== undefined);

    expect(deliveryError).toBeInstanceOf(Error);
    expect(String(deliveryError)).toContain('not active');
    expect(send).not.toHaveBeenCalled();
  });

  it('fails and cleans up an integration whose event identity collides globally', async () => {
    const events = new ConductorEventBus('fleet', [{ name: 'integration:watcher', onEvent: () => undefined }]);
    const stop = vi.fn();
    const manager = new IntegrationManager({
      ...baseOptions(events),
      integrations: [
        integration('watcher', {
          start: (context) => context.reportHealth({ state: 'healthy' }),
          stop,
          onEvent: () => undefined,
        }),
      ],
    });

    await manager.start();
    expect(manager.status()).toMatchObject([
      { name: 'watcher', state: 'failed', detail: 'Integration failed to start.' },
    ]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('keeps failed status when bounded stop rejects or times out', async () => {
    const manager = new IntegrationManager({
      ...baseOptions(),
      integrations: [
        integration('reject-stop', {
          start: (context) => context.reportHealth({ state: 'healthy' }),
          stop: () => {
            throw new Error('stop failed');
          },
        }),
        integration('timeout-stop', {
          start: (context) => context.reportHealth({ state: 'healthy' }),
          stop: () => new Promise<void>(() => undefined),
        }),
      ],
      stopTimeoutMs: 10,
    });

    await manager.start();
    await manager.stop();
    expect(manager.status()).toMatchObject([
      { name: 'reject-stop', state: 'failed', detail: 'Integration failed to stop cleanly.' },
      { name: 'timeout-stop', state: 'failed', detail: 'Integration failed to stop cleanly.' },
    ]);
  });
});

function integration(name: string, overrides: Partial<ConductorIntegration> = {}): ConductorIntegration {
  return {
    name,
    start: () => undefined,
    stop: () => undefined,
    ...overrides,
  };
}

function baseOptions(events = new ConductorEventBus('fleet')): {
  dataDir: string;
  events: ConductorEventBus;
  sendToSession: () => Promise<{
    messageId: number;
    recipient: string;
    status: 'delivered';
    deduplicated: false;
  }>;
} {
  const root = mkdtempSync(join(tmpdir(), 'conductor-integration-'));
  roots.push(root);
  const dataDir = join(root, 'data');
  mkdirSync(dataDir, { recursive: true });
  return {
    dataDir,
    events,
    sendToSession: async () => ({
      messageId: 1,
      recipient: 'assistant',
      status: 'delivered',
      deduplicated: false,
    }),
  };
}

async function until(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
