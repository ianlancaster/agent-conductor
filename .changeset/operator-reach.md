---
'agent-conductor': minor
---

Report when no operator notification can reach anyone

Every autonomous alarm — stall routing, fleet-stalled, fleet-down, sentinel failure and recovery —
routes through one operator send. With no channel enabled and no console attached, that send logged
the message and returned `false`, and all ten call sites discarded the boolean. A fleet with no
operator transport was indistinguishable from one with a listening operator, so a detached conductor
could detect everything and deliver none of it.

- `formatFleetStatusReport` now reports operator reachability as `armed`, `inert` or `degraded` with a
  reason, the same distinction fleet watch needs and for the same reason: an alarm path that reports
  itself present while structurally incapable of reaching anyone is worse than an absent one, because
  its silence reads as nothing being wrong.
- Failed operator notifications are counted at the single send choke point, with the instant of the
  first one, and reported alongside that state. Callers may still ignore the boolean — an alarm has
  nothing better to do when it cannot be raised — but the fleet no longer forgets that it happened.
- Startup warns when a conductor comes up with no channel and no console, naming what will be lost.

Operator reachability is rendered for the **operator audience only**. `list_sessions` passes the
caller's audience, so a managed session cannot see whether a human is attached: an agent that could
tell would be able to behave differently when unobserved, and that capability should not arrive as a
side effect of a status field. `Supervisor.statusReport` takes an explicit audience argument to make
that boundary checkable rather than incidental.
