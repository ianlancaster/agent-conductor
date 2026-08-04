---
'agent-conductor': patch
---

Never deliver into a session holding an interactive selection prompt. Claude renders a menu's
free-text option with the same glyph as the composer, so protected delivery classified an open
`AskUserQuestion` as an empty input line and typed a message into it. Observed on a dogfooding
fleet: a stall envelope was submitted into the sentinel's open question, which left the session
holding a draft, which the never-type-over-a-draft rule then honoured for five hours — silently
ending stall routing fleet-wide, because stalls reach the sentinel as ordinary messages. Session
status reported `running`, `ready` and `idle` throughout, all accurate and none of them meaning what
a reader needed.

Runtimes may now report a blocking prompt, and delivery treats that as an unconditional veto that no
alternate parser can override, with its own `prompt-open` skip reason rather than the misleading
`composer-not-visible`.
