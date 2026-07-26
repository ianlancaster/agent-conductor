## Engineering management runbook

This runbook is an opinionated composition of ordinary Conductor primitives. It is not a special
workflow engine. Adopt one tier at a time and change the roles, gates, records, and scripts to fit
your engineering process.

The system has three durable roles:

- an **Engineering Manager (EM)** holds the operator's arc, decomposes work, dispatches temporary
  workers, reviews their output, and integrates accepted work;
- a **Stall Sentinel** receives mechanical stall evidence, applies the fleet's escalation policy,
  and helps arbitrate bounded unattended runs;
- a **canonical repository** stays stateless and clean, supplies the commit from which worktrees are
  cut, and receives only reviewed work.

The EM and Sentinel need separate working directories. A second EM also needs its own directory.
Conversation history belongs to a runtime session, but files, Git state, and local instructions
belong to a workspace; pointing persistent roles at one directory creates accidental coupling.

### Recommended operator layout

Keep one stable main window and put temporary work elsewhere:

```text
┌──────────────────────┬──────────────────────────────┐
│ conductor status     │                              │
│ (persistent view)    │                              │
├──────────────────────┤ Engineering Manager          │
│ conductor>           │ (operator conversation)      │
│ (small console band) │                              │
├──────────────────────┤                              │
│ Stall Sentinel       │                              │
│                      │                              │
└──────────────────────┴──────────────────────────────┘
```

Split the window approximately 50/50. The right half belongs to the EM. Stack the left half with
the persistent `conductor status` view at the top, a small owning `conductor start` console band in
the middle, and the Sentinel below it. Always spawn temporary workers with `placement: "tab"` (or
`/spawn ... --tab`) so lane churn never rearranges the main window.

iTerm2 is the recommended macOS backend for easy visible pane and tab navigation. tmux remains a
fully supported, portable alternative; the choice is an operator preference, not a workflow
requirement. Arrange the panes with the terminal's native controls rather than embedding brittle
terminal automation into fleet policy.

### Progress through the tiers

1. [Tier 1: dispatch and report](topics/tier-1.md): the recommended baseline—dispatch one isolated
   worker and require a completion report.
2. [Tier 2: plans, deliverables, and fresh review](topics/tier-2.md): add written contracts and one
   independent review when its expected signal justifies the extra round-trip.
3. [Tier 3: PR Shepherd and review lanes](topics/tier-3.md): route pull-request facts to the EM and
   review immutable commits in fresh lanes.
4. [Tier 4: bounded autonomous initiatives](topics/tier-4.md): the most elaborate included pattern,
   adding a second model family, milestones, review gates, auto mode, fleet watch, and unattended
   execution. It is not a maturity target every fleet should reach.
5. [Role scripts and mechanics](topics/practices.md): customize roles and understand the failure
   boundaries underneath the workflow.
6. [Copyable templates](topics/templates.md): generic session, dispatch, plan, delivery, and review
   gate examples.
7. [Cognitive-agent bootstrap](topics/cognitive-agent-bootstrap.md): optionally create and awaken
   persistent roles from separate operator-approved briefs.

Before using this runbook, complete the hand-driven onboarding shakedown: one session must start,
exchange a message, report status, stop, and continue successfully. Keep automation off until that
works. The onboarding agent may offer this runbook afterward, but must not configure it without
operator approval.
