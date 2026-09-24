---
'agent-conductor': minor
---

`conductor start` now writes a `fleet.toml` marker (`id = "<fleet id>"`) when the file is missing and never overwrites it. The knowledge-base protocol line gains a Federation sentence when the nearest ancestor holding `federation.toml` also holds `knowledge-index.toml`. The handbook documents several things: the one-restart procedure for registering spawn templates and the pre-cloned `path` alternative, worktree instances of memory-keeping agents, what a codename change does, and the Federation knowledge tier with its inboxes. The engineering-management runbook moves to 1.1.0, with stem-cell and role-template bootstrap guidance.
