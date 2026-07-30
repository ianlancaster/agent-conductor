---
'agent-conductor': minor
---

Stop an unanswered question from parking a Claude Code seat indefinitely

Claude Code's `AskUserQuestion` prompt blocks the turn until someone answers, and its own default for
`askUserQuestionTimeout` is `never`. Conductor deliberately will not answer a selection prompt — its
free-text option is indistinguishable from a composer, so typing there answers a question nobody asked
Conductor to answer and leaves a draft that blocks every later delivery — so on a managed seat the only
exit was a human. Observed as an 11.5-hour fleet stall: two prompts left open, 16 `fleet_stall` events,
both operator requests still pending at the end.

Conductor now writes `askUserQuestionTimeout` into the per-session settings file it already passes as
`--settings`, defaulting to `5m`, with `runtimes.claudeCode.askUserQuestionTimeout` for the fleet and
`askUserQuestionTimeout` in a session's YAML for one seat. Values are validated against Claude Code's
own enum (`60s`, `5m`, `10m`, `never`) rather than passed through, because an unrecognized value
silently resolves to `never` — reinstating the defect while looking configured. Setting it on a session
of another runtime warns instead of being silently dropped.

Per-session rather than machine-global by necessity as well as preference: Claude Code resolves this
key from `policySettings`, `flagSettings` and `userSettings` only, never project or local settings, and
`--settings` is the `flagSettings` layer. Writing it to user settings would apply it to every Claude
Code session on the machine, managed or not.

Verified end to end against Claude Code 2.1.220 rather than only from tests: a live seat launched with
`60s`, an `AskUserQuestion` prompt triggered, and the session observed reporting
`No response after 60s — continued without an answer` and returning to an idle composer.
