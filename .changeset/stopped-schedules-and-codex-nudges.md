---
'agent-conductor': patch
---

Leave stopped sessions stopped when cron schedules fire unless the operator explicitly sets
`wakeIfStopped: true`. This also applies to existing entries and fresh-context schedules.
Explicit session stops cancel pending scheduled restarts; scheduler shutdown/reload invalidate
stale occurrences. Document explicit-user-authorization requirements for self-waking schedules.

Suppress Codex's blocking low-budget model-switch reminder on managed launches and resumes under
the default bare UI setting without changing the selected model or bypassing usage limits.
Restart Conductor to load the scheduler change, and relaunch/resume Codex sessions to apply the
new launch override. Live processes are not changed by rebuilding the CLI.
