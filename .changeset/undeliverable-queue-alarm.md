---
'agent-conductor': minor
---

Report recipients that have stopped accepting messages. Protected delivery correctly refuses to
type into an occupied or unclassifiable pane, but it did so indefinitely without telling anyone: a
sentinel wedged on an unanswered prompt silently absorbed eleven stall envelopes over five hours
while `running`, `ready` and `idle` all read true, and the sender's receipt said only `pending` with
no flush attempt recorded. Conductor now warns the operator when a queue has been undeliverable
past `messaging.undeliverableWarnMs` (default 10 minutes), with `messaging.sentinelUndeliverableWarnMs`
(default 2 minutes) and stronger wording for the sentinel, whose backlog means fleet-wide stall
routing is undelivered rather than one seat being stuck. The alarm reports elapsed time rather than
backlog — backlog trips later the quieter the fleet gets — goes to the operator directly and never
through the sentinel, records `delivery_blocked` in the health log, and is followed by a recovery
notice when the queue drains.
