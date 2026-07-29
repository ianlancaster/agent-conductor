---
'@ianlancaster/agent-conductor': minor
---

Scope fleet watch to the standing fleet, require a quorum, and make it state its real coverage.
Fleet watch measured every registered non-sentinel session, which failed in both directions: at low
occupancy, with most of the roster permanently stopped, "nobody is working" degenerated into a
duplicate of one session's idle stall and fired on every turn boundary; at high occupancy,
`spawn_session` registered ephemeral pods into the same roster, so continuous lanes left something
always working and the watch became structurally unable to fire while still reporting itself
enabled.

Session configs gain `ephemeral` (default `false`); `spawn_session` writes `ephemeral: true` unless
the caller passes `ephemeral: false`, and only standing members are measured. A fleet alert now also
requires at least two standing members running, because with one running member the alert restates
that member's own idle stall. `toggle_fleet_watch` and `/status` report `off`, `armed`, `inert`, or
`suppressed` with the reason, and the 🔄 badge means armed rather than merely enabled — an
instrument that presents as armed while structurally unable to fire turns its own silence into a
false all-clear. Stalls that are detected but dropped because auto is off or the session is paused
are now recorded as `stall_dropped` in the health log, so an unwatched seat is distinguishable from
a supervised one that never stalled.
