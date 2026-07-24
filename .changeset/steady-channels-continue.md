---
'agent-conductor': patch
---

Keep the Conductor control plane online when an optional operator channel is missing credentials or
fails startup, report failed operator sends truthfully, and keep the interactive console feed alive with
heartbeats and silent reconnection. Status output marks auto-enabled sessions and enabled fleet-wide stall
detection with `🔄`. `conductor start` now guarantees console ownership instead of silently attaching
to an existing core; use `conductor console` for an explicitly non-owning attachment. The single fleet-watch
toggle survives Conductor restarts and resumes over the current registered fleet with a fresh confirmation cycle.
