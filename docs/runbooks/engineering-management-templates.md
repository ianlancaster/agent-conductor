<!-- conductor-topic:runbook-engineering-management-templates -->

## Engineering management — copyable configuration and artifact templates

These examples are starting points. Replace paths and policy, keep each persistent role in a
separate directory, and validate before starting the fleet.

### Persistent session definitions

```yaml
# .conductor/config/sessions/em.yaml
codename: em
repo: /fleets/product/workspaces/em
runtime: claude-code
additionalDirs:
  - /projects/product-canonical
  - /fleets/product/records
systemPromptFile: /fleets/product/roles/engineering-manager.md
schedules: []
```

```yaml
# .conductor/config/sessions/sentinel.yaml
codename: sentinel
repo: /fleets/product/workspaces/sentinel
runtime: codex
additionalDirs:
  - /fleets/product/records
systemPromptFile: /fleets/product/roles/stall-sentinel.md
schedules: []
```

```yaml
# Optional peer EM, deliberately a different runtime/model family
codename: peer-em
repo: /fleets/product/workspaces/peer-em
runtime: codex
additionalDirs:
  - /projects/product-canonical
  - /fleets/product/records
systemPromptFile: /fleets/product/roles/peer-engineering-manager.md
schedules: []
```

Create the directories, run `conductor validate`, then start and designate the Sentinel. Arrange the
main window as described in `runbook-engineering-management`; workers use tab placement.

### Engineering Manager role script

Define the operator's actual process rather than copying a generic “be a manager” prompt. Cover:

```markdown
# Engineering Manager

## Mission

Hold the operator's initiative arc, keep the canonical repository clean, and integrate only
reviewed work.

## Dispatch contract

- Freeze and record the canonical base SHA.
- Give one lane bounded ownership, acceptance criteria, required checks, and stop conditions.
- Spawn disposable workers in new tabs with records access and a role prompt.
- Require the worker to report commit SHA, evidence, risks, and unresolved questions.

## Gates

- Review plans before implementation when risk crosses our stated threshold.
- Review delivery evidence before integration.
- Use a fresh reviewer at an immutable commit for high-risk work.
- Never treat silence or a successful message receipt as proof of task completion.

## Integration and cleanup

- Integrate in the canonical repository only after the required gates pass.
- Archive decisions and delivery notes outside disposable worktrees.
- Verify a clean lane before teardown; retain anything ambiguous for recovery.

## Escalation and context

- Ask the operator before destructive, credentialed, scope-changing, or policy-sensitive actions.
- At milestone boundaries, record decisions, reassess remaining context, and start fresh roles when
  accumulated history is no longer useful.
```

Add project-specific review rules, risk tiers, definition of done, release process, and escalation
boundaries. Keep Conductor tool syntax out of this script; injected tool schemas remain authoritative.

### Dispatch brief

```markdown
# <work item> — dispatch brief

## Outcome

What must be true when the lane finishes.

## Lane stamp

- Canonical base SHA: <sha>
- Worker branch: <branch>
- Worker session: <codename>
- Runtime/model: <resolved values>
- Owned paths: <paths>

## Required context

- Read: <documents and code>
- Records directory: <path>
- Report to: <EM session>

## Acceptance gates

- Required behavior: <criteria>
- Required automated checks: <commands>
- Required manual checks: <checks>
- Scope exclusions: <non-goals>

## Protocol

1. Inspect before editing.
2. For plan-gated work, write and send the plan, then wait for approval.
3. Commit only owned work; do not integrate into the canonical branch.
4. Write the delivery note and send READY with commit SHA and evidence.
5. Stop and consult before crossing an approval boundary or changing scope.
```

### Implementation plan

```markdown
# <work item> — implementation plan

## Problem statement

Observed behavior, required behavior, and why the change belongs here.

## Design

Chosen approach, alternatives rejected, invariants, and interfaces affected.

## Changes by area

Files/components and the purpose of each change.

## Test plan

Automated checks, manual scenarios, and failure-path coverage.

## Risk and scope check

Migration, compatibility, security, performance, rollback, unknowns, and explicit non-goals.
```

### Delivery note

```markdown
# <work item> — delivery

## Result

What was built and which acceptance criteria now pass.

## Immutable reference

- Commit SHA: <sha>
- Base SHA: <sha>
- Branch: <branch>

## Verification evidence

Commands run, results, and relevant artifacts. Distinguish executed checks from recommended checks.

## Manual test plan

Operator-visible steps and expected results.

## Deviations and remaining risk

Changes from the approved plan, known limitations, follow-ups, and unresolved questions.
```

### Independent review gate

```markdown
# <work item> — independent review

## Frozen input

- Review commit: <worker sha>
- Expected base: <base sha>
- Acceptance criteria: <link/path>
- Plan and delivery note: <links/paths>

## Review rules

- Review the frozen commit; do not mutate the contributor's branch.
- Verify behavior, tests, failure paths, scope, security, and maintainability.
- Report findings by severity with file/line evidence.
- Distinguish blocking findings, non-blocking improvements, and questions.
- Do not implement fixes in this lane unless the EM creates a new assignment.

## Verdict

Accept, accept with follow-up, or changes required, with concise reasons.
```

### Fresh-lane provisioning checklist

Before dispatch, the EM or a deterministic bootstrap script should:

1. verify the frozen base and created branch;
2. restore dependencies and only the minimum required non-secret local configuration;
3. allocate leased ports or services before starting them and record ownership;
4. confirm the role prompt and records directory are passed through spawn configuration;
5. record the lane stamp from actual provisioning output;
6. run a cheap repository sanity check;
7. send the dispatch only after the lane is ready.

Do not copy secrets from another worktree, rely on ignored files being present, or write a generated
instruction anchor into the lane. Use a secret store, `additionalDirs`, and `systemPromptFile`.
Release leased resources last during teardown.
