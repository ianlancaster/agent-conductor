import { randomUUID } from 'node:crypto';
import { log } from '../logger.js';
import type {
  ConductorEvent,
  ConductorEventInput,
  ConductorEventJournal,
  ConductorEventJournalStatus,
  ConductorEventPublisher,
  ConductorEventSubscriber,
} from './types.js';

const DEFAULT_QUEUE_LIMIT = 1_000;
const OVERFLOW_WARNING_INTERVAL_MS = 60_000;
const JOURNAL_WARNING_INTERVAL_MS = 60_000;

interface SubscriberState {
  subscriber: ConductorEventSubscriber;
  queue: ConductorEvent[];
  draining: boolean;
  active: boolean;
  lastOverflowWarningAt: number;
}

interface ConductorEventBusOptions {
  conductorInstanceId?: string;
  queueLimit?: number;
  journal?: ConductorEventJournal;
  initialJournalDegraded?: boolean;
  onJournalFailure?: (error: unknown) => void;
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
  private readonly subscribers = new Map<string, SubscriberState>();
  private readonly journal: ConductorEventJournal | undefined;
  private journalDegraded: boolean;
  private journalFailureCount = 0;
  private journalLastError: string | undefined;
  private lastJournalWarningAt = 0;
  private readonly onJournalFailure: ((error: unknown) => void) | undefined;

  constructor(
    private readonly fleetId: string,
    subscribers: readonly ConductorEventSubscriber[] = [],
    options: ConductorEventBusOptions = {},
  ) {
    this.conductorInstanceId = options.conductorInstanceId ?? randomUUID();
    this.queueLimit = options.queueLimit ?? DEFAULT_QUEUE_LIMIT;
    this.journal = options.journal;
    this.journalDegraded = options.initialJournalDegraded ?? false;
    this.onJournalFailure = options.onJournalFailure;
    if (!Number.isInteger(this.queueLimit) || this.queueLimit < 1) {
      throw new Error('Event subscriber queue limit must be a positive integer.');
    }

    for (const subscriber of subscribers) this.subscribe(subscriber);
  }

  /**
   * Attach a live subscriber and return an exact, idempotent detach closure.
   * Detaching drops queued work. A callback already in progress may finish,
   * but its queue will not continue draining afterward.
   */
  subscribe(subscriber: ConductorEventSubscriber): () => void {
    if (typeof subscriber.name !== 'string') {
      throw new Error('Event subscriber names must be strings.');
    }
    const name = subscriber.name.trim();
    if (name.length === 0 || name !== subscriber.name) {
      throw new Error('Event subscriber names must be non-empty and have no surrounding whitespace.');
    }
    if (this.subscribers.has(name)) throw new Error(`Duplicate event subscriber name '${name}'.`);
    if (typeof subscriber.onEvent !== 'function') {
      throw new Error(`Event subscriber '${name}' must define onEvent(event).`);
    }
    const state: SubscriberState = {
      subscriber,
      queue: [],
      draining: false,
      active: true,
      lastOverflowWarningAt: 0,
    };
    this.subscribers.set(name, state);
    return () => {
      if (!state.active) return;
      state.active = false;
      state.queue.length = 0;
      if (this.subscribers.get(name) === state) this.subscribers.delete(name);
    };
  }

  emit(input: ConductorEventInput): ConductorEvent {
    const seq = ++this.seq;
    const payload =
      input.type === 'fleet.stalled'
        ? { ...input, sessions: Object.freeze([...input.sessions]) }
        : input.type === 'runbook.adopted' || input.type === 'runbook.superseded'
          ? { ...input, sessions: Object.freeze(input.sessions.map((session) => Object.freeze({ ...session }))) }
          : input;
    const event = Object.freeze({
      ...payload,
      schemaVersion: 1 as const,
      id: `${this.conductorInstanceId}:${String(seq)}`,
      seq,
      occurredAt: new Date().toISOString(),
      conductorInstanceId: this.conductorInstanceId,
      fleetId: this.fleetId,
    }) as ConductorEvent;

    if (this.journal !== undefined) {
      try {
        this.journal.appendEvent(event);
      } catch (error) {
        this.journalDegraded = true;
        this.journalFailureCount += 1;
        this.journalLastError = error instanceof Error ? error.message : String(error);
        try {
          this.onJournalFailure?.(error);
        } catch {
          // The degradation reporter is best-effort too; event emission must continue.
        }
        const now = Date.now();
        if (now - this.lastJournalWarningAt >= JOURNAL_WARNING_INTERVAL_MS) {
          this.lastJournalWarningAt = now;
          log().error(
            'events',
            `Durable event journal write failed; continuing with incomplete telemetry: ${this.journalLastError}`,
          );
        }
      }
    }

    for (const state of this.subscribers.values()) {
      if (!state.active) continue;
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

  journalStatus(): ConductorEventJournalStatus {
    return {
      enabled: this.journal !== undefined,
      degraded: this.journalDegraded,
      failureCount: this.journalFailureCount,
      ...(this.journalLastError === undefined ? {} : { lastError: this.journalLastError }),
    };
  }

  private scheduleDrain(state: SubscriberState): void {
    if (!state.active || state.draining) return;
    state.draining = true;
    queueMicrotask(() => void this.drain(state));
  }

  private async drain(state: SubscriberState): Promise<void> {
    while (state.active && state.queue.length > 0) {
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
    if (!state.active) state.queue.length = 0;
    state.draining = false;
    // An event can arrive after the loop observes empty but before draining is
    // cleared. Recheck so that event cannot be stranded.
    if (state.active && state.queue.length > 0) this.scheduleDrain(state);
  }
}
