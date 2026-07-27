# Durable Session Instructions Plan

Status: proposed; implementation not started

Audience: maintainers, runtime-adapter contributors, and fleet operators

Scope: make the existing per-session instruction file survive context compaction consistently in
Claude Code and Codex

## Decision

Agent Conductor should provide one runtime-neutral guarantee:

> When a session has `systemPromptFile` configured, Conductor applies those instructions at launch
> and restores them after every confirmed context compaction.

This is a valuable and appropriately mechanical Conductor primitive. Long-running workers,
reviewers, coordinators, and sentinels need their role and assignment constraints after the runtime
rebuilds context. The guarantee is useful across fleet layouts and does not require Conductor to
interpret the instructions or decide what the agent should do.

The implementation should extend the existing `systemPromptFile` setting rather than introduce a
parallel `genome`, `genomePath`, or `set_genome` API. “Durable session instructions” is the public
product language; fleets remain free to call their own instruction documents genomes, role briefs,
lane stamps, or anything else.

## Current ground truth

Conductor already has most of the required startup path:

- `SessionConfig.systemPromptFile` accepts a configuration-relative or absolute file path.
- `spawn_session.systemPromptFile` and `/spawn --system-prompt` expose the same setting.
- Claude Code receives the Conductor protocol followed by the session instruction file through
  repeated `--append-system-prompt-file` arguments.
- Codex receives the Conductor protocol and session instructions in the conductor-managed section
  of its isolated `AGENTS.override.md`.
- Codex already has a generated `SessionStart` hook matched to `source=compact`. It restores the
  Conductor protocol through `hookSpecificOutput.additionalContext` and reports the lifecycle event
  to Conductor.
- Both runtime adapters report compact completion, and core health waits for compact completion plus
  a visible composer before producing post-compaction idle evidence.

The remaining product gap is narrow: the Codex compact hook restores the Conductor protocol but not
`systemPromptFile`, and Claude Code does not yet have an equivalent conductor-owned restoration path
for `systemPromptFile`.

The runtime mechanisms are supported rather than pane-derived:

- Codex `SessionStart(source=compact)` may return `hookSpecificOutput.additionalContext` as extra
  developer context. See the [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks).
- Claude Code `SessionStart` supports a `compact` matcher, and hook output may be added to context.
  See the [Claude Code hooks documentation](https://code.claude.com/docs/en/hooks).
- Claude project instructions have their own hierarchy and compaction behavior, but Conductor does
  not need to modify repository-owned `CLAUDE.local.md` files to use them. See the
  [Claude Code memory documentation](https://code.claude.com/docs/en/memory).

## Product fit

This feature clears the contributor feature bar:

1. Instruction loss after compaction is a recurring reliability problem for any long-lived role,
   not one fleet’s workflow.
2. Users cannot compose a cross-runtime guarantee from current public primitives: the setting is
   applied at launch, while compaction restoration is adapter-owned.
3. Restoring configured bytes is mechanical. Conductor does not judge, summarize, rewrite, or act
   on the instruction content.
4. Shared policy belongs in one preparation contract; provider-specific injection remains inside
   each `SessionRuntime` adapter.
5. The repository already contains the configuration, launch paths, Codex restoration mechanism,
   and real incidents demonstrating the incomplete guarantee.

The feature must not become memory management, a workflow engine, or an implicit continuation
system. Restoring instructions supplies context; it does not submit a prompt, resume work, or infer
what is actionable.

## Goals

- Preserve one existing, runtime-neutral configuration primitive.
- Apply the same version-matched protocol and configured session instructions at launch and after
  compaction.
- Keep all generated artifacts in Conductor-owned session data, never in the working repository.
- Fail visibly when configured instructions cannot be read or safely injected.
- Keep instruction content out of logs, receipts, status output, and event payloads.
- Expose only mechanically truthful restoration observability.
- Preserve current runtime isolation and hook-trust defaults.
- Work for multiple sessions using the same repository with different instruction files.

## Non-goals

The first release will not add:

- `genome`, `genomePath`, `set_genome`, or another parallel configuration vocabulary;
- inline instruction bodies in YAML, commands, or MCP requests;
- an immediate mutation or hot-reload operation for a running CLI;
- automatic `continue`, pane input, a post-compact nudge, or any other submitted prompt;
- model-side confirmation that the instructions were understood, retained, or followed;
- automatic summarization, reconciliation, or conflict resolution between instruction layers;
- writes to `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, or other repository-owned files;
- a machine-global hook that must discover fleet or session identity at runtime;
- a hook marketplace, plugin requirement, or dangerous hook-trust bypass;
- secrets support—the instruction file remains ordinary local text and must not contain secrets.

## Public contract

The existing configuration remains canonical and backward compatible:

```yaml
codename: reviewer
repo: /absolute/path/to/project
runtime: codex
systemPromptFile: ./.conductor/prompts/reviewer.md
```

The strengthened semantics are:

1. The path is resolved using the existing fleet configuration rules.
2. Conductor reads and validates it during runtime preparation.
3. Launch receives the mandatory Conductor protocol followed by the session instructions.
4. A confirmed compaction restores both layers through the runtime’s supported context channel.
5. Editing session configuration or its referenced file does not rewrite a running CLI. The new
   content takes effect on the next `start_session` or `continue_session`, matching current launch
   setting semantics.
6. Missing, unreadable, non-file, or oversized content produces a clear preparation error. It is
   never silently skipped or truncated.
7. An absent `systemPromptFile` keeps current behavior: only the mandatory protocol is restored.

No new MCP tool or operator command is required. Existing `spawn_session`, `/spawn`, session YAML,
and lifecycle operations remain the complete control surface.

## Content and size discipline

The instruction layer needs a hard product limit, not a fleet setting. Hook output has finite
model-visible capacity, and silent runtime fallback to a preview would violate the durability
claim.

During the feasibility spike, measure the encoded protocol and instruction payload against both
runtimes’ documented and observed hook behavior. Ratify one conservative byte limit for the user
instruction layer before implementation; 8 KiB is the largest candidate, not a predetermined
promise. The chosen constant must leave headroom for the mandatory protocol and JSON encoding.

Rules:

- validate UTF-8 byte length, not JavaScript character count;
- reject overflow with the actual size and allowed maximum, without echoing content;
- never truncate;
- keep protocol and session instructions as distinct labelled layers;
- add a test that fails if growth of the shipped protocol makes the complete restoration payload
  exceed the supported envelope;
- use restrictive permissions for conductor-owned instruction artifacts where supported.

## Shared preparation pipeline

Introduce one small internal helper owned by the runtime preparation boundary. Given the current
protocol and optional `systemPromptFile`, it should:

1. read the instruction file with a bounded read;
2. reject missing, unreadable, non-regular, or oversized files;
3. normalize only the final newline needed for generated output—do not rewrite prose;
4. calculate a SHA-256 digest of the session-instruction bytes for metadata-only observability;
5. write an atomic conductor-owned snapshot under the session’s existing `identity.configDir`; and
6. return structured layers to the runtime adapter rather than one ambiguous concatenated string.

The snapshot is runtime input, not durable user data. It is regenerated by `prepare()` and may be
replaced safely. The source file remains the operator-owned source of truth.

Use a shared content contract, not a shared hook generator. Claude Code and Codex should translate
the same layers through their own adapter-owned configuration formats.

## Claude Code adapter

At launch:

- preserve the current ordering: mandatory Conductor protocol first, session instructions second;
- use the validated prepared content rather than silently checking `existsSync` and skipping a bad
  configured path.

After compaction:

- add a conductor-generated `SessionStart` hook restricted to the runtime’s compact source;
- emit the prepared session-instruction layer as model-visible context;
- keep the existing lifecycle relay so core health still receives compact-complete evidence;
- restore the mandatory protocol through the same supported lifecycle boundary if the spike shows
  the launch-appended protocol is not already deterministically restored;
- ensure the restoration hook prints context but never submits terminal input.

The implementation must not create or merge a managed block in `CLAUDE.local.md`. Two Conductor
sessions may intentionally share a repository while requiring different roles, and repository
mutation would make those roles collide.

## Codex adapter

At launch:

- preserve the isolated per-session `CODEX_HOME`;
- keep the generated `AGENTS.override.md` ordering: inherited global guidance, mandatory Conductor
  protocol, then session instructions;
- use the validated prepared content for both startup and later restoration.

After compaction:

- retain `SessionStart(source=compact)` as the single post-compaction restoration point;
- extend the existing reminder path to restore the optional session-instruction layer as well as
  the protocol;
- do not also inject the same content from `PostCompact`, which would create duplicate developer
  context with ordering and deduplication ambiguity;
- preserve the best-effort lifecycle POST and ensure a down Conductor cannot prevent the hook from
  producing its local context output;
- keep hook execution bounded and content out of hook status messages.

The first release retains the existing trust model. Each session’s hook configuration lives in its
isolated home and is reviewed through Codex `/hooks` unless the operator has independently chosen
the existing broad bypass. Conductor must not silently enable or recommend that bypass.

## Observability contract

Observability must describe what Conductor knows, not what it hopes the model did.

Candidate status fields:

- `sessionInstructionsConfigured: boolean`
- `sessionInstructionsSha256?: string`
- `sessionInstructionsPreparedAt?: string`
- `lastCompactRestorationAttemptAt?: string`

Use “attempt” deliberately. Receipt of the compact `SessionStart` relay proves that the generated
restoration hook ran far enough to report itself; it cannot prove that the runtime accepted every
byte, that compaction retained the result, or that the model followed it.

If these fields are included in the first release:

- store only metadata, never content or source paths;
- add fields through an append-only SQLite migration;
- clear or replace prepared metadata on the next preparation attempt;
- preserve the last known failure explanation in operator diagnostics, not in managed-session
  protocol text;
- consider a metadata-only `session.instructions-restoration-attempted` Conductor event only if an
  external event consumer has a concrete need. Status does not require a new event vocabulary.

Observability may ship after the core restoration guarantee if it would otherwise delay the
reliability fix. Documentation must then state that verification is manual in the initial release.

## Failure and recovery behavior

| Failure                                          | Required behavior                                                       | Recovery                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Configured source is missing or unreadable       | Start/continue fails with a path-aware, content-free error              | Correct the path or permissions and retry                                  |
| Instruction layer exceeds the hard limit         | Start/continue fails; no truncation                                     | Reduce or split the instructions and retry                                 |
| Generated snapshot write fails                   | Start/continue fails before launching the runtime                       | Correct data-directory permissions and retry                               |
| Hook needs trust review                          | Runtime warns through its normal trust UI; Conductor does not bypass it | Review the generated hook with `/hooks`, then retry/continue as documented |
| Conductor endpoint is unavailable during compact | Local restoration still runs; lifecycle reporting is lost               | Restart Conductor if needed; the runtime context path remains independent  |
| Restoration hook times out or fails              | Runtime surfaces its hook failure; Conductor must not claim success     | Inspect runtime hook diagnostics and restart/continue after correction     |
| Source changes while the session is running      | Current prepared snapshot remains active                                | Start or continue the session to prepare the new version                   |

## Feasibility spike

Before changing the public guarantee, validate the mechanism using disposable sessions and generic
marker text. Do not use a maintainer’s live fleet.

For each supported runtime:

1. Create a temporary repository and instruction file with a unique, non-sensitive marker.
2. Start a session through the normal Conductor preparation and launch path.
3. Verify startup instruction presence with a controlled behavioral prompt.
4. Force manual compaction.
5. Verify the compact lifecycle event, visible composer, and post-compact marker behavior.
6. Repeat with automatic compaction if the runtime provides a deterministic test configuration.
7. Confirm no prompt or `continue` text was injected.
8. Stop and continue the session after changing the source file; verify only the newly prepared
   version is restored.
9. Run two sessions against the same repository with different instruction markers and prove that
   their contexts do not cross.
10. Exercise Codex with hook trust required and explicitly record the provisioning experience.

The spike is successful only if both runtimes provide deterministic post-compact context without
repository mutation or terminal typing. If either runtime cannot support that contract, document
the capability difference rather than simulating it with pane injection.

## Implementation sequence

### Phase 0 — Ratify runtime behavior

- Add or update the disposable manual shakedown under `test/manual/`.
- Run the feasibility spike against the supported Claude Code and Codex versions.
- Choose the hard instruction-size limit from observed supported behavior.
- Record whether Claude’s mandatory protocol needs explicit compact restoration in addition to the
  session-instruction layer.
- Confirm the exact hook-trust consequence of the generated Codex configuration change.

Gate: no public contract change until both runtime paths are proven.

### Phase 1 — Shared preparation and validation

- Add the bounded instruction reader and conductor-owned prepared artifact.
- Make both adapters consume the structured prepared layers.
- Turn configured missing/unreadable files from silent omission into typed preparation failures.
- Extend configuration validation where filesystem checks are appropriate.
- Add unit tests for path resolution, byte limits, Unicode byte counting, atomic replacement,
  missing files, permissions, and content privacy.

Gate: launch behavior remains backward compatible for valid configurations.

### Phase 2 — Runtime restoration

- Extend the Codex compact reminder with the prepared session-instruction layer.
- Add the Claude compact restoration hook through its existing generated settings.
- Preserve lifecycle event reporting and health semantics.
- Prove one restoration per compaction and no restoration on ordinary startup events beyond the
  existing launch path.
- Add adapter tests for exact hook matching, output shape, escaping, failure isolation, and absence
  of instruction content from logs.

Gate: the automated runtime-adapter tests and disposable manual spike both pass.

### Phase 3 — Truthful observability

- Add prepared digest/timestamp and compact restoration-attempt metadata if included in the first
  release.
- Update status rendering and operation results without exposing content or paths.
- Add the append-only migration if persistent status metadata is used.
- Test restart behavior and ensure old databases migrate normally.

Gate: status never states or implies model compliance.

### Phase 4 — Documentation and release completion

- Update README’s session-configuration overview.
- Update `docs/agent-guide.md` so managed agents understand the durable guarantee and its limits.
- Update getting-started, runtime interoperability, troubleshooting, and generated configuration
  examples.
- Update MCP descriptions and `/help` language for the existing `systemPromptFile` surface.
- Add manual verification and hook-trust recovery instructions.
- Add a minor changeset and verify the packed package contains every generated hook/runtime asset.
- Run typecheck, lint, formatting, all tests including tmux E2E, build, and package verification.

Gate: every applicable surface describes the same cross-runtime guarantee.

## Test matrix

Automated coverage should include:

- valid and absent `systemPromptFile` behavior;
- missing, unreadable, directory, malformed UTF-8 if applicable, and oversized sources;
- configuration-relative and absolute paths;
- shell/path escaping, including spaces and punctuation;
- no instruction content in errors, logs, status, events, or receipts;
- exact launch ordering for Claude Code and Codex;
- exact `SessionStart(source=compact)` matching;
- no duplicate restoration through `PostCompact` and `SessionStart`;
- lifecycle relay failure that does not suppress local restoration output;
- repeated compactions restoring the same prepared digest;
- source edits having no effect until the next preparation;
- two sessions sharing a repository without instruction crossover;
- status metadata across prepare, compaction attempt, stop, continue, and restart;
- old fleet configuration and pre-migration SQLite databases;
- packed-artifact execution from an external consumer installation.

Manual coverage should prove actual model-visible behavior on both supported runtimes. Generated
JSON and command-string unit tests alone are insufficient for this runtime contract.

## Applicable-surface audit

| Surface                 | Decision                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| Canonical core behavior | Shared bounded preparation contract; no model judgment                                     |
| Session MCP             | Existing `spawn_session.systemPromptFile`; description strengthened, no new tool           |
| Operator controls       | Existing `/spawn --system-prompt`; help text strengthened, no new command                  |
| Channels                | No transport-specific behavior; canonical command routing inherits existing syntax         |
| Runtime adapters        | Claude Code and Codex each own supported launch and compact-restoration mechanics          |
| Terminal backends       | Not applicable; no terminal typing or pane mutation                                        |
| Configuration           | Existing strict field retained; validation and examples strengthened                       |
| Persistence             | None for core restoration; append-only migration only if status metadata persists          |
| Events                  | No new event required for the guarantee; optional metadata event needs a concrete consumer |
| Public package          | Existing public configuration remains compatible; generated assets verified in tarball     |
| Documentation           | README, guides, troubleshooting, manual shakedown, and managed-agent reference updated     |
| Release                 | Minor changeset because a public configuration guarantee is strengthened                   |

## Compatibility and rollout

- Valid existing `systemPromptFile` configurations require no migration.
- Sessions without the setting behave as before.
- Invalid configured paths that were previously ignored will become visible start/continue errors;
  call this out as intentional hardening in release notes.
- Running sessions keep their currently prepared content until deliberately restarted or continued.
- A changed generated Codex hook definition may require operator review through `/hooks`; document
  the exact result observed during the spike.
- No database migration is needed unless persistent observability fields ship.
- Conductor must never restart or continue a user’s session automatically as part of upgrade or
  recovery.

## Deferred follow-ups

Reconsider these only with concrete demand and runtime evidence:

- operator-authorized refresh of a running session’s prepared instructions;
- atomic role-instruction updates through a canonical operation;
- reusable instruction bundles integrated with templates or runbook resources;
- externally observable restoration-attempt events;
- a managed Codex plugin or policy-owned hook distribution path that genuinely reduces trust
  friction without weakening isolation;
- richer instruction provenance beyond a digest and prepared timestamp.

Any future mutation operation must update a conductor-owned artifact, preserve content privacy,
define exact activation timing for both runtimes, and never smuggle a continuation prompt into the
session.

## Definition of completion

The feature is complete when:

1. a valid `systemPromptFile` is present at startup and restored after manual compaction in both
   supported runtimes;
2. automatic compaction is covered where each runtime exposes a deterministic test path;
3. no repository instruction file is created or modified;
4. no terminal input, `continue`, or other prompt is submitted;
5. invalid content fails visibly without truncation or leakage;
6. two sessions sharing one repository retain isolated instructions;
7. any reported status describes preparation or restoration attempts rather than model belief;
8. hook trust, restart, and source-update behavior are documented and tested;
9. every applicable command, schema, runtime, package, test, and documentation surface agrees; and
10. the full repository quality gate, build, packed-package verification, and disposable runtime
    shakedown pass.
