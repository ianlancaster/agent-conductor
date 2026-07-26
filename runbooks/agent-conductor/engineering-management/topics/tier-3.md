## Engineering management — Tier 3: PR Shepherd and review lanes

PR Shepherd observes GitHub facts and delivers them to the EM. It does not replace review judgment
and should not be configured directly into autonomous execution on first use.

Roll it out in this order:

1. configure owner/repository scope, merge mode, required checks, approval rules, and ignored actors;
2. validate the profile and run baseline-only, stdout polling;
3. compare emitted facts with GitHub;
4. enable Conductor delivery to the EM in shadow/notify mode;
5. only after repeated correct decisions, consider narrowly scoped execution policy.

On a review-worthy event, the EM fetches the PR and freezes an immutable review ref without checking
out or mutating the contributor's source branch:

```bash
git -C /projects/product-canonical fetch origin pull/123/head:refs/heads/review/pr-123
git -C /projects/product-canonical rev-parse refs/heads/review/pr-123
```

Spawn a fresh reviewer worktree from `review/pr-123`, in a new tab, and include the frozen SHA in the
assignment. Review against the PR's base without merging the base into the source branch. If the
workflow needs a merge candidate, create a separate candidate branch and keep the immutable review
ref unchanged so findings remain reproducible.

The reviewer reports facts and risk to the EM. The EM decides whether to request changes, dispatch a
fix lane, seek a second review, or ask the operator. Shepherd's persistent outbox retries its own
notifications; ordinary peer-message queues are process-local and must not be presented as a
crash-safe job system.
