---
'@ianlancaster/agent-conductor': patch
---

Add `terminal.iterm.focusNewPanes` so a fleet can open panes without stealing the operator's
keyboard focus. iTerm has no create-without-selecting verb — `create window`, `create tab` and
`split vertically` all select what they make — so every pane a fleet opens pulls the cursor out of
whatever the operator was typing in. Set it false and Conductor remembers the current window, tab
and pane before creating, restores all three afterwards, and skips the `activate` when it has to
create the workspace window.

All three matter: selecting the remembered session alone does not bring its window back. Measured
against live iTerm, creating a tab moved the current window from 74 to 108 and a session-only
restore left it on 108; restoring window, then tab, then session returns it to 74.

The setting governs pane creation on every path that opens one — spawn, start, restart, and
recreating an adopted pane — rather than one call site, because the interruption is not specific to
spawning. It is an operator preference rather than a per-call parameter, so no session can decide to
take the foreground. `/summon` is unaffected: raising a pane is the whole point of it.

Defaults to `true`, the existing behavior, so upgrading changes nothing until it is set. The tmux
backend is unaffected — its panes are created detached and never take focus.
