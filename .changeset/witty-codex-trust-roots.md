---
'agent-conductor': patch
---

Fix a defect where a Codex session launched into a linked Git worktree under a symlinked path
(for example macOS's `/tmp` -> `/private/tmp`) could stop at Codex's interactive "Trust this
folder?" dialog instead of starting, because the pre-trust entry Conductor wrote did not match
either the realpath Codex compares against or the Git repository root (the main worktree's root,
not the linked worktree's own directory) Codex applies trust to. The generated `config.toml` now
pre-trusts both the resolved working directory and the resolved Git repository root, derived from
`git rev-parse --git-common-dir`, without duplicating an entry already present in the shared
config.

Also fix a defect where `get_session_status` could report a Codex session as `working` forever
after a completion notification the runtime sent for an in-turn checkpoint (for example a
commentary message emitted while a background command from the same turn was still running,
carrying the same turn id as the still-active root turn). The idle confirmation path now consults
the same execution-activity evidence already used to reconcile missed hooks, and keeps the session
working if the pane still shows it executing when the debounce elapses.
