---
'agent-conductor': minor
---

Record what a launch actually pinned, and report drift from the declaration

Session model, effort and runtime are launch-time settings: they are read when a process starts and
frozen for its lifetime. Conductor reported the _declaration_ everywhere, so editing a config under a
running session was indistinguishable from having applied it. A seat ran one model for twenty hours
under a config naming another, with the config, `get_session_status` and the event journal all
agreeing and all wrong.

- `SessionRuntime.resolveLaunchModel` makes model precedence the property of the runtime that passes
  the flag. Core no longer keeps a second copy that could drift from the command actually built.
- The resolved model and a launch timestamp persist in `session_state` (`active_model`,
  `active_launched_at`), alongside the existing runtime and effort.
- `session.started` reports `launchModel` from that record instead of re-deriving it from config.
  Previously an adopted pane was journaled with whatever the config said at adoption time — a claim
  about a process Conductor did not launch, and one that manufactured agreement between a stale
  process and an edited declaration.
- `get_session_status` gains `modelDeclared` and `modelDrift`; `list_sessions` badges a drifted
  session with `⚠ running <model>`. A running process whose launch was never recorded reports unknown
  rather than falling back to the declaration.
- Editing a launch-time field under a running session now logs a warning naming the changed fields
  and the remedy, because only a stop and start re-reads them.

This does not certify what a session is effectively running. An in-session model change, or a runtime
that accepts a value and substitutes another, remains visible only to the process itself.
