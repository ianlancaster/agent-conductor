---
'@ianlancaster/agent-conductor': patch
---

Serialize session lifecycle transitions and publish an advisory recovery marker. Only `start` was
serialized, so two supervisors recovering the same dead seat — the normal consequence of running
auto stall routing beside a scheduled backup sweep, which Conductor's own documentation recommends —
could interleave stop→start pairs: one caller's stop killed the pane the other caller's start had
just opened, and the recovery still reported success. Start, continue, stop, restart, and teardown
now queue per session, `restart` holds the turnstile across both halves, pane reconciliation skips a
session whose transition is in flight, and protected delivery holds messages instead of dispatching
into a pane that is being torn down. `get_session_status` reports `lifecycleOperation`,
`lifecycleOperationBy`, and `lifecycleOperationSince`, and `list_sessions` shows the same as a
`⏳ … in progress` marker, so a second supervisor can see an in-flight recovery instead of
discovering it by colliding.
