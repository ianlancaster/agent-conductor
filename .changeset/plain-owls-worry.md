---
'agent-conductor': minor
---

Add a `starting` session activity distinct from `working`: a freshly launched or resumed session
now reports `starting` until authoritative evidence (a lifecycle hook, or the runtime activity
parser positively classifying the composer as idle or working — an `unknown` classification never
counts) proves its runtime reached its own composer or turn loop. `ready` in `get_session_status`
is now correctly `false` while `starting` — a live foreground process alone (for example a runtime
parked at its own pre-turn trust dialog) no longer marks a session ready. A session still
`starting` after a new, configurable `health.startConfirmMs` (default 60s) is reported through the
existing stall path as a `not-started` stall, distinct from `blocked`, carrying the last pane
classification; this never changes activity automatically. `list_sessions` and `/status` render the
new state with its own icon. Fleet-watch's "everyone stalled" alarm now requires confirmed
idle/stopped members rather than merely non-`working` ones, so an ordinary `start-all` no longer
looks like a fleet-wide stall while sessions are still starting.
