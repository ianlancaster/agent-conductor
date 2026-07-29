---
'@ianlancaster/agent-conductor': minor
---

Add a distinct fleet-down signal for a standing fleet with nothing running. Scoping fleet watch to
running standing members left a real gap: a stopped session emits no stalls, so a fleet whose panes
all died overnight was reported by nothing at all, and the honest `suppressed — 0 of N running`
status line made the instrument correct while leaving the fleet unobserved. Fleet down is routed to
the sentinel (or the operator) as `[Fleet Down]`, uses the same confirmation threshold, latches
until the fleet comes back up, and deliberately cannot fire before a standing session has run in
this Conductor process — a fleet that has not come up yet is not an outage. `fleet.down` joins the
public event vocabulary, and `/status` now names which signals fleet watch currently covers.
