---
'agent-conductor': patch
---

Judge Claude Code activity from the live frame instead of the whole pane capture. Scrollback retains
the final pulse row of every completed turn, so a finished session was reported as working forever,
which silently disabled fleet watch and made `/status` claim an idle seat was busy. A tall composer
draft — a peer's long message — now yields unknown rather than idle, and activity observation looks
deeper once when the default window cannot classify the frame.
