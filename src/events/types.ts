import type { RuntimeName } from '../config/schema.js';
import type { Activity } from '../core/types.js';

export const CONDUCTOR_EVENT_TYPES = [
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
] as const;

export type ConductorEventType = (typeof CONDUCTOR_EVENT_TYPES)[number];

export interface ConductorEventEnvelope {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly seq: number;
  readonly occurredAt: string;
  /** Fresh for each Supervisor construction; distinguishes restarts and sequence domains. */
  readonly conductorInstanceId: string;
  readonly fleetId: string;
}

export type ConductorEvent = ConductorEventEnvelope &
  (
    | {
        readonly type: 'session.registered';
        readonly session: string;
        readonly cause: 'startup' | 'config-added';
      }
    | {
        readonly type: 'session.deregistered';
        readonly session: string;
        readonly cause: 'config-removed' | 'teardown';
      }
    | {
        readonly type: 'session.started';
        readonly session: string;
        readonly cause: 'start' | 'continue' | 'adopt' | 'discovered';
        readonly runtime: RuntimeName;
      }
    | { readonly type: 'session.ready'; readonly session: string }
    | {
        readonly type: 'session.stopped';
        readonly session: string;
        readonly cause: 'requested' | 'runtime-exit' | 'pane-missing' | 'launch-failed';
      }
    | {
        readonly type: 'session.activity.changed';
        readonly session: string;
        readonly previous: Activity;
        readonly activity: Activity;
      }
    | {
        readonly type: 'stall';
        readonly session: string;
        readonly kind: 'idle' | 'blocked' | 'compaction' | 'silent';
        readonly disposition:
          'routed' | 'suppressed' | 'reported-to-operator' | 'sentinel-down' | 'ignored-auto-off' | 'ignored-paused';
      }
    | {
        readonly type: 'fleet.stalled';
        readonly sessions: readonly string[];
        readonly disposition: 'routed' | 'reported-to-operator' | 'sentinel-down';
      }
    | {
        readonly type: 'schedule';
        readonly session: string;
        readonly label: string;
        readonly outcome: 'fired' | 'fired-fresh' | 'deferred-paused' | 'failed';
      }
    | {
        readonly type: 'operator.request.created';
        readonly session: string;
        readonly requestId: number;
        readonly optionCount: number;
      }
    | {
        readonly type: 'operator.request.resolved';
        readonly session: string;
        readonly requestId: number;
        /** One-based option number, matching the public response command. */
        readonly selectedOption: number;
      }
  );

type EnvelopeKey = keyof ConductorEventEnvelope;
export type ConductorEventInput = ConductorEvent extends infer Event
  ? Event extends ConductorEvent
    ? Omit<Event, EnvelopeKey>
    : never
  : never;

/** Observation-only extension point. Subscribers cannot inject events or affect core control flow. */
export interface ConductorEventSubscriber {
  readonly name: string;
  onEvent(event: ConductorEvent): void | Promise<void>;
}

export interface ConductorEventPublisher {
  emit(event: ConductorEventInput): ConductorEvent;
}
