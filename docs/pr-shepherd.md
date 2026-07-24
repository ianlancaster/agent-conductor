# PR Shepherd V2

PR Shepherd V2 is an opt-in GitHub polling service shipped with Agent Conductor. It keeps pull-request policy and delivery durability in its own SQLite database, and can either print fact-only events or send them to a coordinator through Conductor's protected `send_to_session` operation.

Installing or starting Agent Conductor does not start, initialize, configure, or poll PR Shepherd. The `pr-shepherd` executable runs only when invoked explicitly, uses a separate configuration file and database, and is stopped independently. Conductor itself remains fully usable without it.

## Prerequisites

- Node.js 22.13 or newer (23.4 or newer on the non-LTS Node 23 line) and the Agent Conductor package installed or built
- [GitHub CLI](https://cli.github.com/) available as `gh`
- A successful `gh auth status` for the GitHub account that will poll repositories
- Read access to the configured repositories; write access is required only for automation policies set to `execute`
- A local Conductor process only when using `delivery.type: conductor`

When working from this repository:

```bash
pnpm install
pnpm build
pnpm link --global
pr-shepherd --help
```

The linked package provides both `conductor` and `pr-shepherd`. The Shepherd is still a separate process; linking the command does not enable it.

## Safe first run

1. Copy the generic example outside the repository and set your GitHub username:

   ```bash
   cp examples/pr-shepherd.yaml shepherd.yaml
   ```

2. For an observation-only rollout, set:

   ```yaml
   polling:
     bootstrap: baseline-only
   automation:
     autoMerge: notify
     branchUpdate: notify
     reviewerComment: notify
   delivery:
     type: stdout
   ```

3. Validate authentication and configuration:

   ```bash
   gh auth status
   pr-shepherd validate --config shepherd.yaml
   ```

4. Run one poll. With stdout delivery and `notify`/`off` automation, this does not modify GitHub or contact Conductor:

   ```bash
   pr-shepherd poll --once --config shepherd.yaml
   ```

5. Inspect persisted state and recent events:

   ```bash
   pr-shepherd status --config shepherd.yaml
   pr-shepherd events --config shepherd.yaml --limit 50
   pr-shepherd inbox --config shepherd.yaml
   ```

6. Once the observed decisions are correct, run the polling service under your process manager:

   ```bash
   pr-shepherd start --config shepherd.yaml
   ```

`SIGINT` and `SIGTERM` stop the service cleanly. Conductor does not supervise or restart it.

## Configuration reference

Configuration is strict, versioned YAML: unknown keys and unknown guidance event names are rejected. CLI overrides take precedence over environment variables, which take precedence over YAML.

| Setting                                 | Purpose and default                                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                               | Required schema version; currently `2`.                                                                                                |
| `profile.githubUser`                    | Required GitHub username managed by this process.                                                                                      |
| `polling.intervalSeconds`               | Start-to-start polling interval; default `180`, minimum `10`. Cycles never overlap.                                                    |
| `polling.bootstrap`                     | `notify-current` emits current conditions on first discovery; `baseline-only` records them without emitting. Default `notify-current`. |
| `github.defaultRepo`                    | Optional profile metadata for a primary repository; default `null`.                                                                    |
| `github.includeOwners` / `includeRepos` | Optional owner and repository allowlists. Empty lists allow all repositories.                                                          |
| `github.excludeOwners` / `excludeRepos` | Owner and repository denylists applied after includes.                                                                                 |
| `github.mode`                           | `direct` or `merge-queue`; default `direct`. Branch updates are not requested in merge-queue mode.                                     |
| `github.mergeMethod`                    | `squash`, `merge`, or `rebase`; default `squash`.                                                                                      |
| `checks.required`                       | If non-empty, only these check names determine readiness.                                                                              |
| `checks.ignored`                        | Check names removed before evaluation.                                                                                                 |
| `reviews.ignoredActors`                 | Case-insensitive actor names ignored for review/comment signals.                                                                       |
| `reviews.ignoredCommentPatterns`        | Case-insensitive regular expressions suppressed from human-comment events.                                                             |
| `reviews.requiredApprovals`             | Approval count required for readiness; default `1`.                                                                                    |
| `reviews.bots[]`                        | Configurable bot username, actionable and positive patterns, inbox gating, and feedback-attempt limit.                                 |
| `features.authoredPRs.enabled`          | Monitor authored pull requests; default `true`.                                                                                        |
| `features.reviewInbox`                  | Optional assigned-review workflow with draft, repository, and age filters; disabled by default.                                        |
| `features.reviewFollowUp.enabled`       | Emit scoped re-review work after commits address requested changes; disabled by default.                                               |
| `features.reviewerNudge`                | Optional reviewer-comment/escalation workflow, including threshold, weekday handling, timezone, and repeat cap; disabled by default.   |
| `features.staleThresholdHours`          | Authored-PR staleness interval; default `4`. Set `0` for immediate first-cycle staleness.                                              |
| `automation.autoMerge`                  | `off`, `notify`, or `execute`; default `notify`.                                                                                       |
| `automation.branchUpdate`               | `off`, `notify`, or `execute`; default `notify`.                                                                                       |
| `automation.reviewerComment`            | `off`, `notify`, or `execute`; default `notify`.                                                                                       |
| `delivery.type`                         | `stdout` or `conductor`; default `stdout`.                                                                                             |
| `delivery.endpoint`                     | Required for Conductor delivery and restricted to a localhost URL.                                                                     |
| `delivery.coordinatorSession`           | Required Conductor recipient for all Shepherd events.                                                                                  |
| `guidance`                              | Optional text keyed by emitted event type and appended to the generic fact message.                                                    |
| `databasePath`                          | Independent SQLite database; default `./data/pr-shepherd-v2.db`.                                                                       |

Each bot entry supports:

- `username`
- `actionablePatterns`
- `positivePatterns`
- `inboxGate`
- `maxFeedbackAttempts`

Supported environment overrides are:

- `PR_SHEPHERD_GITHUB_USER`
- `PR_SHEPHERD_COORDINATOR_SESSION`
- `PR_SHEPHERD_CONDUCTOR_ENDPOINT`
- `PR_SHEPHERD_DATABASE_PATH`

Coordinator and endpoint overrides apply only when YAML already declares `delivery.type: conductor`; environment variables cannot silently turn a stdout shadow profile into live delivery.

## Events and organization-specific guidance

The engine emits generic facts for CI failures, review feedback, bot findings, human comments, approvals, conflicts, merges, staleness, review dispatch/completion, scoped re-review, reviewer escalation, and automation decisions. Production messages contain no hard-coded organization, repository, bot, CI-command, or worker-routing policy.

Put private workflow instructions in `guidance`, for example:

```yaml
guidance:
  ci-failed: Follow this repository's documented validation procedure before reporting a fix.
  review-dispatch: Assign the review using your team's normal ownership process.
```

Repository scope is applied in GitHub search queries and again to returned objects. Every search page is consumed. A truncated or incomplete search logs a coverage warning and disables absence-based cleanup for that cycle.

Staleness is measured from GitHub's `updatedAt`, so comments and other activity restart the window even when the head SHA is unchanged. Business-day escalation counts elapsed instants falling Monday through Friday in the configured IANA timezone; it does not imply working hours or a holiday calendar.

In reviewer-comment `notify` mode, escalation timing starts when the decision is emitted. In `execute` mode it starts after the idempotent comment is confirmed. With reviewer-comment automation `off`, no comment decision or mutation is produced, but an enabled reviewer-nudge feature still starts escalation timing when a fix is detected.

## Conductor delivery and trust model

The initial integration is localhost-only and has no token setting. The sender comes from `/mcp/pr-shepherd`; it is mechanically assigned but not cryptographically authenticated. Do not expose the endpoint beyond localhost, and run only one Shepherd profile per Conductor instance while the sender name remains fixed.

Delivery uses a persisted `shepherd:<event-id>:<recipient>` idempotency key. Only a `delivered` Conductor receipt completes the Shepherd outbox. A `queued` receipt remains in Shepherd's own durable retry loop because local Conductor queues are process-local and are cancelled on restart. An explicit retry with the same key revives a receipt cancelled by restart. Transport and internal errors retry with bounded exponential backoff; permanent recipient validation errors are parked and recorded in health history.

For rollout, first compare `baseline-only` stdout behavior with the system being replaced. Stop the old system before enabling Conductor delivery, then move each automation policy from `notify` to `execute` independently.

## Command reference

```bash
pr-shepherd validate --config shepherd.yaml
pr-shepherd poll --once --config shepherd.yaml
pr-shepherd start --config shepherd.yaml
pr-shepherd status --config shepherd.yaml
pr-shepherd events --config shepherd.yaml --limit 50
pr-shepherd inbox --config shepherd.yaml
```

All commands accept these optional overrides:

- `--github-user <username>`
- `--coordinator-session <codename>`
- `--conductor-endpoint <url>`
- `--database-path <path>`

Use `pr-shepherd <command> --help` for the complete generated CLI syntax.
