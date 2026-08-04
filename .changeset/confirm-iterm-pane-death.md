---
'agent-conductor': patch
---

Require two independent missing-session scans before iTerm pane liveness retires a managed session, avoiding a
permanent false-stopped state when iTerm transiently skips a live session during window or tab changes.
