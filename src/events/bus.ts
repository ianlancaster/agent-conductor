import { randomUUID } from 'node:crypto';
import { log } from '../logger.js';
import type {
  ConductorEvent,
  ConductorEventInput,
  ConductorEventPublisher,
  ConductorEventSubscriber,
} from './types.js';

const DEFAULT_QUEUE_LIMIT = 1_000;
const OVERFLOW_WARNING_INTERVAL_MS = 60_000;

interface SubscriberState {
  subscriber: ConductorEventSubscriber;
  queue: ConductorEvent[];
  draining: boolean;
  lastOverflowWarningAt: number;
}

interface ConductorEventBusOptions {
  conductorInstanceId?: string;
  queueLimit?: number;
}

/**
 * Live, best-effort event fanout for embedding hosts and plugins.
 * Each subscriber gets an independent, ordered queue; slow or failed consumers
 * never block the Conductor or another subscriber.
 */
export class ConductorEventBus implements ConductorEventPublisher {
  readonly conductorInstanceId: string;
  private seq = 0;
  private readonly queueLimit: number;
  private readonly subscribers: SubscriberState[];

  constructor(
    private readonly fleetId: string,
    subscribers: readonly ConductorEventSubscriber[] = [],
    options: ConductorEventBusOptions = {},
  ) {
    this.conductorInstanceId = options.conductorInstanceId ?? randomUUID();
    this.queueLimit = options.queueLimit ?? DEFAULT_QUEUE_LIMIT;
    if (!Number.isInteger(this.queueLimit) || this.queueLimit < 1) {
      throw new Error('Event subscriber queue limit must be a positive integer.');
    }

    const names = new Set<string>();
    this.subscribers = subscribers.map((subscriber) => {
      if (typeof subscriber.name !== 'string') {
        throw new Error('Event subscriber names must be strings.');
      }
      const name = subscriber.name.trim();
      if (name.length === 0 || name !== subscriber.name) {
        throw new Error('Event subscriber names must be non-empty and have no surrounding whitespace.');
      }
      if (names.has(name)) throw new Error(`Duplicate event subscriber name '${name}'.`);
      if (typeof subscriber.onEvent !== 'function') {
        throw new Error(`Event subscriber '${name}' must define onEvent(event).`);
      }
      names.add(name);
      return { subscriber, queue: [], draining: false, lastOverflowWarningAt: 0 };
    });
  }

  emit(input: ConductorEventInput): ConductorEvent {
    const seq = ++this.seq;
    const payload = input.type === 'fleet.stalled' ? { ...input, sessions: Object.freeze([...input.sessions]) } : input;
    const event = Object.freeze({
      ...payload,
      schemaVersion: 1 as const,
      id: `${this.conductorInstanceId}:${String(seq)}`,
      seq,
      occurredAt: new Date().toISOString(),
      conductorInstanceId: this.conductorInstanceId,
      fleetId: this.fleetId,
    }) as ConductorEvent;

    for (const state of this.subscribers) {
      if (state.queue.length >= this.queueLimit) {
        state.queue.shift();
        const now = Date.now();
        if (now - state.lastOverflowWarningAt >= OVERFLOW_WARNING_INTERVAL_MS) {
          state.lastOverflowWarningAt = now;
          log().warn(
            'events',
            `Subscriber '${state.subscriber.name}' queue overflowed; oldest event dropped (sequence gaps reveal loss).`,
          );
        }
      }
      state.queue.push(event);
      this.scheduleDrain(state);
    }
    return event;
  }

  private scheduleDrain(state: SubscriberState): void {
    if (state.draining) return;
    state.draining = true;
    queueMicrotask(() => void this.drain(state));
  }

  private async drain(state: SubscriberState): Promise<void> {
    while (state.queue.length > 0) {
      const event = state.queue.shift();
      if (event === undefined) continue;
      try {
        await state.subscriber.onEvent(event);
      } catch (error) {
        log().warn(
          'events',
          `Subscriber '${state.subscriber.name}' rejected event ${event.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    state.draining = false;
    // An event can arrive after the loop observes empty but before draining is
    // cleared. Recheck so that event cannot be stranded.
    if (state.queue.length > 0) this.scheduleDrain(state);
  }
}
