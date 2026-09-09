---
'agent-conductor': patch
---

Reuse an AppleScript interpreter for 1,000 iTerm operations instead of registering a new macOS process for every capture and health check. Recycle between requests to bound native cache growth, bound queued work, kill stuck interpreters, and suppress rapid restart attempts; requests with unknown outcomes are never replayed automatically.
