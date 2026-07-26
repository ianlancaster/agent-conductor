<!-- conductor-topic:runbook-engineering-management-tier-1 -->

## Engineering management — Tier 1: dispatch and report

Start with one persistent EM and disposable implementation lanes. The EM owns decomposition and
acceptance; a worker owns only its assigned branch and reports through `send_to_session`.

Prepare the canonical repository explicitly before each lane. Fetch the remote, verify the intended
base, and record the exact base SHA. Then spawn from the canonical repository's current `HEAD`:

```json
spawn_session({
  "codename": "worker-change-1",
  "runtime": "codex",
  "worktreeRepo": "/projects/product-canonical",
  "branch": "work/change-1",
  "placement": "tab",
  "additionalDirs": ["/fleets/product/records"],
  "systemPromptFile": "/fleets/product/roles/worker.md"
})
```

`additionalDirs` grants runtime access to records outside the worktree. `systemPromptFile` attaches
lane policy without writing an instruction file into the worktree and making it dirty. These are
access and instruction primitives, not a substitute for repository permissions or review.

The dispatch message should include:

- the outcome and acceptance criteria;
- the frozen base SHA and branch;
- owned files or boundaries;
- required validation;
- where durable artifacts belong;
- the EM session to report to;
- explicit stop conditions and approval boundaries.

The worker commits its work, sends the EM the result, commit SHA, checks run, and unresolved risks,
then waits. A successful `send_to_session` receipt means the pane submission completed; a queued
message is protected only for the current Conductor process. On restart, pending conversation is
cancelled rather than replayed. Use the returned receipt with `get_message_status`; do not infer
ledger gaps by guessing nearby receipt IDs.

The EM reviews the branch and either accepts it, sends a precise follow-up, or creates a separate
review lane. Tear down only after useful reports are archived and `git status` is clean. Worktree
deletion keeps the branch. A dirty worktree remains registered for recovery.
