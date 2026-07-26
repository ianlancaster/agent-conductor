<!-- conductor-topic:runbook-engineering-management-tier-2 -->

## Engineering management — Tier 2: plans, deliverables, and fresh review

Add explicit artifacts and gates before increasing autonomy. A typical lane produces:

1. a short implementation plan;
2. an EM approval or revision;
3. the implementation and validation evidence;
4. a durable delivery note in the fleet records directory;
5. an independent review when risk warrants it.

The plan is a reviewable contract, not a ceremony. It should name affected components, invariants,
tests, migration or rollback concerns, and unknowns. The worker messages the EM when the plan is
ready and waits at the gate. That idle state is intentional; auto mode must mean “this stall deserves
Sentinel assessment,” not “every idle worker should be pushed onward.”

For a fresh review, freeze the worker commit before creating the reviewer branch:

```bash
git -C /projects/product-canonical fetch origin
git -C /projects/product-canonical branch review/change-1 <worker-commit-sha>
```

Then spawn the reviewer from that existing branch with `placement: "tab"`. Without this step, a new
branch created by `spawn_session` starts at the canonical repository's current `HEAD`, which may not
contain the worker's change.

The reviewer must not share the implementer's conversation. It independently checks the frozen
commit against the plan and acceptance criteria, records findings by severity, and reports to the
EM. If fixes are required, send them back to the implementation lane or create a new fix lane; do
not let a supposedly independent reviewer silently become the implementer.

Keep project records outside disposable worktrees and expose only the required directory through
`additionalDirs`. Treat records as durable evidence, not as a coordination lock: Git branches,
direct messages, and explicit ownership remain the synchronization primitives.
