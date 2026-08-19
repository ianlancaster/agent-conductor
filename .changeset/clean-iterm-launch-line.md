---
'agent-conductor': patch
---

Stop iTerm launch commands from being spliced onto stray keystrokes.

Creating an iTerm pane briefly moves the keyboard focus even with
`terminal.iterm.focusNewPanes` false, so a character typed at that moment lands on the new pane's
shell input line. `launch` polled for a prompt marker, which by design only matches when the last
line _ends_ in a prompt character — a line reading `~/repo ❯ he` never matches and never will. The
poll therefore burned its whole `launchTimeoutSec`, logged "submitting anyway", and pasted the
launch command onto the operator's characters, producing `hecd /path && … claude …`. One stray
keystroke reliably cost a dead agent plus an eight-second stall; it looked intermittent only because
a stray Return let the shell swallow the garbage on its own.

Launch readiness now has a second, independent signal: the pane's tty. An interactive shell that
owns its own foreground process group is sitting at a prompt whatever its input line says, which is
exactly the fact the prompt marker cannot see. On that evidence Conductor clears the input line with
`^E` then `^U` — edits that send no signal and are no-ops on an empty line — and the next poll finds
a clean prompt, so the launch proceeds immediately instead of timing out. A stray keystroke now
costs the operator a couple of their own characters rather than the agent.

The clear happens at most once per launch, only while no foreground job is running, and never when
the tty or `ps` cannot be read, so control characters can never reach a running program. Panes that
are merely slow to initialize are unaffected: the control characters are inert during rc-file init,
and an unrecognizable prompt still degrades to the previous submit-anyway timeout. The tty is looked
up only if the first poll misses, so an already-clean pane adds no work.

The tmux backend already recovered from a blocked launch line by interrupting the foreground job;
this closes the equivalent gap for iTerm, whose panes — unlike tmux's, which are created detached —
can be typed into while they are being created.
