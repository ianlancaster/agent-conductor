---
'agent-conductor': minor
---

Add opt-in same-machine federation for discovering exposed peer sessions and routing existing
agent operations between Conductors. Add named instances so independent Conductors can safely
share one fleet directory while the default `conductor start` workflow remains unchanged.
Embedding consumers should note that `Supervisor.baseDir` is now normalized to an absolute path as part of resolved
instance identity.
