<!-- conductor-topic:runbook-engineering-management-tier-4 -->

## Engineering management — Tier 4: bounded autonomous initiatives

The full pattern adds a peer EM from a different model family. Each EM has a separate workspace and
conversation. One remains the operator-facing owner; the peer performs adversarial reviews of
master plans, architecture, milestone boundaries, and high-risk conclusions. Disagreement is
recorded and resolved explicitly rather than averaged away.

Break the initiative into milestones and tickets with concrete acceptance gates. A “goal-scoped
autonomous session” is a fleet convention built from messages, records, schedules, auto mode, and
the Sentinel—not a native Conductor goal scheduler. Cron schedules are time-based; do not use them
to poll peers or imitate message delivery.

For each milestone:

1. freeze the canonical base and approve a master plan;
2. dispatch isolated worker tabs with bounded ownership;
3. require written plan and delivery gates proportionate to risk;
4. use independent review lanes at frozen commits;
5. integrate only accepted commits into the canonical repository;
6. archive evidence and tear down clean temporary lanes;
7. reassess context, risk, and the next milestone before continuing.

Enable `/auto` only for sessions whose detected stalls deserve Sentinel assessment. The Sentinel may
decide that a worker waiting at an approval gate should remain idle. `/fleet-watch` observes all
active registered non-Sentinel sessions, follows starts, stops, and roster changes, and alerts after
at least two eligible sessions remain stalled through the confirmation interval. Stopped
registrations do not suppress it.

Do not pause the whole session merely to stop a schedule: `pause_session` suppresses both schedules
and stall routing. Set the individual schedule entry's `paused` field when stall supervision should
remain active.

Context management is runtime-aware. Claude Code emits explicit blocked and compaction hooks. Codex
currently reports completed turns but not equivalent blocked/compaction events, so unusual Codex
states rely more on pane-change fallback and Sentinel judgment. Check context at natural milestone
boundaries, preserve durable decisions in records, and start a fresh worker when history is no
longer helping. A fresh worker lacks prior cross-session conversation; it does not literally start
without repository or role context.

Use the least expensive Sentinel model proven reliable for the policy it holds. A high-authority,
long unattended Tier 4 fleet may justify a stronger model than a simple daytime notification role.
