---
'agent-conductor': patch
---

Stop reporting Claude Code's idle-timer notification as a `blocked` stall. Claude fires one
`Notification` hook for both a real permission prompt and the "waiting for your input" idle timer,
and the runtime adapter mapped every one of them to `blocked` — the single stall kind a sentinel
cannot dismiss without reading the pane. On a dogfooding fleet that produced 32 false `blocked`
stalls against 1 genuine permission prompt. The idle class is now classified in the runtime adapter
as ordinary turn completion, taking the same debounced, dedupable `idle` path as a `Stop` hook (and
so also repairing a completion hook that was never delivered). Unrecognized notification messages
keep the conservative `blocked` mapping.
