<!-- conductor-topic:runbook-engineering-management-practices -->

## Engineering management — role scripts and underlying mechanics

The runbook becomes useful when the operator writes small role prompts for their own process. Keep
them outside product source, for example:

```text
fleet/
├── roles/
│   ├── engineering-manager.md
│   ├── peer-engineering-manager.md
│   ├── stall-sentinel.md
│   ├── implementer.md
│   └── reviewer.md
└── records/
    ├── initiatives/
    ├── milestones/
    └── decisions/
```

An EM script should define decomposition, dispatch completeness, plan and delivery gates, risk
classification, review depth, integration ownership, context checkpoints, and operator escalation.
A Sentinel script should define safe nudges, expected waits, retry limits, protected actions, and
what evidence to send the operator. A worker script should define scope, reporting, validation, and
stop conditions. Keep tool inventories out of these files; the version-matched Conductor protocol
is injected at runtime.

Useful mechanical boundaries:

- Conductor owns identity, process lifecycle, terminal placement, protected message submission,
  receipts, schedules, and mechanical health evidence.
- Agent roles own prioritization, plans, review judgment, and escalation decisions.
- The canonical repository owns integration truth; disposable worktrees own isolated changes.
- Session YAML hot-reloads roster and schedule policy, but launch-setting changes such as role
  prompts, external directories, runtime, model, and environment affect the next process start or
  continuation rather than rewriting an already running CLI.
- `send_to_session` cannot answer a runtime menu when the normal composer is unavailable. Escalate
  to the operator, or—only when fleet policy explicitly allows it and pane inspection proves the
  prompt safe—use `type_in_pane` as raw terminal control. Raw input can overwrite an operator draft.
- Receipts make communication observable, but queued peer conversation is deliberately not replayed
  after a Conductor restart. Durable work state belongs in Git and records.

For every autonomous boundary, decide what happens after success, failure, timeout, ambiguity,
restart, and operator absence. Prefer a short evidence-rich escalation over a large policy tree.
Run the full workflow manually before enabling auto, fleet watch, schedules, or Shepherd execution.
