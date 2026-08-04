---
'agent-conductor': patch
---

Hold operator-bound messages that no surface accepted, instead of logging and losing them. An
undelivered message is now written to a durable outbox and flushed in order when an operator surface
appears — on attachment, and on the ordinary heartbeat so a channel that existed but was failing is
covered too, since attachment never transitions in that case. Flushed messages carry a
`[held since <time>]` prefix: nothing is dropped for age, because which stale alarms still matter is
the operator's judgment rather than a threshold's. The outbox is bounded and drops the oldest beyond
its limit with a log line.

This closes a real asymmetry. Only selectable requests persisted; a plain prose `send_to_operator`
was written to the conductor log and lost, so two kinds of message had different durability for no
reason a caller could see.

With that in place, `send_to_operator` returns `queued for the operator` in both branches. The old
receipt named which one had happened, which let any session read operator-attachment state from a
single call — the capability deliberately kept out of `list_sessions` by threading an audience
through it. That receipt was not gratuitous: an honest failure was what stopped a session waiting
forever on a question nobody received. The outbox is what makes uniform wording true rather than
merely reassuring, because a held message is now genuinely going to arrive. The one honest failure
left is a message that could be neither sent nor stored, which reports a storage fault and reveals
nothing about who is watching.

Fleet status no longer claims that alarms raised while the operator is unreachable are "ending in a
log file" — they are held — and reports how many are waiting.
