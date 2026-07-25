# Agent Conductor Pre-Beta Roadmap

**Date:** 2026-07-24

**Status:** Active execution roadmap

**Immediate release target:** Internal-cohort GitHub prerelease, provisionally `0.2.0-beta.0`

**Public release target:** npm beta after one to two weeks of cohort feedback

**Inputs:** The certified architecture, publishing, and extensibility recommendation; the
completed Codex instruction-transport spike; and the shipped PR Shepherd V2 integration

Related decision record:
[Agent Conductor Architecture, Publishing, and Extensibility Recommendation](architecture-publishing-extensibility-recommendation.md).

## The arc

Agent Conductor has reached the point where its core supervision, messaging, terminal, operator
channel, and PR Shepherd behavior is substantially implemented and hardened. The work before the
first public beta is no longer about proving the central idea. It is about turning the current
system into a clean public product:

1. Remove integration behavior that is surprising or invasive in a consumer repository.
2. Make the adapter seams genuinely usable by consumers rather than merely present internally.
3. Give a newly spawned agent enough version-matched guidance to onboard its operator.
4. Make installation, diagnosis, and first use predictable from a packed artifact hosted on a
   GitHub prerelease.
5. Freeze the cohort release surface, install the packed artifact as a consumer would, and share
   it only after every feature trunk is complete.

The roadmap deliberately front-loads feature and architecture work. Packaging and release are
the final trunk, not the forcing function for unfinished product decisions.

```text
Codex transport ─┐
                 ├─> public extension contract ─> onboarding + diagnostics ─> package hardening ─> beta
Protocol cleanup ┘
```

## Starting baseline

The roadmap starts from the current mainline behavior, including:

- Mechanical MCP identity and event-driven peer messaging.
- Claude Code and Codex runtimes.
- iTerm and tmux terminal backends.
- Console, Telegram, Slack, and injected operator channels.
- Spawn templates, worktrees, schedules, sentinel routing, and fleet-wide stall detection.
- Lazy, version-matched `get_conductor_docs` topics.
- PR Shepherd V2 scaffolding, managed lifecycle, health reporting, direct and merge-queue policy,
  singleton protection, and conservative onboarding defaults.
- Claude Code auto-memory disabled by default but overridable through
  `runtimes.claudeCode.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY`.

PR Shepherd is therefore a beta regression surface, not a new implementation trunk. Its existing
behavior remains in the release gate while the remaining public-product work proceeds.

## Execution rules

Each trunk is an independently reviewable feature increment. A trunk is complete only when:

1. Its implementation plan is reconciled against the current tree.
2. Core behavior, adapters, configuration, commands, help, prompts, tests, and documentation are
   updated wherever applicable.
3. The focused tests and the complete quality gate pass.
4. A user-facing changeset is present.
5. The packed or linked product is exercised through the real executable path when relevant.
6. The change is self-reviewed, committed, pushed, rebuilt, and linked locally before the next
   trunk begins.

No cohort prerelease is created while a feature trunk remains incomplete.

## Trunk 1 — Move Codex protocol injection out of consumer repositories

### Outcome

Codex sessions receive the mandatory Conductor protocol and session instructions from their
isolated, per-session Codex home. Conductor stops creating or editing instruction files in the
consumer repository, while existing fleets migrate without retaining stale protocol copies.

### Deliverables

- Generate a per-session `$CODEX_HOME/AGENTS.override.md`.
- Compose the file in this order:
  1. The operator's active global Codex guidance.
  2. The Conductor protocol.
  3. The session's `systemPromptFile`, when configured.
- Reproduce Codex's active global-source rule:
  - Use a non-empty shared `$CODEX_HOME/AGENTS.override.md` first.
  - Otherwise use a non-empty shared `$CODEX_HOME/AGENTS.md`.
  - Otherwise compose without an inherited global section.
- Add an explicit protocol sentence stating that Conductor fleet-communication mechanics take
  precedence over repository guidance.
- Stop generating repository-root `AGENTS.override.md` files and stop adding that filename to
  `.gitignore`.
- Add a one-release legacy cleanup pass.
- Protect the protocol and session prompt from the combined AGENTS byte limit.

### Implementation design

The generated home override is Conductor-owned and rewritten on every `prepare()`. It remains
session-specific, so two sessions sharing one repository cannot overwrite one another's
`systemPromptFile`.

The legacy cleanup must distinguish ownership:

- Delete an untracked repository-root override only when it bears the Conductor generated marker.
- For a tracked or user-authored override, remove only the marker-delimited Conductor section and
  preserve all surrounding content exactly.
- Leave unrelated and unmarked files untouched.
- Stop managing the `.gitignore` entry. Document that an obsolete ignore line can be removed
  manually.
- Retain the marker parsing helpers for the cleanup release; remove them in a later maintenance
  release after the migration window.

The composed home file places inherited user guidance first and Conductor guidance last. That
preserves the current user-then-Conductor ordering within the generated file. Repository and nested
AGENTS guidance will still be appended by Codex after the home file. This gives repository-root
guidance more positional recency than it has today, so the protocol's conflict-resolution sentence
must be specific to identity, message envelopes, signatures, sentinel authority, and Conductor tool
etiquette.

Codex applies a combined AGENTS size limit. The implementation must:

- Calculate the byte size of the generated home override before writing it.
- Raise `project_doc_max_bytes` in the generated per-session config copy to at least the composed
  home size plus a defined repository-document budget and headroom, while respecting any larger
  operator value.
- Use a TOML-aware generated-copy transformation rather than mutating the operator's shared config
  or performing an unchecked string replacement.
- Bound inherited global guidance so the Conductor protocol and session prompt are never the
  truncated portion. If inherited content must be shortened, add an explicit notice to the
  generated file and log an actionable warning.
- Warn when a detectable project-local config lowers the cap again.

### Acceptance gate

- Active global-source tests cover: non-empty override, only AGENTS, neither file, and empty
  override falling back to AGENTS.
- Composition tests prove user guidance precedes protocol and session instructions.
- Limit tests prove inherited content may be bounded but protocol and session instructions remain
  intact, and the generated config cap is raised.
- Cleanup tests cover generated-untracked deletion, tracked/user block stripping, non-marker
  preservation, and idempotent reruns.
- Two Codex sessions sharing a repository receive distinct session prompts without file races.
- A real Codex fixture proves that changing the home override reaches both interactive
  `codex resume` and non-interactive `codex exec resume`.
- Fresh start, ordinary resume, and compaction all retain the mandatory protocol.
- No new consumer-repository file or `.gitignore` mutation occurs.
- Codex adapter documentation explains global inheritance, ordering, migration behavior, and the
  remaining repository-position tradeoff.

## Trunk 2 — Make the public extension contract real

### Outcome

A consumer can implement and register an operator channel, terminal backend, or experimental
session runtime from an external package or embedding application without forking Agent Conductor
or submitting a pull request.

### Deliverables

- Add `runtimes?: SessionRuntime[]` to `SupervisorOptions`.
- Register injected runtimes before session references are validated.
- Merge injected runtimes over the built-in runtime map by name, enabling wrappers and decorated
  built-ins.
- Reject duplicate injected names with an actionable error.
- Widen the configured runtime field from the closed `claude-code | codex` enum to a trimmed,
  non-empty string.
- Validate configured runtime names against the final registered runtime map and report the
  available names.
- Preserve `cc` as a user-interface alias for the built-in `claude-code` runtime without treating
  aliases as registered runtime names.
- Export the supported contracts and concrete built-ins needed for composition.
- Define an explicit package `exports` map.
- Publish a complete external-adapter authoring guide and runnable embedding example.

### Implementation design

The stock built-ins stay in the core package for the beta. The extension mechanism is dependency
injection through `Supervisor`, not a second policy engine. Custom adapters receive the same
canonical operations, state, lifecycle, and capability-driven behavior as built-ins.

Runtime-name widening must be complete across:

- Supervisor and session configuration.
- Spawn templates and generated session files.
- Operator command parsing and help.
- MCP schemas and descriptions for spawn, start, and continue.
- Status and error rendering.
- Examples and lazy documentation.

Unknown runtime names should survive syntactic configuration parsing and fail at the registration
boundary, where the complete runtime map is available. That error must name the session or default
that selected the unknown runtime and list registered names.

Public exports should be divided intentionally:

- Stable beta root: `Supervisor`, `SupervisorOptions`, channel contracts and renderers,
  `TerminalBackend`, configuration types, and the supported PR Shepherd API.
- Experimental runtime surface: `SessionRuntime`, runtime capability types, and concrete
  Claude/Codex runtime implementations, clearly marked as subject to harness-driven change during
  the beta.
- Concrete tmux and iTerm backends should be exported when their constructors can be used without
  reaching through private modules.

The package export map must block accidental deep `dist/` imports while keeping every documented
entry point resolvable in both JavaScript and TypeScript.

The adapter guide should cover all three extension families:

- Operator channel: authentication, conversation identity, canonical handlers, semantic actions,
  request ownership, retry, shutdown, and secret handling.
- Terminal backend: pane identity, delivery capture, placement capabilities, status, and teardown.
- Session runtime: launch preparation, capability advertisement, input-state parsing, chrome
  stripping, lifecycle events, resume behavior, and provider-version testing.

The runnable example should live outside internal tests and import only documented package exports.
It should demonstrate a minimal embedding host, one injected adapter, configuration selection, and
clean shutdown.

### Acceptance gate

- A custom runtime can be selected by fleet default, session configuration, spawn, start, and
  continue.
- An injected runtime can deliberately decorate or replace a built-in by name.
- Duplicate injected names and unknown configured names produce deterministic, actionable errors.
- Existing Claude and Codex aliases and behavior remain unchanged.
- Existing injected channel and terminal-backend tests continue to pass.
- Contract tests exercise a fake external runtime through real `Supervisor` and `Lifecycle`
  construction.
- A temporary consumer project installs the packed tarball, compiles the embedding example, and
  runs it without importing `dist/*`.
- The guide states which interfaces are beta-stable and which are experimental.

## Trunk 3 — Tighten the mandatory protocol and documentation boundary

### Outcome

Every managed agent still receives the turn-zero behavioral contract, but routine tool mechanics
move out of the always-on prompt and into the MCP schemas and lazy handbook where they belong.

### Deliverables

- Reduce `prompts/conductor-protocol.md` to cross-cutting behavior that must be known before the
  first incoming message or tool choice.
- Keep envelope interpretation, mechanical identity, sentinel authority, event-driven peer
  communication, polling restrictions, automatic signatures, raw-pane-input safety, documentation
  discovery, and fleet-secret handling always on.
- Make MCP tool descriptions the canonical source for arguments, aliases, return semantics, and
  operation-specific mechanics.
- Keep task-shaped recipes and configuration walkthroughs in `get_conductor_docs`.
- Add a prompt-size regression assertion or budget.

### Implementation design

This is a content refactor, not a behavior reduction. Remove a tool-catalog entry from the
mandatory prompt only after the corresponding MCP schema and description fully explain its local
mechanics. Cross-tool rules remain in the protocol even when individual descriptions mention
them.

The protocol should name the behavioral categories rather than attempting to duplicate every
operation. The lazy handbook remains the version-matched long-form source, and the documentation
index continues to tell the agent which topics exist and which fleet paths are authoritative.

### Acceptance gate

- Tests prove every MCP operation has complete name, argument, and behavioral descriptions.
- Tests prove the protocol still contains every turn-zero invariant.
- Incoming peer, broadcast, sentinel, and remote-operator envelopes remain interpretable without
  first loading a tool.
- The protocol has a documented byte or token budget and is materially smaller than the current
  version.
- Claude and Codex receive semantically equivalent mandatory guidance.

## Trunk 4 — Deliver agent-led onboarding and actionable diagnostics

### Outcome

A new operator can run one command, start a first agent, paste one short prompt, and have that agent
conduct a safe, informed onboarding interview using the version-matched Conductor handbook.

### Deliverables

- Add `onboarding` to `CONDUCTOR_DOC_TOPICS` and `docs/agent-guide.md`.
- Add a `conductor doctor` command backed by reusable preflight checks.
- Run blocking preflight checks automatically from `conductor start`.
- Print a copyable first-agent onboarding prompt after initial scaffolding.
- Rewrite the README and getting-started path around the packed-package experience.
- Integrate PR Shepherd setup into the onboarding flow.
- Document the existing Claude Code auto-memory override alongside other runtime preferences.

### Onboarding interview

The onboarding topic should tell the agent to:

1. Call `get_conductor_docs` without a topic and use the returned authoritative fleet paths.
2. Ask what repositories and workflows the fleet will manage.
3. Confirm available Claude Code and Codex installations, the default runtime, model and effort
   preferences, permission-bypass posture, bare UI preference, and whether Claude Code native
   auto-memory should remain disabled.
4. Select and verify the terminal backend.
5. Decide where spawned repositories live and whether templates or Git worktrees are preferred.
6. Configure the initial hand-driven session before enabling automation.
7. Offer sentinel and fleet-watch setup.
8. Offer Telegram and Slack setup without exposing environment-file values.
9. Offer schedules only after the corresponding session has been exercised manually.
10. Offer PR Shepherd setup, elicit GitHub identity and repository policy, explain direct versus
    merge-queue flow, and keep execution disabled through shadow validation.
11. Validate configuration, run diagnostics, start one session, and summarize remaining optional
    features.

The agent should ask one decision at a time, explain the safe default, modify only approved files,
and finish with evidence rather than a generic success statement.

### Suggested first-agent prompt

`conductor start` should print this only when it creates the initial fleet scaffold:

> Help me onboard this Conductor fleet. First call `get_conductor_docs` without a topic, then read
> `onboarding` and `fleet-configuration`. Interview me one decision at a time, explain the safe
> defaults and tradeoffs, and make only changes I approve. Finish by validating the configuration
> and helping me run one hand-driven test session.

The quick start must also show the exact operator command for spawning that first agent and verify
that the command works from a fresh scaffold.

### Doctor and start preflight

`conductor doctor` should produce compact pass, warning, and failure rows with direct remediation.
Checks should include:

- Supported Node version.
- Fleet configuration parsing and resolved paths.
- Writable Conductor data and configuration directories.
- Configured runtime binaries on `PATH`.
- Selected terminal backend availability.
- tmux availability and usable version when selected.
- iTerm/AppleScript availability and automation-permission guidance when selected.
- `git` and `curl`.
- `gh` authentication and Shepherd profile validity when PR Shepherd is enabled.
- Fleet port availability or an already-running healthy Conductor.
- Stable executable-path requirements before daemon installation.

Checks must distinguish blockers from optional capability warnings. `conductor start` should run the
same reusable checks after copy-once scaffolding and before spawning its hidden child. It should not
reject a valid fleet merely because an unused optional adapter is unavailable.

### Acceptance gate

- Documentation-topic completeness tests include `onboarding`.
- A fresh fleet prints the onboarding prompt once; routine restarts stay quiet.
- The copyable spawn command and prompt create a working first-session flow.
- Doctor tests cover success and each blocker with platform-appropriate remediation.
- Start fails before creating an orphan child when a blocking preflight fails.
- The onboarding guide covers every current feature family without forcing optional setup.
- A Claude and a Codex agent can each follow the handbook to configure and validate a disposable
  fleet.
- PR Shepherd remains disabled until its identity marker is resolved and the operator explicitly
  enables it.

## Trunk 5 — Harden the package and GitHub prerelease machinery

### Outcome

The repository produces an installable beta tarball whose documented commands work from the packed
artifact, not only from a source checkout. The exact tarball is attached to a GitHub prerelease for
the internal cohort and remains suitable for later npm publication without rebuilding it through a
second packaging path.

### Internal-cohort installation

Keep the existing `agent-conductor` package identity during the internal cohort. Install the exact
GitHub release asset with npm:

```bash
npm install --global https://github.com/ianlancaster/agent-conductor/releases/download/v0.2.0-beta.0/agent-conductor-0.2.0-beta.0.tgz
```

This is a durable installation, exercises npm's real package installer, and requires no registry
publication. Release notes must show the matching uninstall and upgrade commands. Source checkout
remains a contributor workflow rather than the cohort onboarding path.

The GitHub prerelease is an externally visible action and remains separately authorized even after
the workflow and artifact are ready.

### Deliverables

- Preserve the `conductor` and `pr-shepherd` binaries.
- Replace source-checkout installation as the cohort README path; retain it under contributing.
- Align `conductor --version`, `pr-shepherd --version`, and MCP server metadata with the package
  version.
- Add and validate the package `exports` map from Trunk 2.
- Guard the Husky `prepare` path so consumer installs do not fail outside a contributor checkout.
- Reconcile `.nvmrc` with the supported engine policy. Prefer exercising the minimum supported
  Node version in the default contributor path, while retaining a current-Node CI lane.
- Add packed-artifact installation and executable smoke tests.
- Add a prerelease runbook and manually dispatched GitHub Release workflow.
- Generate and publish a SHA-256 checksum beside the tarball.

### Release workflow

The internal prerelease workflow should:

1. Run only from the protected release environment and an approved mainline commit.
2. Enter or verify Changesets prerelease mode for `beta`.
3. Materialize and review the version and changelog.
4. Run typecheck, lint, formatting, unit/integration tests, coverage, and real tmux E2E.
5. Run `npm pack` and inspect the allowlisted contents for secrets and local fleet artifacts.
6. Install the tarball into a temporary prefix or consumer fixture.
7. Smoke-test:
   - `conductor --version`
   - `conductor --help`
   - `conductor doctor`
   - a fresh `conductor start` scaffold
   - `pr-shepherd --version`
   - `pr-shepherd init`
8. Compile and run the external-adapter consumer fixture against the tarball.
9. Calculate the tarball checksum and attach both files to a GitHub prerelease for the exact tag and
   commit.
10. Install from the final GitHub asset URL and repeat the executable smoke test.

Creating or changing the GitHub prerelease remains a separately authorized external action even
after the workflow is ready.

### Acceptance gate

- The tarball includes every runtime-read prompt, guide, example, template, and environment
  template.
- The tarball excludes fleet data, credentials, logs, local profiles, test fixtures not intended
  for consumers, and source-only development artifacts.
- Both binaries report the same package version.
- A clean temporary machine/prefix can install and run the package without pnpm.
- The GitHub asset URL installs the same bytes that passed the packed-artifact tests.
- Daemon documentation uses the durable global installation path.
- The release contains a matching SHA-256 checksum and names the source commit.
- Release notes describe the cohort feedback window, beta stability policy, and experimental
  runtime-adapter surface.

## Trunk 6 — Cohort certification and feature freeze

### Outcome

The exact commit intended for the internal cohort is exercised as a consumer-visible release
candidate, with no remaining feature work hidden behind release tasks.

### Certification matrix

| Surface       | Required evidence                                                                       |
| ------------- | --------------------------------------------------------------------------------------- |
| Fresh install | GitHub tarball install, binary resolution, scaffold, doctor, first-agent prompt         |
| Claude Code   | Fresh start, continue, protocol, optional session prompt, env overrides, status         |
| Codex         | Fresh start, home override, interactive resume refresh, compaction, legacy cleanup      |
| Terminal      | Linux/tmux CI plus macOS/iTerm manual shakedown                                         |
| Messaging     | Direct, queued, cancelled, operator, broadcast, sentinel, and raw-pane safeguards       |
| Extensibility | External channel/backend/runtime consumer fixture using only public exports             |
| Onboarding    | Claude and Codex walkthroughs against disposable fleets                                 |
| PR Shepherd   | Managed start/stop, health, singleton behavior, direct flow, queue flow, shadow profile |
| Daemon        | Stable installed executable, restart, status, and clean uninstall                       |
| Package       | Allowlist, checksum, versions, README, changesets, license, no secrets                  |

### Freeze rules

- All pre-beta feature trunks are merged before the release candidate is cut.
- The release-candidate phase accepts only fixes, documentation corrections, and release
  automation changes.
- Any fix that changes user-visible behavior receives a changeset and reruns the affected
  certification rows plus the full gate.
- The final released artifact must be built from the exact reviewed and pushed commit.
- The locally linked Conductor is rebuilt from that same commit before the maintainer's final
  shakedown.

### Exit criteria

The internal GitHub beta is ready to share when:

- Trunks 1–5 are complete and pushed.
- The full certification matrix has evidence.
- No required check is skipped without a documented platform-specific manual result.
- Installation and onboarding work from the packed artifact.
- The public adapter example works outside the repository.
- The beta limitations and experimental surfaces are explicit.
- The operator authorizes creation of the GitHub prerelease.

## Deferred public npm release

After one to two weeks of internal-cohort use, incorporate reliability and onboarding feedback,
rerun the affected certification rows, and then complete the npm-only release work:

- Reserve and adopt the intended npm scope.
- Configure trusted publishing, provenance, public access, and the `beta` dist-tag.
- Add and verify the public `npx` trial path.
- Verify registry metadata, README rendering, executable selection, and provenance.
- Publish only the exact certified tarball bytes from an operator-authorized commit.

The cohort phase must not introduce a GitHub-specific package format or installer that will be
discarded for npm; GitHub hosts the ordinary `npm pack` artifact.

## Recommended execution order

1. **Codex home-override migration.** It removes consumer-repository side effects and stabilizes
   the instruction path used by onboarding.
2. **Consumer extension contract.** It fixes the public API before package exports and examples are
   frozen.
3. **Mandatory protocol cleanup.** It operates on the final instruction transport and public MCP
   descriptions.
4. **Onboarding and doctor.** They are written against the final configuration and extension
   surfaces.
5. **Package and GitHub release hardening.** Exports, install docs, packed tests, checksums, and the
   prerelease workflow become the last implementation trunk.
6. **Certification and internal-cohort release.** Feature freeze first; share only the exact
   certified artifact.

## Trunk-level completion ledger

This ledger is intentionally empty at roadmap creation. Each trunk should add its implementation
plan, changeset, commit, pushed ref, local-link verification, and certification evidence when it
closes.

| Trunk                          | Status                | Plan        | Changeset                 | Commit | Verification                                               |
| ------------------------------ | --------------------- | ----------- | ------------------------- | ------ | ---------------------------------------------------------- |
| 1. Codex instruction transport | Certification pending | Implemented | `calm-codex-homes`        | —      | Automated gate green; disposable live-Codex matrix pending |
| 2. Consumer extension contract | Certification pending | Implemented | `open-runtime-seams`      | —      | Automated contract green; packed consumer pending          |
| 3. Mandatory protocol boundary | Implemented           | Implemented | `lean-conductor-protocol` | —      | 3.2 KB; invariant and schema-description tests green       |
| 4. Onboarding and diagnostics  | Planned               | —           | —                         | —      | —                                                          |
| 5. Package and GitHub release  | Planned               | —           | —                         | —      | —                                                          |
| 6. Cohort certification        | Planned               | —           | —                         | —      | —                                                          |
