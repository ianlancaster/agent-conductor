# Event subscribers for plugins and integrations

Agent Conductor exposes a typed, observation-only event stream to embedding hosts. Use it when a
plugin or integration needs to react to fleet facts—session lifecycle, activity transitions,
stalls, schedule outcomes, or operator-request state—without polling status or tailing terminals.

This is constructor injection into `Supervisor`, not a plugin loader or a network transport. The
host constructs subscribers, owns their configuration and secrets, and passes them through
`SupervisorOptions.eventSubscribers`. The stock `conductor` CLI does not load arbitrary modules
from fleet YAML.

```js
import { Supervisor } from 'agent-conductor';

const events = {
  name: 'my-plugin',
  async onEvent(event) {
    if (event.type === 'stall' && event.disposition === 'routed') {
      await myPlugin.recordRoutedStall(event);
    }
  },
};

const supervisor = new Supervisor('/path/to/fleet', {
  eventSubscribers: [events],
});
await supervisor.start();
```

TypeScript consumers can import `ConductorEvent`, `ConductorEventSubscriber`,
`ConductorEventType`, and `CONDUCTOR_EVENT_TYPES` from the package root. Treat unknown event types
and additional object fields as forward-compatible input.

## Delivery contract

The stream is deliberately live and best-effort:

- `seq` is a globally increasing number within one Supervisor process. Every subscriber observes
  the same event sequence; each subscriber is invoked serially in FIFO order.
- `conductorInstanceId` is a fresh UUID for each Supervisor construction. The pair
  `(conductorInstanceId, seq)` defines the ordering domain, and `id` is their joined correlation
  value. A changed instance ID means the Conductor restarted.
- Live callback delivery is at most once. There is no subscriber replay, cursor, retry, or
  receipt API. A consumer that needs current truth after a restart or sequence gap should
  reconcile through existing status and operation surfaces.
- Each subscriber has an independent bounded queue of 1,000 waiting events. On overflow,
  Conductor drops the oldest waiting event, logs a rate-limited warning, and continues. The next
  observed `seq` exposes the gap.
- Emission never awaits subscriber code. A slow subscriber cannot block lifecycle, messaging,
  delivery, health checks, or another subscriber.
- A thrown or rejected handler is logged and that event is dropped. The subscriber remains
  enabled and later events continue in order. Subscriber failures never propagate into core
  behavior.
- Supervisor shutdown does not wait for subscriber queues or in-flight handlers. Those
  observations can be lost if the embedding host exits, consistent with the live, at-most-once
  contract.
- The relationship is one-way: subscribers observe facts. Conductor never reads a result from a
  subscriber, and subscribers cannot inject events or alter the control path through this API.

The first-party local journal is deliberately separate from subscriber delivery. When
`events.journal.enabled` is true (the default), Conductor synchronously stores each envelope before
live fanout. Export the stored envelopes in insertion order without stopping the fleet:

```bash
conductor events export --format jsonl
conductor events export --format jsonl --since 2026-07-26T00:00:00Z
```

The journal is an append-only local record, not an outbox: it has no subscriber cursor, delivery
claim, retry, or acknowledgement API. An integration that needs durable delivery to another
process owns that transport boundary and can consume JSONL exports or persist live callbacks
idempotently. The journal grows without automatic retention in v1; operators should export,
archive, or rotate the fleet database according to their own evidence policy.

If a journal write fails, Conductor keeps lifecycle and messaging online, continues attempting
later writes, logs a rate-limited error, and records sticky degradation in fleet status and
`conductor doctor`. The marker survives restart because the historical gap still exists. An export
from a degraded journal is incomplete; sequence gaps identify failed writes within an instance.
After exporting the available rows and recording the affected instance and gap, delete
`<dataDir>/event-journal.degraded` to acknowledge the incident and re-arm detection for future
write failures. `conductor doctor` prints the exact marker path for the active fleet.

## Envelope and compatibility

Every event includes:

| Field                 | Meaning                                                  |
| --------------------- | -------------------------------------------------------- |
| `schemaVersion`       | Envelope version, currently `1`                          |
| `id`                  | Correlation ID: `<conductorInstanceId>:<seq>`            |
| `seq`                 | Monotonic sequence number for this instance              |
| `occurredAt`          | ISO-8601 time the core fact was emitted                  |
| `conductorInstanceId` | Fresh identity for this Supervisor construction          |
| `fleetId`             | Stable, non-secret slug derived from the fleet directory |
| `type`                | Discriminant for the typed event union                   |

Compatible releases may add event types or optional fields without changing `schemaVersion`.
Consumers should ignore fields they do not use and safely ignore unknown event types. A breaking
change to the envelope or existing field semantics requires a schema-version change.

Payloads are intentionally metadata-only. They may contain codenames, runtime names, mechanical
causes/dispositions, request IDs, option counts/indexes, and operator-authored schedule labels.
They never contain pane captures, transcript text, prompts, message bodies, credentials, local
paths, or arbitrary runtime reason strings.

## Event catalog

| Event                       | Payload beyond the envelope                                                       |
| --------------------------- | --------------------------------------------------------------------------------- |
| `session.registered`        | `session`; `cause: startup \| config-added`                                       |
| `session.deregistered`      | `session`; `cause: config-removed \| teardown`                                    |
| `session.started`           | `session`; `runtime`; cause; optional configured `launchModel` and `launchEffort` |
| `session.ready`             | `session`; emitted once when a run is first proven ready                          |
| `session.stopped`           | `session`; `cause: requested \| runtime-exit \| pane-missing \| launch-failed`    |
| `session.activity.changed`  | `session`; `previous`; `activity`; transition-only                                |
| `stall`                     | `session`; `kind`; mechanical `disposition`                                       |
| `fleet.stalled`             | `sessions`; `disposition: routed \| reported-to-operator \| sentinel-down`        |
| `schedule`                  | `session`; `label`; `outcome: fired \| fired-fresh \| deferred-paused \| failed`  |
| `operator.request.created`  | `session`; `requestId`; `optionCount`                                             |
| `operator.request.resolved` | `session`; `requestId`; one-based `selectedOption`                                |
| `runbook.adopted`           | adoption/runbook IDs, version, source, topic, operator approval, session roles    |
| `runbook.superseded`        | prior/replacement adoption IDs and replacement runbook metadata                   |
| `runbook.adoption.ended`    | `adoptionId`; `approvedBy: operator`                                              |
| `message.created`           | direct receipt ID, sender, recipient, UTF-8 `byteCount`                           |
| `message.delivered`         | direct receipt ID, sender, recipient                                              |
| `message.cancelled`         | direct receipt metadata; `reason: requested \| conductor-restarted`               |
| `workspace.provisioned`     | `session`; `kind: empty \| template \| worktree`                                  |
| `workspace.removed`         | `session`; `kind: directory \| worktree`                                          |

The `stall` dispositions are `routed`, `suppressed`, `reported-to-operator`, `sentinel-down`,
`ignored-auto-off`, and `ignored-paused`. Pause takes precedence when a session is both paused and
has auto disabled. The sentinel's own ordinary idle periods intentionally emit no stall event.

At startup, Conductor emits the complete `session.registered(cause=startup)` roster before any
surviving-pane `session.started(cause=adopt)` events. Activity and ready events follow the started
event for that run. A `session.stopped(cause=launch-failed)` event reports a failed start attempt
and can arrive without a preceding `session.started`; consumers must treat stopped events as
idempotent. Lifecycle causes reflect the mechanical detection path, so equivalent external
failures found by different health or lifecycle checks can carry different causes. Events
describe observed outcomes, not requested commands.

Message events cover direct messages only. Broadcasts have neither per-recipient receipt rows nor
delivery confirmation and therefore emit no message event. `launchModel` and `launchEffort` are
the settings Conductor selected for process launch, not proof of the provider's currently served
model or retained effort. Workspace events never include local paths. Runbook adoption events are
emitted only by the operator-authorized provenance operations described in the runbook guide.

## Consumer checklist

1. Give every subscriber a stable, unique, non-blank `name`; duplicate names are rejected.
2. Return quickly. Move slow network or storage work into the consumer's own bounded machinery if
   the default queue and drop policy do not fit.
3. Track both `conductorInstanceId` and `seq`; reconcile on restart or a sequence gap.
4. Make handlers idempotent if the consumer persists and replays work on its side.
5. Never use subscriber callbacks to reimplement Conductor lifecycle, authorization, or routing
   policy. Invoke documented control surfaces separately when the integration needs to act.
6. Test slow handlers, thrown handlers, restart reconciliation, and sequence-gap recovery.

Durable replay, network webhooks, filtering DSLs, dynamic attach/detach, inbound event injection,
message-body events, and setting-change events are intentionally outside this first primitive.
