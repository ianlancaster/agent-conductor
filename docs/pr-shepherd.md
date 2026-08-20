# PR Shepherd V2

PR Shepherd V2 is an opt-in GitHub polling service shipped with Agent Conductor. It keeps pull-request policy and delivery durability in its own SQLite database, and can either print fact-only events or send them to a coordinator through Conductor's protected `send_to_session` operation.

`conductor start` copy-once scaffolds an inert PR Shepherd profile beside `supervisor.yaml`. It
never overwrites an existing profile and never polls GitHub until the identity is configured.
Shepherd may still run standalone, or Conductor can own its lifecycle through an opt-in root
`shepherd` block. The managed default is headless. A healthy managed companion is shown
concisely in fleet `/status`; companion failure never takes down Conductor.

## Prerequisites

- Node.js 22.13 or newer (23.4 or newer on the non-LTS Node 23 line) and the Agent Conductor package installed or built
- [GitHub CLI](https://cli.github.com/) available as `gh`
- A successful `gh auth status` for the GitHub account that will poll repositories
- Read access to the configured repositories; write access is required only for automation policies set to `execute`
- A local Conductor process only when using `delivery.type: conductor`

Install the GitHub beta package:

```bash
npm install --global https://github.com/ianlancaster/agent-conductor/releases/download/v0.2.0-beta.0/agent-conductor-0.2.0-beta.0.tgz
pr-shepherd --help
```

The package provides both `conductor` and `pr-shepherd`. The Shepherd is still a separate process;
installing the command does not enable it.

## Safe first run

1. Start Conductor once, edit the generated profile, and remove its
   `identity-required` marker after replacing `CHANGE_ME`:

   ```bash
   conductor start
   ${EDITOR:-vi} .conductor/config/pr-shepherd.yaml
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
   pr-shepherd -C /path/to/fleet validate
   ```

4. Run one poll. With stdout delivery and `notify`/`off` automation, this does not modify GitHub or contact Conductor:

   ```bash
   pr-shepherd -C /path/to/fleet poll --once
   ```

5. Inspect persisted state and recent events:

   ```bash
   pr-shepherd -C /path/to/fleet status
   pr-shepherd -C /path/to/fleet events --limit 50
   pr-shepherd -C /path/to/fleet inbox
   ```

6. Once the observed decisions are correct, enable the managed companion and restart Conductor:

   ```bash
   shepherd:
     enabled: true
     configPath: null
     presentation: headless
   ```

Conductor starts Shepherd after its own control plane is ready and stops it during shutdown.
`pr-shepherd init -C <fleet>` recreates only a missing profile and never overwrites one. Profile
and supervisor changes take effect after a deliberate Conductor restart.

Pausing the configured coordinator session, including through `/pause all`, also stops the managed
Shepherd process. `/resume <coordinator>` or `/resume all` starts it again. Because session pause
state is persisted, Conductor does not start Shepherd while its coordinator remains paused after a
restart. Conductor also rejects a delivery request that reaches it while the coordinator is paused
as retryable, so Shepherd retains it in the outbox for delivery after resume.

While the managed companion has a fresh healthy heartbeat, fleet `/status` adds
`PR Shepherd Status Online` directly below `Agent Conductor Status` and marks the configured
coordinator session with `🐑`. If Shepherd is disabled or unhealthy, the concise fleet view omits
it entirely. Use `pr-shepherd -C <fleet> status` and the Conductor logs for the resolved profile,
PID, heartbeat, restart state, and bounded diagnostic detail. A `failed` state means the bounded
crash-restart policy gave up; fix the reported cause and restart Conductor.

## Configuration reference

Configuration is strict, versioned YAML: unknown keys and unknown guidance event names are rejected. CLI overrides take precedence over environment variables, which take precedence over YAML.

| Setting                                    | Purpose and default                                                                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                                  | Required schema version; currently `2`.                                                                                                |
| `profile.githubUser`                       | Required GitHub username managed by this process.                                                                                      |
| `polling.intervalSeconds`                  | Start-to-start polling interval; default `180`, minimum `10`. Cycles never overlap.                                                    |
| `polling.bootstrap`                        | `notify-current` emits current conditions on first discovery; `baseline-only` records them without emitting. Default `notify-current`. |
| `github.defaultRepo`                       | Optional profile metadata for a primary repository; default `null`.                                                                    |
| `github.includeOwners` / `includeRepos`    | Optional owner and repository allowlists. Empty lists allow all repositories.                                                          |
| `github.excludeOwners` / `excludeRepos`    | Owner and repository denylists applied after includes.                                                                                 |
| `github.mode`                              | `direct` or `merge-queue`; default `direct`. Direct updates behind PRs first; queue mode avoids merely-behind updates.                 |
| `github.mergeMethod`                       | `squash`, `merge`, or `rebase`; default `squash`.                                                                                      |
| `checks.required`                          | If non-empty, only these check names determine readiness.                                                                              |
| `checks.ignored`                           | Check names removed before evaluation.                                                                                                 |
| `reviews.ignoredActors`                    | Case-insensitive actor names ignored for review/comment signals.                                                                       |
| `reviews.ignoredCommentPatterns`           | Case-insensitive regular expressions suppressed from human-comment events.                                                             |
| `reviews.requiredApprovals`                | Approval count required for readiness; default `1`.                                                                                    |
| `reviews.bots[]`                           | Configurable bot username, actionable and positive patterns, inbox gating, and feedback-attempt limit.                                 |
| `features.authoredPRs.enabled`             | Monitor authored pull requests; default `true`.                                                                                        |
| `features.trackedPRs.enabled`              | Enable durable claim controls and the tracked owned-PR lane; disabled by default.                                                      |
| `features.trackedPRs.releaseGate`          | `none` or `exact-head-attestation`; default `none`. The value is captured on each new claim generation.                                |
| `features.trackedPRs.selectors`            | Optional generic auto-claim rules for exact labels or case-insensitive head-branch prefixes; default `[]`.                             |
| `features.reviewInbox`                     | Optional assigned-review workflow with draft, repository, age, and case-insensitive head-regex exclusions; disabled by default.        |
| `features.reviewInbox.ignoredHeadPatterns` | Case-insensitive regular expressions matched against `headRefName` before review-inbox/follow-up state or delivery; default `[]`.      |
| `features.reviewFollowUp.enabled`          | Track actionable requested-change or inline-comment reviews and emit scoped follow-up transitions; disabled by default.                |
| `features.reviewerNudge`                   | Optional reviewer-comment/escalation workflow, including threshold, weekday handling, timezone, and repeat cap; disabled by default.   |
| `features.staleThresholdHours`             | Authored-PR staleness interval; default `4`. Set `0` for immediate first-cycle staleness.                                              |
| `automation.autoMerge`                     | `off`, `notify`, or `execute`; default `notify`.                                                                                       |
| `automation.branchUpdate`                  | `off`, `notify`, or `execute`; default `notify`.                                                                                       |
| `automation.reviewerComment`               | `off`, `notify`, or `execute`; default `notify`.                                                                                       |
| `delivery.type`                            | `stdout` or `conductor`; default `stdout`.                                                                                             |
| `delivery.endpoint`                        | Required for Conductor delivery and restricted to a localhost URL.                                                                     |
| `delivery.coordinatorSession`              | Required Conductor recipient for all Shepherd events.                                                                                  |
| `guidance`                                 | Optional text keyed by emitted event type and appended to the generic fact message.                                                    |
| `databasePath`                             | Independent SQLite database, resolved relative to the profile; default `./data/pr-shepherd-v2.db`.                                     |

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

The engine emits generic facts for CI failures, review feedback, bot findings, human comments, approvals, conflicts, merges, staleness, tracked-PR claims and head changes, release attest/revoke/gate state, review dispatch/completion, scoped re-review, reviewer escalation, automation decisions, `branch-behind`, and `branch-update-failed`. Production messages contain no hard-coded organization, repository, bot, CI-command, or worker-routing policy.

### Persistent tracked pull requests

With `features.trackedPRs.enabled: true`, a local operator can explicitly claim an open pull request
independently of `profile.githubUser`. Shepherd then direct-fetches that durable claim on every poll
and applies the authored lifecycle for checks, feedback, comments, approvals, conflicts, staleness,
head changes, closure, and merge. Review-request removal and review-inbox completion do not release
the claim. A PR that is both profile-authored and claimed is fetched and evaluated once.

The `claim` command atomically persists its verified GitHub snapshot as the new claim generation's
baseline, even when the profile uses `notify-current`, so claiming a mature PR does not replay all
of its historical conditions and a head change immediately after claiming is not lost. New
changes after that baseline emit normally. Every later observation commits only while that exact
claim generation is still active. Merge or closure marks the claim terminal and removes
live lifecycle/action state while retaining the claim and control audit. Explicit unclaim creates a
durable tombstone; a later manual claim increments the claim generation. Unknown or unreachable
PRs produce a retryable error and no false claim. Closed and merged PRs produce durable,
idempotently replayable rejections.

When a new `exact-head-attestation` claim inherits a GitHub merge-queue entry or persistent
auto-merge request, `claim` first records a durable handoff plus state-aware dequeue and/or
disable-auto-merge actions under Shepherd's mutation mutex. It does not create the tracked row,
generation baseline, claim audit, event, or outbox item until a fresh details and automation read
agree on the current head and prove both provider states clear. A provider failure therefore leaves
no false claim. Retry the same idempotency key and arguments to resume pending work; this is also
safe after a crash where GitHub accepted the mutation but Shepherd did not record completion.
Completed provider work is detected rather than submitted twice. If the head moves during the
handoff, the stale snapshot is never committed; retrying the same key verifies and captures the new
current head. The reserved generation is fenced at final commit, so an intervening claim cannot be
overwritten.

Selectors can seed the same durable lane without depending on `profile.githubUser` or a transient
review request. Each strict selector has a stable `id`, a `type` of `head-prefix` or `label`, and
one or more `values`; selector entries and values are ORed. Label matching uses GitHub's exact
label qualifier. Head-prefix matching is case-insensitive and examines the pull request's actual
`headRefName`. Draft pull requests are included. Scope allowlists and denylists still apply.

```yaml
features:
  trackedPRs:
    enabled: true
    releaseGate: exact-head-attestation
    selectors:
      - { id: generated-branch, type: head-prefix, values: [generated/] }
      - { id: stewardship-label, type: label, values: [stewardship] }
```

A first match verifies the open pull request, records its current snapshot as generation 1's
baseline, and emits `tracked-pr-claimed` with selector evidence. Multiple matches coalesce into one
claim. An active claim remains owned even if its label or branch later changes. An explicit
unclaim is a durable tombstone: selectors do not reclaim it, while a later explicit manual claim
may start a new generation. Non-exhaustive GitHub search is reported as a coverage warning and
never interpreted as absence. Selectors remain observation-only with respect to provider merge
automation: an exact-head candidate that is already queued or has persistent auto-merge remains
unclaimed until an operator uses the explicit `claim` control to perform the safe handoff.

Control mutations require a caller-supplied idempotency key. Reusing the same key and arguments
returns the stored result; reusing it for different arguments is rejected. Evidence is a generic
JSON value capped at 16 KiB and must not contain secrets. `pr-shepherd tracked --audit --limit 100
--offset 0` prints the durable claims, operation history, total, and `hasMore` pagination metadata,
including idempotent no-ops and permanent rejections. The
CLI `--actor` value is audit attribution asserted by a caller in
the existing same-user local trust boundary; it is not cryptographic identity.

With the default `releaseGate: none`, tracked-only merge execution remains at `notify`, even when
global `automation.autoMerge` is `execute`, and the prohibition is rechecked before executing a
persisted action. Ordinary profile-authored PR behavior remains unchanged.

### Owned pull-request review threads

The authored lifecycle used by profile-authored and explicitly tracked pull requests emits one
coalesced `review-feedback` event per poll for newly submitted feedback and received inline-thread
activity. A new thread is actionable even when its enclosing `COMMENTED` review has an empty body.
Later replies and transitions into outdated or resolved state reuse the same generic event type;
disappearance and later reappearance is a recurrent thread-created transition. No reviewer or
organization identity is built into this observation layer. Reviews, roots, and replies authored
by `profile.githubUser` or a case-insensitive `reviews.ignoredActors` entry do not emit received
work. Their comment IDs still advance the durable seen cursor, so changing configuration or
restarting does not replay suppressed content.

Each event lists every triggering reason and relevant review with its ID, author, state, bounded
body, submission time, and reviewed commit when available. Affected threads are rendered in stable
thread-ID order. Their facts include the thread, review, and root-comment IDs; root author and
bounded root body; thread and comment URLs; path; original/current line and side; current
outdated/resolved state; and bounded metadata for new replies. Coordinators can therefore route a
finding or verify a resolution without a second GitHub discovery pass. Whenever exactly one new
actionable review anchors the coalesced event, it retains the earlier `{reviewId,state}` event
identity and top-level `reviewId`, `state`, `reviewer`, and `body` fields—even when its inline thread
appears in the same poll. A thread that arrives in a later partial observation or reappears in a
later cycle gets its own transition identity.

The complete serialized `review-feedback` event, including its protected-delivery message, is
limited to 64 KiB. Individual review, root, reply, and legacy top-level bodies begin with a 4 KiB
UTF-8 allowance. If the aggregate would exceed its ceiling, Shepherd deterministically reduces the
text allowance and then the number of rendered reviews, threads, or replies. Every shortened body
has adjacent `bodyTruncated: true` and `bodyOriginalBytes` fields. The `payload` summary reports the
ceiling, effective text allowance, total/included/omitted counts for each context kind, and whether
the aggregate or configured guidance was truncated. Transition ID arrays retain the first 25
sorted values; larger arrays add an explicit truncation flag, total count, and stable digest so
event identity remains recurrence-safe without defeating the aggregate ceiling. Stable IDs and
URLs remain on every rendered item; omission counts explicitly tell the coordinator when a
follow-up fetch is required.

The received-thread cursor lives in the existing authored entity. Thread presence, seen comment
IDs, and recurrence counters are committed in the same SQLite transaction as the event and durable
outbox row. Unchanged observations deduplicate across polls and restarts; later replies and repeated
created, outdated, or resolved cycles remain distinct. A claim's verified snapshot and
`polling.bootstrap: baseline-only` both establish a complete baseline without replaying historical
threads, replies, or states. Existing entity JSON without the optional cursor derives its baseline
from the last stored pull-request snapshot, so this capability requires no schema migration.

The delivery ceiling is not a data-retention boundary. Shepherd's live authored entity still holds
the complete GitHub snapshot, including review-thread bodies, until lifecycle cleanup. Bounded event
and outbox copies remain durable in the Shepherd database according to the deployment's database
retention. Protect that database as review content, avoid putting secrets in review text or
guidance, and apply the deployment's normal database retention/removal procedure.

### Exact-head release gate

Set `features.trackedPRs.releaseGate: exact-head-attestation` before creating a new claim generation
to opt that claim into the external gate. Existing claims retain the gate mode they captured; use a
safe unclaim and new claim to change modes. The release gate is generic: policy engines and human
workflows resolve their own criteria, then record only the resulting actor, exact head SHA, and JSON
evidence with `pr-shepherd attest`. Organization-specific rules belong in coordinator policy and
profile guidance, not Shepherd.

An attestation applies only while its SHA exactly equals GitHub's current head and its claim
generation remains active. Missing, stale, and revoked attestations emit a durable
`release-gate-blocked` fact and cannot create or execute a merge action. A same-head re-attestation
after revoke creates a new attestation cycle and therefore a new decision. In `direct` mode,
Shepherd safely removes inherited persistent auto-merge or merge-queue state before establishing a
new gated claim. Attestation still refuses while either provider state is active. Shepherd calls
GitHub's conditional merge with `expectedHeadOid` in `direct` mode; in `merge-queue` mode it calls
conditional enqueue with `expectedHeadOid`. Gated claims never use persistent auto-merge.
Applicability is fetched and checked again under a durable SQLite mutation mutex immediately before
the provider mutation. The mutex renews its lease and will not let an expired lease be taken from a
still-live local owner process, so event-loop or provider delays cannot create overlapping local
mutations. Ownership is fenced again around each provider call. Changing or disabling the
configured gate cancels a persisted exact-head action rather than falling back to ordinary
auto-merge, but a crash-ambiguous enqueue is first paired atomically with durable dequeue safety
work. Revoke outstanding attestations and finish compensation before disabling the gate; cleanup
revoke remains available afterward, but new attestations do not.

`pr-shepherd revoke` atomically revokes active attestations and cancels local pending merge/enqueue
actions. A completed—or crash-ambiguous pending—queue submission creates a durable dequeue
compensation action; an inherited or crash-ambiguous legacy auto-merge action creates a durable
disable-auto-merge compensation. Provider state checks make these retries idempotent, and failed
compensation remains pending across restart even if the gate is later disabled or repository scope
is narrowed. Startup repairs previously cancelled enqueue/auto-merge actions into the same durable
safety work. Replaying the original revoke key adopts that standalone repair into the original
release audit, including when cleanup already completed before the replay. A direct
merge cannot be undone after GitHub accepts it; the exact-head conditional and the shared mutex
prevent a concurrent local revoke from crossing that submission, but no system can compensate a
process crash after a completed direct merge. Safe unclaim is refused until attestation revocation
and any queue compensation are complete.

Attest and revoke require caller-supplied idempotency keys and persist their normalized evidence,
actor, head/reason, result, and timestamps in SQLite. `pr-shepherd release-audit --limit 100
--offset 0` prints this bounded, paginated history. As with claim controls, `--actor` is audit
attribution under the same-user local trust boundary, not authenticated identity.

Review-inbox completion facts include an outcome: `bot-auto-approved`, `already-reviewed`, or
`assignment-ended`. Once an assignment reaches either of the first two terminal dispositions,
its later disappearance from GitHub's review-requested search only clears tracking state; it
does not emit a second generic completion.

### Review-inbox head exclusions

`features.reviewInbox.ignoredHeadPatterns` is a list of JavaScript regular expressions matched
case-insensitively against GitHub's `headRefName`. For example, `['^abby/']` excludes both
`abby/change` and `Abby/change`. Invalid expressions fail profile validation at the exact list
index. An omitted or empty list preserves the existing behavior.

This is a pre-delivery boundary for the assigned-review lane. A match is checked before Shepherd
creates or updates review-inbox or review-follow-up state and before it creates their outbox work.
It suppresses `review-dispatch`, `review-completed`, and `scoped-re-review`, including undelivered
rows created before the profile change. Enabling a pattern silently clears existing assigned-review
and follow-up state for matching PRs, so later review-request removal does not produce a completion.

The exclusion does not alter the authored/tracked lane, durable claims, release attestations,
provider mutations, compensation actions, received `review-feedback`, or reviewer-nudge work owned
through that separate lane. A different profile can therefore continue to own the same PR through
its authored identity or tracked selectors. Removing an exclusion lets an eligible PR enter again
under the configured `polling.bootstrap` and current-state semantics. Historical thread replies are
not replayed as new activity; only a currently actionable head or request condition can produce the
normal current-state event.

```yaml
features:
  reviewInbox:
    enabled: true
    ignoredHeadPatterns:
      - '^abby/'
```

### Review follow-up lifecycle

With `features.reviewFollowUp.enabled: true`, Shepherd follows both `CHANGES_REQUESTED` reviews and
`COMMENTED` reviews that contain at least one inline thread rooted by `profile.githubUser`. An empty
or body-only `COMMENTED` review is not actionable. A later approval by that reviewer closes all
earlier findings; inline findings submitted after the approval establish a fresh lifecycle.
Dismissed findings are likewise removed when no later actionable review remains.

After the lifecycle baseline, Shepherd emits one coalesced `scoped-re-review` event per poll when
the reviewed head changes, another participant adds an inline-thread reply, a tracked thread
becomes outdated or resolved, or GitHub explicitly requests the configured reviewer again. The
reviewer's own replies and replies from `reviews.ignoredActors` advance the baseline without
emitting work. Ordinary issue comments are not review-thread replies. Persistent heads, thread
states, replies, and review requests do not repeat events; later heads, reply IDs, and state or
request transitions remain independently recurrent.

Each event names every triggering reason and active review ID, the reviewed and current heads, and
the current explicit-request state. Affected-thread facts include the thread and root-comment IDs,
URL, path, original/current line and side when GitHub provides them, a concise root-finding excerpt,
current outdated/resolved state, and the author, body, timestamps, and URL of each new reply. The
coordinator can therefore dispatch a scoped reviewer without first rediscovering the triggering
comments.

`polling.bootstrap: baseline-only` records existing heads, replies, thread state, and review
requests without emitting historical follow-up work. The same cursors are persisted in Shepherd's
SQLite entity state. State, event, and durable outbox insertion share one transaction, so a restart
cannot separate a delivered transition from its deduplication cursor. `pr-shepherd status` counts
each open lifecycle under `followUps`; approval, dismissal without a later actionable review, PR
closure, or merge removes it.

Put private workflow instructions in `guidance`, for example:

```yaml
guidance:
  ci-failed: Follow this repository's documented validation procedure before reporting a fix.
  review-dispatch: Assign the review using your team's normal ownership process.
```

Repository scope is applied in GitHub search queries and again to returned objects. Every search page is consumed. A truncated or incomplete search logs a coverage warning and disables absence-based cleanup for that cycle.

Staleness is measured from GitHub's `updatedAt`, so comments and other activity restart the window even when the head SHA is unchanged. Business-day escalation counts elapsed instants falling Monday through Friday in the configured IANA timezone; it does not imply working hours or a holiday calendar.

Direct mode withholds readiness while a mergeable PR is behind and refreshes it according to
`automation.branchUpdate`. Queue mode may enqueue a ready, mergeable `BEHIND` PR without updating
it first. `UNKNOWN` waits. Each transition into `CONFLICTING` emits a `conflict` fact and requires
coordinator/operator resolution; Shepherd does not invent merge-conflict policy.

In reviewer-comment `notify` mode, escalation timing starts when the decision is emitted. In `execute` mode it starts after the idempotent comment is confirmed. With reviewer-comment automation `off`, no comment decision or mutation is produced, but an enabled reviewer-nudge feature still starts escalation timing when a fix is detected.

## Conductor delivery and trust model

The initial integration is localhost-only and has no token setting. The sender comes from `/mcp/pr-shepherd`; it is mechanically assigned but not cryptographically authenticated. Do not expose the endpoint beyond localhost, and run only one Shepherd profile per Conductor instance while the sender name remains fixed.

Delivery uses a persisted `shepherd:<event-id>:<recipient>` idempotency key. Only a `delivered` Conductor receipt completes the Shepherd outbox. A `queued` receipt remains in Shepherd's own durable retry loop because local Conductor queues are process-local and are cancelled on restart. An explicit retry with the same key revives a receipt cancelled by restart. Transport and internal errors retry with bounded exponential backoff; permanent recipient validation errors are parked and recorded in health history.

For rollout, first compare `baseline-only` stdout behavior with the system being replaced. Stop the old system before enabling Conductor delivery, then move each automation policy from `notify` to `execute` independently.

Use a fresh `databasePath`, `polling.bootstrap: baseline-only`, stdout delivery, and only `off` or
`notify` automation for a shadow rollout. Bootstrap completion is stored by discovery kind, not by
GitHub identity. Reusing a database after changing `profile.githubUser` (or after adding/changing a
future selector definition) can therefore treat a different population as already bootstrapped.
Also, durable outbox rows keep the recipient captured when each event was created; changing
`delivery.coordinatorSession` does not retarget existing rows. Drain, park, or deliberately replace
the database before an identity/selection/recipient cutover rather than assuming profile edits
rewrite durable state.

## Command reference

```bash
pr-shepherd -C /path/to/fleet init
pr-shepherd -C /path/to/fleet validate
pr-shepherd -C /path/to/fleet poll --once
pr-shepherd -C /path/to/fleet start
pr-shepherd -C /path/to/fleet status
pr-shepherd -C /path/to/fleet events --limit 50
pr-shepherd -C /path/to/fleet inbox
pr-shepherd -C /path/to/fleet claim --repo owner/name --pr 123 --actor local-user --evidence-file evidence.json --idempotency-key claim-owner-name-123
pr-shepherd -C /path/to/fleet unclaim --repo owner/name --pr 123 --actor local-user --evidence-file reason.json --idempotency-key unclaim-owner-name-123
pr-shepherd -C /path/to/fleet attest --repo owner/name --pr 123 --head HEAD_SHA --actor local-user --evidence-file release.json --idempotency-key attest-owner-name-123-HEAD_SHA
pr-shepherd -C /path/to/fleet revoke --repo owner/name --pr 123 --reason "release withdrawn" --actor local-user --evidence-file revoke.json --idempotency-key revoke-owner-name-123
pr-shepherd -C /path/to/fleet tracked
pr-shepherd -C /path/to/fleet tracked --audit --limit 100 --offset 0
pr-shepherd -C /path/to/fleet release-audit --limit 100 --offset 0
```

All commands accept these optional overrides:

- `--github-user <username>`
- `--coordinator-session <codename>`
- `--conductor-endpoint <url>`
- `--database-path <path>`

Use `pr-shepherd <command> --help` for the complete generated CLI syntax.
