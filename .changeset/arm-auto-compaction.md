---
'agent-conductor': patch
---

Arm Claude Code auto-compaction by exporting the window the percentage is measured against

`autocompactPct` has had no effect since it was added. Claude Code consults the percentage only when
a context window has been configured explicitly; with the window left automatic it returns before the
percentage is read, so auto-compaction was off entirely. Measured on a controlled seat: context
reached 157,995 tokens against a 9,000-token threshold with zero compactions. Across one fleet, 21
sessions passed 700k tokens and exactly one auto-compacted.

Claude Code sessions now also export `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, from the new
`runtimes.claudeCode.autocompactWindowTokens` setting (default 1000000). The default is deliberately
the maximum: the value is clamped and then reduced to the model's real window, so the maximum arms the
threshold on every seat without shrinking any of them, while a smaller number would silently truncate
large-window sessions. Lower it only to force earlier compaction on purpose.

**This is opt-out, not opt-in.** The setting makes the window tunable; it does not gate the behaviour.
Every Claude Code session gets an armed auto-compaction threshold unless the value is deliberately
lowered, and there is no value that restores the previous unarmed state — that state was a defect, not
a configuration. Because the variable is exported in the launch command, existing processes are
unaffected: a conductor restart adopts surviving panes rather than relaunching them, so each seat arms
at its own next real launch.

Diagnosis credit: measured against Claude Code 2.1.220. The internal symbols involved are minified per
build, so verify compaction still fires on the expected threshold after a Claude Code upgrade —
`compactMetadata.preTokens` is the reliable check, not the pane's context meter.
