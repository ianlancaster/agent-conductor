---
'agent-conductor': patch
---

Prevent Git subprocesses launched from linked-worktree hooks from inheriting the outer repository's
administrative environment and corrupting the primary checkout's worktree metadata.
