---
'agent-conductor': patch
---

Stop reporting a terminal that cannot be observed as a pane that has died.

A live, working session could be marked `stopped` and stay that way. Two
separate defects combined:

- Every iTerm scan walks ALL windows — one process cannot enumerate only its own
  panes. A pane closing anywhere mid-scan, including in another fleet's window,
  raised `-1728` and aborted the whole enumeration. Only `buildInSessionScript`
  tolerated the related `-1719`, and none tolerated a window or tab disappearing.
  Every scan now skips vanished elements at all three levels and keeps going,
  while still propagating errors that are not a vanished element.
- The liveness check turned *any* failure — a timeout, a scripting error — into
  "the pane is gone". That is unrecoverable rather than merely wrong: lifecycle
  marks the session stopped and forgets its pane mapping, and reconcile only
  visits mapped panes, so nothing revisits the seat afterwards. The session keeps
  working, invisibly, until a human notices.

`isAlive` now returns false only for an observation that completed and found the
pane absent, and throws when the terminal could not be observed at all. The
callers were already built for it: lifecycle records an unknown observation,
health warns and skips the tick, delivery holds the queue. The tmux backend gets
the same distinction — no tmux server is a real answer, an unanswerable tmux is
not.

One busy fleet spawning tabs could previously retire another fleet's sessions.
