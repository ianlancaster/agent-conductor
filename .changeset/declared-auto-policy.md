---
'@ianlancaster/agent-conductor': minor
---

Let a session declare its stall-routing policy in its own config. `defaults.auto` is read once at
startup, so a session registered later — including every session created by `spawn_session` —
inherited whichever fleet default was in force when Conductor booted, not the value an operator had
since written into `supervisor.yaml`. A fleet could therefore spawn seats that were silently
unsupervised, or, after a restart, silently supervised, with no per-session way to pin the intent.
Session configs now accept `auto`, applied at first registration and materialized into persisted
state, and `spawn_session` accepts a matching `auto` argument so a session can be created with its
supervision policy already correct rather than toggled a moment later. A live `toggle_auto` still
persists and wins over the declaration.
