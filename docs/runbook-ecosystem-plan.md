# Runbook Ecosystem Plan

Status: proposal  
Audience: maintainers, runbook authors, and integration contributors  
Scope: a local-first, shareable runbook format and discovery system for Agent Conductor

## Summary

Agent Conductor should support user-authored and community-authored runbooks as discoverable,
versioned knowledge bundles. A runbook explains how an agent and operator can compose Conductor's
existing lifecycle, messaging, workspace, supervision, scheduling, adapter, and observability
primitives into a productive workflow.

Conductor should load and expose runbooks, but it should not execute them as workflow definitions.
An onboarding or coordinator agent reads a selected runbook, interviews the operator, obtains
approval, and applies it using the same public operations available everywhere else. This keeps
judgment and fleet policy in agent instructions while the Conductor core remains mechanical.

The recommended first release contains:

1. a strict `runbook.yaml` bundle format;
2. built-in, fleet-local, and explicitly configured local-path discovery;
3. dynamic runbook resources through `get_conductor_docs`;
4. mechanically authenticated, append-only runbook-adoption provenance;
5. a durable, content-free journal of the existing typed Conductor event vocabulary;
6. small `list`, `init`, and `validate` authoring commands plus stable event export;
7. the existing Engineering Management material converted into the lean-first reference bundle;
   and
8. documentation and contribution requirements for sharing runbooks and evaluation tooling
   through Git.

It deliberately does not introduce a workflow engine, executable hooks, a hosted marketplace,
dependency resolution, or automatic remote updates.

## Product fit

Runbooks clear the contributor feature bar when implemented as a knowledge and discovery primitive:

- Multiple fleets need reusable ways to describe productive arrangements of the same core
  primitives.
- The current static handbook can publish bundled examples, but it cannot discover fleet-owned or
  externally maintained examples.
- The capability belongs at the documentation and configuration boundary; orchestration judgment
  remains outside the core.
- It extends the existing version-matched documentation seam rather than creating a parallel tool
  or control plane.
- Git repositories provide an immediate, concrete distribution channel without requiring
  Conductor to become a package marketplace.

The implementation must preserve the distinction between a primitive and a workflow. Installing a
runbook makes knowledge available. It does not activate sessions, change configuration, execute
commands, or grant authority. An operator-authorized adoption record may label which runbook was
used for a period of work, but the record does not apply or enforce the runbook.

## Terminology

Use one first-class installable artifact:

- **Runbook:** a shareable bundle containing an overview, adoption paths, recipes, role prompts,
  configuration examples, verification, and recovery guidance.
- **Recipe:** a smaller technique or chapter within a runbook. Recipes do not have a separate
  package format or registry.
- **Resource:** one declared file in a runbook that Conductor may return through the documentation
  API.
- **Built-in runbook:** a bundle shipped in the Agent Conductor package.
- **Fleet runbook:** a bundle owned by one fleet under `.conductor/runbooks/`.
- **External runbook:** a local checkout explicitly registered by path in fleet configuration.

Runbooks are examples and adaptable operating knowledge, not product modes.

## Bundle layout

A conventional bundle looks like this:

```text
security-review/
├── runbook.yaml
├── README.md
├── topics/
│   ├── basic.md
│   └── autonomous.md
└── assets/
    ├── roles/
    │   ├── coordinator.md
    │   └── reviewer.md
    └── sessions/
        └── reviewer.yaml
```

Only files declared in `runbook.yaml` are available through `get_conductor_docs`. Undeclared files
may support a human-facing repository but are not part of the Conductor resource contract.

### Manifest proposal

```yaml
schemaVersion: 1
id: example/security-review
name: Security Review Fleet
version: 1.0.0
summary: Coordinate implementation and independent security review.
license: MIT
repository: https://github.com/example/conductor-security-runbook

variantOf:
  id: agent-conductor/engineering-management
  version: 1.2.0
delta: >-
  Review rounds are capped at one fresh review plus one gate. Mutation-on-diff
  and claims verification replace later mechanical review rounds.

requires:
  conductor: '>=0.1.0'

topics:
  - id: overview
    title: Security Review Fleet
    summary: Roles, prerequisites, and adoption choices.
    path: README.md

  - id: basic
    title: Basic review lane
    summary: Add an independent reviewer to a hand-driven workflow.
    path: topics/basic.md

resources:
  - id: reviewer-role
    title: Reviewer role prompt
    mediaType: text/markdown
    path: assets/roles/reviewer.md

  - id: reviewer-session
    title: Reviewer session example
    mediaType: application/yaml
    path: assets/sessions/reviewer.yaml
```

Initial schema rules:

- `schemaVersion`, `id`, `name`, `version`, `summary`, and at least one topic are required.
- `id` is stable and namespaced, using an owner/name form such as
  `agent-conductor/engineering-management`.
- Topic and resource IDs are unique within the bundle and use a conservative identifier grammar.
- Every path is relative to the bundle root and must resolve inside that root.
- Topic files are Markdown. Resources may initially be Markdown, YAML, JSON, or plain text.
- Unknown manifest fields fail validation so misspelled policy is never silently ignored.
- A bundle may describe optional stages or tiers as topics; stages are not a core execution concept.
- `variantOf`, when present, contains a well-formed runbook ID and an exact semantic version. It is
  documentation-only: Conductor never fetches, resolves, validates the presence of, or merges the
  named parent.
- `delta` is required when `variantOf` is present, must be nonempty, and has a conservative length
  cap. It declares the author's intended difference but does not prove that only one experimental
  factor changed.
- The manifest cannot declare executable hooks, install scripts, secrets, environment interpolation,
  or dependencies on other runbooks.

Compatibility should use an ordinary semantic-version range. The loader reports an incompatible
bundle but does not reinterpret or partially apply it.

## Discovery model

The registry combines three sources:

1. **Built-in:** package-owned bundles under `runbooks/`.
2. **Fleet-local:** bundles discovered under `<fleet>/.conductor/runbooks/`.
3. **Explicit local paths:** additional bundle directories configured by the operator.

Example optional configuration:

```yaml
runbooks:
  paths:
    - ../shared-conductor-runbooks/security-review
    - /opt/team-runbooks/release-coordination
```

No configuration is needed for built-in or fleet-local bundles. The default is discovery only;
there is no `enabled` setting because runbooks do nothing until selected and followed.

Registry behavior:

- Use the namespaced manifest ID as identity; directory names are not authoritative.
- Refuse duplicate IDs rather than silently shadowing a built-in or another local bundle.
- Return source provenance (`built-in`, `fleet`, or `external`) and the resolved bundle path in
  operator diagnostics. Managed-agent responses should expose only paths already appropriate for
  the active fleet and must never expose secrets.
- Re-read the registry when the documentation catalog is requested so local authoring changes do
  not require a Conductor restart.
- Isolate optional failures: an invalid runbook is excluded with a clear warning and appears in
  validation output, but it does not take the lifecycle and messaging control plane offline.
- `conductor validate` fails when configured or fleet-local runbooks are invalid, duplicated, or
  incompatible, giving the operator a deterministic preflight.

The modern fleet layout gains a derived `runbooksDir` at `.conductor/runbooks`. Legacy fleets may
use `<fleet>/runbooks` consistently with their existing root-level layout. The directory does not
need to be created until a user authors or installs a fleet runbook.

## Documentation API integration

The current documentation registry statically enumerates every topic in
`src/core/documentation.ts` and asserts that the package contains exactly that list. That contract
should remain for core handbook topics but no longer contain individual runbook topics.

Refactor the documentation layer into:

- a static, exhaustively tested core-topic registry;
- a dynamic runbook catalog supplied by the runbook registry; and
- a resource resolver that can read only manifest-declared files.

Calling `get_conductor_docs` without a topic should return core topics plus a compact runbook
catalog:

```json
{
  "topics": [],
  "runbooks": [
    {
      "id": "example/security-review",
      "name": "Security Review Fleet",
      "version": "1.0.0",
      "summary": "Coordinate implementation and independent security review.",
      "source": "fleet",
      "topics": [
        {
          "id": "overview",
          "title": "Security Review Fleet",
          "summary": "Roles, prerequisites, and adoption choices."
        }
      ]
    }
  ]
}
```

Runbook resources use collision-free documentation keys:

```text
runbook:example/security-review/overview
runbook:example/security-review/resource/reviewer-role
```

The `get_conductor_docs.topic` input can no longer be a compile-time enum containing every valid
value. Its description should tell the agent to call the tool without a topic for the live catalog;
the handler performs strict runtime validation and returns the available resource keys on error.
Core topic constants remain exported internally for completeness tests.

The response for a runbook resource should identify its bundle, version, source, media type, and
content. It should not inject the entire manifest or other topics into context.

No new MCP tool is needed. The existing lazy documentation primitive already has the right
audience and context behavior.

## Adoption provenance

Discovery says which runbooks are available. Adoption provenance records which runbook an operator
approved for a specific period and scope of work. It makes the runbook ID, version, and selected
topic usable as an experimental condition without turning the runbook into executable policy.

Adoption records are append-only domain events:

- `runbook.adopted` begins an adoption;
- `runbook.superseded` links an active adoption to its replacement; and
- `runbook.adoption.ended` closes an adoption without a replacement.

Every adoption receives a stable `adoptionId`. Records contain only mechanical metadata:

```json
{
  "type": "runbook.adopted",
  "adoptionId": "b1c88d64-9e3f-4c60-9db5-3de7d28487a0",
  "runbookId": "agent-conductor/engineering-management",
  "version": "1.2.0",
  "source": "built-in",
  "topic": "tier-2",
  "approvedBy": "operator",
  "sessions": [
    { "codename": "implementation-lane", "role": "implementer" },
    { "codename": "review-lane", "role": "reviewer" }
  ]
}
```

The normal Conductor event envelope supplies timestamp, fleet ID, process instance ID, event ID,
and sequence. Session roles are labels scoped to this adoption, not a new lifecycle policy or a
claim that Conductor can infer an agent's behavior.

`approvedBy: operator` must be mechanically truthful. A session cannot write an operator-approved
adoption record or pass an `approvedBy` field. Adoption is recorded through one canonical
operator-only operation exposed consistently as an operator command, including through authenticated
Slack and Telegram command routing. The onboarding agent prepares the exact command after the
operator approves the proposed scope; the operator executes it. A future general approval primitive
may streamline this, but runbook adoption must not invent a private authorization path.

The minimal command shape is:

```text
/runbook adopt <id> --version <version> --topic <topic> [session-role assignments]
/runbook supersede <adoption-id> --with <id> --version <version> --topic <topic>
/runbook end <adoption-id>
```

Exact argument syntax should be settled with the canonical operation design. The important
contract is one implementation of authorization, validation, persistence, and event emission
shared by every operator transport.

## Durable event journal and telemetry boundary

The exported `ConductorEventSubscriber` seam is live, ordered, metadata-only, best-effort, and at
most once. That remains the correct contract for plugins. It is not sufficient as an experimental
ledger because slow subscribers can overflow, shutdown does not flush their queues, and process
restarts begin a new sequence domain.

Add a first-party durable journal for the same canonical `ConductorEvent` union:

```text
owning core module
        │
        ▼
typed ConductorEvent
        │
        ├── durable local event journal
        └── live best-effort subscribers
```

The journal must not introduce a second event vocabulary. It should persist the fully enveloped
event synchronously to an append-only SQLite table before scheduling live subscriber delivery. The
table is internal storage; a stable JSONL export is the public analysis contract. Journal failures
must never be silent: record a degraded telemetry status in memory, emit a prominent diagnostic,
and make status and doctor report that experimental integrity is compromised. A telemetry write
failure must not take lifecycle or messaging offline.

Because the journal is local, content-free, and low volume, it should be enabled by default with an
explicit fleet opt-out. This prevents measurement from depending on someone remembering to enable
it after work begins. The data remains under the fleet's ignored data directory and is never sent
off-machine by Conductor.

The first durable vocabulary should extend the events already emitted by core choke points rather
than renaming them:

- existing session registration, start, readiness, stop, and activity transitions;
- existing stall, fleet-stall, schedule, and operator-request outcomes;
- `runbook.adopted`, `runbook.superseded`, and `runbook.adoption.ended`;
- `message.created`, `message.delivered`, and `message.cancelled`, containing sender, recipient,
  receipt ID, UTF-8 byte count, timestamps, and mechanically derived delivery latency, never message
  content;
- workspace provisioning and teardown facts for Conductor-created empty directories, Git templates,
  and worktrees, using neutral workspace terminology rather than assuming every session is a lane;
  and
- turn-completion metrics only when supplied authoritatively by the runtime adapter.

Lifecycle events may add the configured model and effort used for the launch. Field names must make
clear that these are Conductor launch settings, not proof that a user did not switch models inside
the runtime afterward.

Turn metrics require capability-aware optional fields. Claude Code and Codex expose different data,
and the contract must never synthesize parity by scraping unstable terminal text. Token input/output,
cache counts, runtime-reported duration, and context utilization may be recorded when a supported
adapter supplies them with a declared source. Conductor should not calculate dollar cost; an
evaluator applies a versioned price table to tokens and runtime/model metadata.

Conductor must not claim facts it cannot mechanically observe:

- `lane.dispatched`, `lane.ready`, review rounds, review findings, escapes, defects, and rework are
  workflow or evaluation semantics;
- local or remote merges may happen outside Conductor; Git history and PR Shepherd are the
  appropriate sources; and
- message text and pane captures must not be classified to infer experiment outcomes.

Evaluators join durable adoption intervals and session-role assignments to event timestamps. The
stable `adoptionId` removes ambiguity when a fleet runs multiple arms or adopts the same bundle more
than once.

## Onboarding behavior

The first-session prompt should remain stable and generic. It should direct the onboarding agent to
offer the live runbook catalog after one hand-driven session succeeds. The onboarding handbook
should require the agent to:

1. present exact installed runbook names, summaries, versions, and provenance;
2. explain that runbooks are examples rather than modes;
3. ask which runbook and adoption topic the operator wants;
4. load only the selected overview and necessary resources;
5. interview for runbook-specific decisions rather than inventing identity or policy;
6. obtain approval before changing fleet files or creating sessions;
7. validate and exercise the arrangement manually;
8. prepare the operator-only adoption command with the exact runbook version, topic, and
   session-role assignments;
9. confirm that the operator-created adoption record exists before calling the work a measured
   runbook adoption; and
10. report what remains optional or disabled.

The user-facing request is conversational:

> Adopt `example/security-review`, starting with its basic review lane. Interview me for its
> required decisions and make only the changes I approve.

There should be no `/apply-runbook` command. Applying a runbook is agent work performed through the
canonical operations and ordinary file edits. The operator-only adoption command records
provenance; it does not apply the runbook or authorize later actions described by it.

## Cognitive-agent awakening

The reference Engineering Management runbook should add an optional cognitive-agent bootstrap
recipe because its persistent EM and Stall Sentinel roles are a concrete consumer of the default
`agent` workspace template.

That recipe should cover:

1. asking whether persistent roles should use plain repositories or the registered `agent`
   template;
2. gathering separate operator-approved role briefs for the EM and Sentinel;
3. spawning each role in its own workspace;
4. invoking `/awaken` for Claude Code or `$awaken` for Codex;
5. supplying the approved answers as a transparent delegated bootstrap, never claiming the
   onboarding agent is the human operator;
6. using raw pane interaction only in a newly created, operator-approved pane where no draft can be
   clobbered;
7. verifying that template markers are removed, identity files are populated, and the awakening
   commit exists; and
8. testing messaging and lifecycle behavior before enabling auto mode or fleet watch.

The role brief should record mission, scope, priorities, decision boundaries, escalation policy,
communication style, peer relationships, and optional Water Cooler participation. The onboarding
agent may fill repetitive questions from the approved brief but must not fabricate personal or
organizational preferences.

## Authoring tools

Add one narrow CLI family for content authors:

```bash
conductor runbook list
conductor runbook init ./my-runbook
conductor runbook validate ./my-runbook
```

- `list` prints the same resolved catalog and invalid-bundle diagnostics used by
  `get_conductor_docs`.
- `init` writes a minimal generic manifest and overview without overwriting an existing directory.
- `validate` applies the exact production schema, compatibility, containment, and resource checks.

These commands manage inert documentation and therefore do not need MCP or operator-console
equivalents. They must use the same registry and validation code as the supervisor rather than
reimplementing manifest rules.

Do not add remote `install`, `update`, or `remove` commands in the first release. Users can share a
bundle repository through an ordinary Git clone, submodule, subtree, or copied directory, then
place it under `.conductor/runbooks/` or register its checkout in `runbooks.paths`. This makes
source and version control explicit and avoids prematurely building a package manager.

## Evaluation tooling

Evaluation remains external to Conductor. A tool such as `conductor-eval` can combine:

1. the stable content-free event export;
2. runbook adoption intervals and role assignments;
3. Git history and diff statistics;
4. CI, mutation-test, property-test, and claims-verifier results; and
5. defect or escape labels from the operator's chosen tracking system.

Conductor should provide a read-only export command backed by the durable journal:

```bash
conductor events export --format jsonl
conductor events export --format jsonl --since 2026-07-26T00:00:00Z
```

The JSONL schema is versioned independently from internal SQLite migrations. Export order is stable,
every row retains its event envelope, and malformed or unknown future event types must remain
round-trippable. The command should support writing to stdout so evaluators do not need direct
access to Conductor's private database schema.

Runbooks may include inert topics describing preregistered metrics, required instrumentation,
analysis commands, interpretation, and missing-data rules. Executable evaluators distribute through
ordinary Git or package channels and never run merely because a runbook mentions them.

Collection alone does not solve the motivating failure mode. Experimental runbooks should say how
report generation is triggered automatically—such as CI, an external plugin, or a deliberately
configured schedule—so computing results does not remain a person's later task. Conductor records
mechanical facts; the evaluator owns metric definitions, price tables, joins to external systems,
and generated reports.

## Distribution and community contribution

### External sharing

A runbook author can publish the bundle as a normal Git repository. Recommended repository
metadata:

- a name containing `conductor-runbook`;
- a clear license;
- tagged releases matching the manifest version;
- supported Conductor version range;
- screenshots or diagrams only as supplemental explanation;
- no secrets, private fleet identifiers, or unredacted transcripts; and
- CI running the public runbook validator.

A central marketplace is not required initially. A curated documentation page may link to known
community runbooks while making clear that they are third-party, untrusted prompt content.

### Built-in contributions

The repository should accept a built-in runbook only when it:

- serves a general workflow used across multiple fleets or users;
- composes public primitives instead of requesting special core behavior;
- defines prerequisites, operator decisions, incremental adoption, verification, rollback, and
  safe teardown;
- explains runtime and terminal differences where they matter;
- includes generic role and configuration examples;
- contains no private paths, names, credentials, or organization-specific policy;
- passes the same bundle validator used for external runbooks; and
- includes focused documentation and catalog tests.

Community runbooks that are useful but too specialized for the product should remain externally
hosted rather than weakening the built-in contribution bar.

## Security model

Runbooks are untrusted instructions. Conductor must enforce these boundaries:

- Never execute a runbook file or repository script.
- Never interpolate environment variables or credentials into runbook content.
- Never automatically mutate supervisor or session configuration.
- Never automatically start, stop, spawn, or tear down a session because a bundle was discovered.
- Never allow a session caller to manufacture an operator-approved adoption record.
- Reject absolute resource paths, `..` traversal, symlink escape, duplicate IDs, unsupported media
  types, and files outside configured size/count limits.
- Report source and version so an operator can assess provenance.
- Require explicit operator approval for an agent to apply configuration or perform destructive,
  credentialed, or externally visible steps described by a runbook.
- Treat Markdown instructions from a third-party bundle as untrusted prompt content subordinate to
  the injected Conductor protocol and repository instructions.
- Keep the durable event journal content-free: no prompts, message bodies, pane captures,
  transcripts, credentials, local paths, arbitrary runtime reason text, or source code.
- Store telemetry locally by default and never transmit it without a separately installed and
  configured adapter or evaluator.

If remote installation is added later, it must clone without running repository scripts or
submodules, support immutable commit pinning, record the resolved revision, and define safe update
and removal semantics before shipping.

## Reference-runbook migration

Move the existing Engineering Management documents into a bundled structure such as:

```text
runbooks/
└── agent-conductor/
    └── engineering-management/
        ├── runbook.yaml
        ├── README.md
        ├── topics/
        │   ├── tier-1.md
        │   ├── tier-2.md
        │   ├── tier-3.md
        │   ├── tier-4.md
        │   ├── practices.md
        │   └── cognitive-agent-bootstrap.md
        └── assets/
            ├── roles/
            └── sessions/
```

Preserve the existing `runbook-engineering-management-*` documentation keys as compatibility
aliases for at least the beta compatibility window. The aliases resolve to the corresponding
manifest resources and are not duplicated copies. New documentation and catalog output should use
the canonical namespaced keys.

This migrated bundle becomes the golden fixture for authoring, validation, lazy loading, package
verification, and onboarding tests.

The reference doctrine must be lean-first:

- Tier 1 is the default baseline and the first recommended adoption.
- Higher tiers are optional controls with explicit additional round-trips, coordination costs, and
  conditions that justify them; they are not presented as maturity levels every fleet should reach.
- Tier 4 should be described as the most elaborate included pattern, not the “full” or ideal system.
- Every added review stage should define an expected signal, an exit criterion, and an automation
  alternative where one exists.
- Evidence topics may publish measured costs and finding yields only with a linked dataset,
  methodology, denominators, and clear authoring-fleet provenance.
- Fleet-specific results remain external variant evidence until they are reproducible enough to
  support a built-in claim.

The reference bundle should demonstrate `variantOf` with a fixture variant, but it must not elevate
one fleet's uncited measurements into universal product guidance.

## Implementation sequence

### Phase 1: format and registry

1. Add strict manifest and resolved-runbook types.
2. Add contained resource resolution and safety limits.
3. Add built-in, fleet-local, and configured-path discovery.
4. Extend fleet paths and supervisor configuration with the default directory and optional paths.
5. Add validation errors and optional-runtime warning behavior.

### Phase 2: knowledge integration

1. Separate static core topics from dynamic runbook resources.
2. Extend the documentation catalog response with runbook metadata.
3. Support canonical namespaced resource keys.
4. Preserve existing Engineering Management topic aliases.
5. Update `get_conductor_docs` schema and error messages for dynamic keys.

### Phase 3: adoption provenance and durable events

1. Extend the canonical event union with runbook-adoption, content-free message lifecycle, and
   mechanically known workspace events.
2. Add an append-only SQLite event journal before live subscriber fanout.
3. Surface journal degradation through logs, status, and doctor without taking the control plane
   offline.
4. Add the operator-only adoption, supersede, and end operation plus consistent command routing.
5. Join stable adoption IDs to session-role assignments without creating a runtime role policy.
6. Add capability-aware optional turn metrics where runtime evidence is authoritative.
7. Add a stable JSONL event export that hides the private database schema.

### Phase 4: reference migration and onboarding

1. Convert Engineering Management into the reference bundle.
2. Make Tier 1 the lean baseline and document the incremental cost and evidence standard for every
   higher tier.
3. Add the cognitive-agent awakening recipe.
4. Update the onboarding topic to present the live catalog, adoption choices, and exact
   operator-only provenance command.
5. Update README and getting-started examples with user-facing request language.
6. Keep the initial hand-driven shakedown mandatory before optional runbook adoption.

### Phase 5: author and evaluator experience

1. Add `conductor runbook list`.
2. Add non-overwriting `conductor runbook init`.
3. Add `conductor runbook validate` using production validation code.
4. Add `conductor events export --format jsonl` against the durable journal.
5. Publish authoring, experiment-instrumentation, and contribution guidance.
6. Include a minimal standalone bundle and external evaluator fixture in package verification.

### Deferred phases

Only after external usage demonstrates the need, evaluate:

- Git URL add/update/remove commands;
- immutable installation records or a lock file;
- a curated or hosted registry;
- signatures or publisher verification;
- dependency relationships between bundles; and
- richer search or tag filtering.

Each deferred feature must independently clear the contributor feature bar.

## Verification plan

### Schema and security

- Accept a minimal valid manifest and the reference bundle.
- Reject unknown fields, duplicate IDs, invalid versions, missing resources, traversal, symlink
  escape, unsupported media types, excessive resource size/count, and incompatible versions.
- Accept a valid structured `variantOf` plus bounded `delta`; reject ranges, malformed IDs, missing
  deltas, and oversized deltas without resolving the parent.
- Confirm no bundle scripts or package lifecycle hooks execute during discovery or validation.

### Registry

- Discover built-in, fleet-local, and configured-path bundles deterministically.
- Refuse duplicate IDs without shadowing.
- Re-read changed local bundles without restarting.
- Exclude invalid optional bundles while retaining a usable supervisor and actionable diagnostics.
- Make `conductor validate` fail on the same invalid bundle.

### Documentation API

- Preserve the exact static core-topic completeness test.
- Return a compact dynamic catalog with provenance and versions.
- Load one declared resource without leaking adjacent resources or undeclared files.
- Reject unknown keys with the current catalog.
- Prove existing Engineering Management aliases resolve to canonical resources.
- Verify the MCP surface accepts dynamic topic strings.

### Onboarding

- Confirm a fresh onboarding agent discovers installed runbooks only after calling the catalog.
- Confirm it offers exact names and adoption topics after the manual shakedown.
- Exercise one approval-controlled reference-runbook setup with both Claude Code and Codex.
- Confirm a session cannot write `approvedBy: operator` and every operator transport reaches the
  same adoption operation.
- Confirm adopted, superseded, and ended records preserve stable IDs, version, provenance, topic,
  and session-role assignments.
- Manually test delegated cognitive-agent awakening without operator-draft clobbering.

### Durable events and evaluation

- Persist every canonical event before scheduling live subscriber delivery while retaining
  subscriber ordering, overflow, and failure isolation.
- Verify restart boundaries, event sequence continuity within an instance, and append-only adoption
  history across instances.
- Prove message events contain byte counts, receipt IDs, and latency but no message content.
- Prove journal payloads exclude prompts, pane captures, transcripts, paths, credentials, runtime
  reason text, and source code.
- Exercise journal write failure: lifecycle and messaging remain online while status and doctor
  report degraded telemetry integrity.
- Verify optional runtime metrics are omitted rather than guessed when a runtime lacks evidence.
- Export stable JSONL in deterministic order and consume it from an external evaluator fixture
  without importing private store types or reading SQLite directly.
- Verify an evaluator can join two simultaneous adoption scopes by `adoptionId` and session-role
  assignment.

### Package and contribution

- Ensure built-in manifests and resources are included in the packed artifact.
- Compile and run the validator from a packed GitHub-installed package.
- Run link, terminology, privacy, and stale-operation-name checks across built-in bundles.
- Compile and run the event exporter and evaluator fixture from the packed artifact.
- Add the runbook surface to beta onboarding certification.

The normal lint, typecheck, formatting, full test, terminal E2E, build, and package verification
gauntlet remains required.

## Completion criteria

The first release is complete when:

1. a user can author and validate a bundle without changing Conductor source;
2. a fleet can discover a local or explicitly registered bundle without a restart;
3. `get_conductor_docs` lists and lazily loads its declared resources;
4. the onboarding agent presents it by name and can adopt it through existing operations with
   operator approval;
5. the operator can write append-only adopted, superseded, and ended provenance without allowing a
   session to impersonate operator approval;
6. the durable journal records the canonical content-free event stream by default and exposes
   failures rather than silently corrupting an experiment;
7. an external evaluator can consume stable JSONL without reading the private SQLite schema;
8. unsupported workflow facts and unavailable runtime metrics are omitted rather than inferred;
9. the Engineering Management runbook ships in the new format with compatibility aliases and Tier
   1 as its lean baseline;
10. the cognitive-agent bootstrap recipe covers creation, delegated awakening, verification, and
    safe activation of EM and Sentinel roles;
11. malformed or malicious bundle paths cannot escape the bundle or take down the core control
    plane;
12. package verification proves built-in author, external author, and evaluator workflows from the
    packed artifact; and
13. no new workflow execution engine, hidden policy, or parallel control surface has been created.

## Decision record

The recommended initial decisions are:

- **Bundle, not workflow engine.** Runbooks contain inert knowledge and examples.
- **One artifact type.** Recipes are runbook content, not independently installed packages.
- **Local-first discovery.** Built-in, fleet-local, and explicit local paths ship first.
- **Git for distribution.** Conductor does not initially build a remote package manager.
- **One knowledge API.** Extend `get_conductor_docs`; do not add a runbook-specific MCP tool.
- **Dynamic catalog.** Core topics stay static; runbook resources are discovered at runtime.
- **Namespaced identity.** Duplicate IDs fail rather than shadowing.
- **Documented variants.** `variantOf` and `delta` declare ancestry without resolution or
  inheritance.
- **Agent-mediated, operator-recorded adoption.** No `apply` command and no automatic configuration
  changes; only an operator audience can create an operator-approved provenance record.
- **One event vocabulary.** The durable journal and live subscribers consume the same typed domain
  events rather than drifting into separate schemas.
- **Local durable telemetry by default.** Content-free events are journaled locally with an explicit
  opt-out and a stable JSONL export; Conductor never uploads them.
- **Mechanical facts only.** Conductor does not infer lane readiness, review findings, defects,
  merges, or cost from text and terminal output.
- **Optional failure isolation.** Broken runbook content does not take messaging or lifecycle
  offline, while validation still fails clearly; degraded telemetry is prominent but does not take
  the control plane down.
- **Lean reference migration.** Engineering Management proves the format, retains beta aliases,
  starts at Tier 1, and labels heavier tiers with costs and evidence requirements.

These decisions provide a useful ecosystem seam now while leaving installation convenience,
marketplace discovery, and stronger publisher trust to evidence-driven later work.
