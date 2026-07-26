import { describe, expect, it } from 'vitest';
import { ConductorEventBus } from '../src/events/bus.js';
import { CONDUCTOR_EVENT_TYPES, type ConductorEvent, type ConductorEventSubscriber } from '../src/events/types.js';

describe('ConductorEventBus', () => {
  it('assigns one globally ordered sequence and preserves FIFO per subscriber', async () => {
    const first: ConductorEvent[] = [];
    const second: ConductorEvent[] = [];
    const bus = new ConductorEventBus('fleet', [subscriber('first', first), subscriber('second', second)], {
      conductorInstanceId: 'instance',
    });

    bus.emit({ type: 'session.registered', session: 'alpha', cause: 'startup' });
    bus.emit({ type: 'session.ready', session: 'alpha' });
    await until(() => first.length === 2 && second.length === 2);

    expect(first.map((event) => event.seq)).toEqual([1, 2]);
    expect(second.map((event) => event.seq)).toEqual([1, 2]);
    expect(first[0]).toMatchObject({
      schemaVersion: 1,
      id: 'instance:1',
      conductorInstanceId: 'instance',
      fleetId: 'fleet',
    });
  });

  it('never blocks emission and isolates subscriber failures', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const received: number[] = [];
    let calls = 0;
    const slow: ConductorEventSubscriber = {
      name: 'slow',
      onEvent: async (event) => {
        calls += 1;
        if (calls === 1) await gate;
        received.push(event.seq);
        if (calls === 1) throw new Error('consumer failed');
      },
    };
    const bus = new ConductorEventBus('fleet', [slow]);

    bus.emit({ type: 'session.ready', session: 'alpha' });
    bus.emit({ type: 'session.ready', session: 'beta' });
    expect(calls).toBe(0);
    await until(() => calls === 1);
    expect(received).toEqual([]);
    release?.();
    await until(() => received.length === 2);
    expect(received).toEqual([1, 2]);
  });

  it('drops the oldest queued event on overflow and exposes the loss as a sequence gap', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const received: number[] = [];
    const bus = new ConductorEventBus(
      'fleet',
      [
        {
          name: 'blocked',
          onEvent: async (event) => {
            if (event.seq === 1) await gate;
            received.push(event.seq);
          },
        },
      ],
      { queueLimit: 2 },
    );

    bus.emit({ type: 'session.ready', session: 'one' });
    await until(() => received.length === 0); // let event 1 enter the subscriber
    await Promise.resolve();
    bus.emit({ type: 'session.ready', session: 'two' });
    bus.emit({ type: 'session.ready', session: 'three' });
    bus.emit({ type: 'session.ready', session: 'four' });
    release?.();
    await until(() => received.length === 3);
    expect(received).toEqual([1, 3, 4]);
  });

  it('publishes a deliberately small, stable event vocabulary', () => {
    expect(CONDUCTOR_EVENT_TYPES).toEqual([
      'session.registered',
      'session.deregistered',
      'session.started',
      'session.ready',
      'session.stopped',
      'session.activity.changed',
      'stall',
      'fleet.stalled',
      'schedule',
      'operator.request.created',
      'operator.request.resolved',
    ]);
  });

  it('rejects ambiguous subscriber registration', () => {
    expect(() => new ConductorEventBus('fleet', [{ name: ' ', onEvent: () => undefined }])).toThrow('non-empty');
    expect(
      () =>
        new ConductorEventBus('fleet', [
          { name: 'same', onEvent: () => undefined },
          { name: 'same', onEvent: () => undefined },
        ]),
    ).toThrow("Duplicate event subscriber name 'same'");
    expect(
      () => new ConductorEventBus('fleet', [{ name: 'missing-handler' } as unknown as ConductorEventSubscriber]),
    ).toThrow('must define onEvent(event)');
  });
});

function subscriber(name: string, events: ConductorEvent[]): ConductorEventSubscriber {
  return { name, onEvent: (event) => void events.push(event) };
}

async function until(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
