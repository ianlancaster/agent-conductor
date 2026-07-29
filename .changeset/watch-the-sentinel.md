---
'@ianlancaster/agent-conductor': patch
---

Watch the sentinel seat mechanically. Fleet watch excludes the sentinel by design, so the one seat
whose failure disables all stall routing was unobserved: a dead sentinel was discovered only when a
stall could not be delivered, which is the moment it was already needed. Conductor now checks the
sentinel's process liveness on the ordinary heartbeat, notifies the operator when it is not running
(sharing the existing ten-minute rate limit), and sends one recovery notice when it returns.
Inconclusive terminal inspection is treated as unknown rather than failure. This replaces
reciprocal agent-side watch schedules, which cost context in both watched windows.
