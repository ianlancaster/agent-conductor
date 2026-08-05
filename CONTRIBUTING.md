# Contributing to Agent Conductor

Thanks for helping improve Agent Conductor. The project is intentionally small: it provides
reliable lifecycle, messaging, observability, and stall-routing primitives for terminal agent
fleets without becoming a workflow engine or making LLM decisions itself.

Read this file and [CLAUDE.md](CLAUDE.md) completely before planning or changing code.
Despite its filename, `CLAUDE.md` is the canonical architecture guide for every human and
coding agent. This is mandatory context, not optional reference material.

## Project contract

Agent Conductor is an open-source product, not a repository for one person's fleet. A change
should make sense to a new user with a different directory layout, organization, runtime,
terminal, model, and operator channel.

- Keep features general and understandable. Do not commit private fleet configuration,
  organization-specific rules, local paths, credentials, or assumptions about one workflow.
- Prefer flexible primitives and safe defaults over hard-coded narrow behavior. Configuration
  should represent a real user choice, remain small and coherent, and be discoverable in the
  generated scaffold and docs. Avoid knobs that no implementation genuinely consumes.
- Keep shared policy in the core and provider-specific mechanics in adapters. Reuse the
  canonical operation, message, state, and rendering contracts instead of creating parallel
  implementations.
- Optimize for legibility. Names, types, errors, configuration, and control flow should reveal
  intent. Do not hide ordinary product behavior behind unnecessary indirection or obscure
  abstractions.
- Treat compatibility and recovery as product behavior. Existing fleets, persisted stores,
  queued messages, optional integrations, and long-running processes must fail safely and
  explain what an operator should do next.

Fleet-specific behavior belongs in `.conductor/config/`, environment variables, prompts,
templates, or an externally injected adapter. If a use case is too specific for the public
core, expose the reusable primitive that enables it rather than checking in the private policy.

### Feature bar: primitive-first, composable, and minimal

The maintainers should say no or defer when a request adds permanent surface area without
strengthening a broadly useful primitive. Configuration does not make a narrow feature
general; every option, command, state field, and abstraction carries ongoing compatibility,
documentation, and testing cost.

Data-safety, security, and correctness fixes clear this bar by default; cosmetic
conveniences do not, however configurable.

Decline a feature unless all five conditions hold:

1. solves a recurring product need rather than one fleet's workflow;
2. cannot already be composed from the existing operations and adapters;
3. belongs in Conductor's mechanical orchestration role rather than agent judgment or policy;
4. fits the narrowest existing seam without duplicating core behavior; and
5. is supported by concrete recurrence—multiple fleets or users, or a reproducible
   defect—rather than one hypothetical workflow.

Prefer improving an existing primitive over adding a parallel convenience. Defer speculative
extension points until there is a concrete second consumer. Reject workflow engines, hidden
policy, provider assumptions in the core, and cosmetic features whose complexity outweighs
their operational value.

## Development setup

Agent Conductor requires Node.js 22.13 or newer (23.4 or newer on the non-LTS Node 23 line) and pnpm.

```bash
git clone https://github.com/ianlancaster/agent-conductor.git
cd agent-conductor
pnpm install
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

Those four checks are the pre-commit quality gate and run in CI. The test suite includes a
real tmux E2E suite when tmux is installed.

### Source execution versus the linked CLI

`pnpm cli <arguments>` executes the TypeScript source through `tsx`. The global `conductor`
command executes compiled JavaScript from `dist/`. After pulling or changing source, rebuild
before testing the global command:

```bash
pnpm build
pnpm add --global .
conductor --help
```

The global link usually needs to be created only once per checkout, but running both commands
is the reliable refresh after a pull, a new checkout, or changes to package/bin metadata.
Rebuilding does not update a process that is already running; restart the intended fleet
explicitly when safe. Do not restart, stop, or repoint a contributor's live fleet as an
incidental test step.

Run fleet commands from the fleet directory or pass `-C /path/to/fleet`. Otherwise Conductor
will correctly target a different `.conductor/` directory. Keep development fixtures and test
fleets out of the repository unless they are intentionally generic and committed test data.

## Choosing the right extension point

- Add fleet behavior, validation, or authorization to `ConductorOperations`. Operator
  commands and session MCP tools are adapters over that canonical registry.
- Implement `ChannelAdapter` for an external operator transport such as Telegram or Slack.
- Implement `SessionRuntime` for an agent CLI.
- Implement `TerminalBackend` for a terminal emulator or multiplexer.
- Implement `ConductorEventSubscriber` when an embedding plugin needs to observe typed fleet facts
  without polling. It is not a control surface; actions still use canonical operations.
- Implement `ConductorIntegration` for deterministic background work plus protected, mechanically
  identified session delivery. Integrations own timers and durable cursors under their assigned
  state directory; they do not receive operator authority, raw terminal access, the Conductor
  store, or general operations. A host may inject the object directly, or a fleet owner may
  explicitly configure a trusted local synchronous factory file for the stock CLI.

The local console is a native `/cmd` and `/feed` client, not a `ChannelAdapter`. See the
extension taxonomy in [CLAUDE.md](CLAUDE.md#extension-taxonomy) before introducing a new
abstraction.

Keep transport-specific behavior behind its seam. Adapters may parse, authenticate, format,
retry, and translate service capabilities; they must not duplicate lifecycle, messaging,
state, or authorization policy from the core.

Background integrations are trusted in-process extensions, not sandboxed plugins. An
`integrations` entry in supervisor YAML is therefore an executable-code authority boundary:
validation may resolve/stat it but must never import it, and only foreground startup may execute
its pure synchronous factory. Keep the scaffold inert, reject discovery/package/URL loading,
never put secrets in opaque options, and require a restart for module changes. Direct
`new Supervisor(...)` construction remains injection-only. Keep deterministic provider policy in
the external package while using Conductor only for lifecycle, protected delivery, health, and
the durable namespace.

Outbound channel messages are semantic: `ChannelMessage.actions` carry display labels and
canonical operator commands. Adapters with native controls may render them as buttons;
text-only adapters should use `renderChannelMessage`. Never put transport-specific callback
payloads or core policy in the shared message contract.

Before adding a new abstraction, identify the second concrete consumer and explain why an
existing seam cannot own the behavior. Repeated code at a genuine provider boundary may be
clearer than a generic framework; repeated conductor policy is not.

## Making a change

Repository cleanliness is a hard precondition, not a cleanup step. Before starting any feature or
request, fetch `origin/main`, confirm the checkout is up to date with it, and require an empty `git
status --short`. If the branch or worktree is not ready, reconcile it before doing task work.
Identify and resolve unexpected changes; never discard another person's work without explicit
authorization.

1. Begin from the clean, current checkout established by the preflight above.
2. Read the implementation, tests, configuration, help, and docs at the relevant seam before
   proposing a new pattern.
3. State the general user need and choose the narrowest canonical extension point.
4. Add or update focused tests with the implementation, including failure and recovery paths.
5. Complete the applicable-surface audit below.
6. Run the full quality gate and review the final diff for unrelated or deployment-specific data.
7. Add a changeset with `pnpm changeset` for a user-facing change. Internal refactors and
   test-only or documentation-only changes generally do not need one.
8. When the maintainer or operator has authorized shipping directly from this checkout, commit the
   focused change, push it, then run `pnpm build && pnpm add --global .`. All three steps are required
   for every shipped feature. Do not restart a live fleet unless that disruption is explicitly in
   scope.
9. Fetch `origin/main` again and verify that the completed checkout is synchronized with it and
   `git status --short` is empty. Do not report the task complete with a dirty or stale worktree.

STOP MODIFYING WHAT THE STATUS COMMAND SHOWS UNLESS THE MAINTAINER OR OPERATOR EXPLICITLY ASKS FOR
A STATUS-OUTPUT CHANGE. Its content, wording, order, spacing, symbols, and colors are a deliberate
product contract and must not drift as a side effect of unrelated work.

Public package exports live in `src/index.ts`. Treat changes to exported interfaces,
configuration schemas, operation schemas, command syntax, persisted data, and generated
files as public compatibility decisions even before the first stable release.

## Applicable-surface audit

A functional change is finished only when every applicable way to configure, invoke,
understand, and recover it agrees. Review each of these explicitly:

| Surface                       | Typical locations and questions                                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical behavior            | Does `ConductorOperations` or the owning core module contain the shared policy and authorization?                                              |
| Session tools                 | Do MCP schemas, descriptions, typed errors, and `prompts/conductor-protocol.md` reflect the behavior?                                          |
| Operator controls             | Do `buildOperatorCommands`, aliases, validation, `/help`, the local console, and one-shot commands agree?                                      |
| Adapters                      | Do all bundled channels and the injected `ChannelAdapter` contract carry the same semantics where applicable? Are provider limits kept local?  |
| Event subscribers             | Are events emitted at owning core choke points, metadata-only, transition-based where needed, ordered, non-blocking, and failure-isolated?     |
| Runtime and terminal adapters | Does runtime/backend-specific detection or launch behavior live behind the correct interface, with capability differences explicit?            |
| Configuration                 | Are Zod schemas strict, defaults safe, scaffolded YAML complete, examples current, and secrets kept in environment mechanisms?                 |
| Persistence and lifecycle     | Is a migration append-only? Are restart, retry, deduplication, shutdown, and partial-failure behavior defined?                                 |
| Public package                | Are exports, optional dependency loading, packed files, and backwards compatibility correct?                                                   |
| Documentation                 | Are README reference sections, setup/troubleshooting guides, migrations, generated prompts, and manual shakedowns updated?                     |
| Managed-agent reference       | Does `docs/agent-guide.md` teach agents to discover, compose, configure, and troubleshoot the capability without bloating the injected prompt? |
| Verification                  | Do focused tests, surface-contract tests, integration tests, the full gauntlet, and any required manual checks prove the same contract?        |

Not every capability belongs in every audience or transport. An intentional exception is
acceptable; silent drift is not. Document important differences and pin them with tests.

Any feature that requires external setup, credentials, operating-system permissions, a
service manifest, migration, or non-obvious lifecycle must include a clear, copyable guide.
Guides should cover prerequisites, least-privilege setup, verification, limitations,
troubleshooting, and safe teardown without assuming access to the author's environment.

## Testing expectations

Use the narrowest test that proves the behavior, then add an integration test at the seam:

- Core orchestration: real core modules with the fakes in `test/fakes/`.
- Operator channels: pure parser/formatter tests, a scripted API double, and a
  `FakeChannel` supervisor pipeline test.
- Event subscribers: bus ordering/overflow/error-isolation tests plus a `FakeEventSubscriber`
  through a real `Supervisor` start/stop cycle.
- Session MCP: operation surface-contract tests plus real HTTP tests where transport behavior
  matters.
- Runtimes and terminals: interface-level tests; keep AppleScript and command construction
  behind pure helpers.
- Filesystem and git behavior: isolated temporary directories and real git repositories.
- End-to-end terminal behavior: the tmux E2E suite and, when needed, a manual shakedown under
  `test/manual/`.

Tests must not require real credentials, contact production services, or depend on a
developer's global runtime configuration.

Keep tests deterministic and isolated: use temporary directories, ephemeral ports, fake
clocks where appropriate, and unique tmux resources. If a real-service behavior cannot be
automated safely, isolate its logic behind a testable seam and add a manual shakedown under
`test/manual/`.

## Persistence and configuration

SQLite migrations in `src/store/index.ts` are append-only. Add a new `MIGRATIONS` entry;
never edit a migration that may already have run in a user's fleet.

All configuration is validated with strict Zod schemas. Unknown keys should remain errors,
and every optional setting needs a default or a clearly defined absence behavior. Secrets do
not belong in YAML, fixtures, logs, examples, or committed environment files.

Generated scaffold files are part of the user interface. A new fleet should receive a usable
configuration that states its effective defaults; do not hide important behavior exclusively
in code defaults or fully commented examples. Existing files must not be overwritten.

## Security and reliability

- Never accept a session's claimed identity in request arguments. Session identity comes
  from the conductor-controlled endpoint path.
- Authenticate or allowlist operator-channel callers using trusted transport metadata.
- Do not log tokens, credentials, or full sensitive payloads.
- Use argument arrays for subprocesses and the existing escaping helpers for shell or
  AppleScript content.
- Avoid synchronous subprocess work in request, delivery, and heartbeat paths.
- Make shutdown safe and repeatable; a failed update or network request must not terminate a
  long-running receive loop.

## Contributing runbooks

Runbooks are inert, versioned knowledge bundles—not executable plugins or product modes. Read
[Authoring and sharing runbooks](guides/runbooks.md) before adding one. A contributed bundle must:

- solve a reusable workflow problem using public Conductor primitives;
- begin with the smallest useful arrangement and state the cost and expected signal of optional
  stages;
- contain no private names, local paths, credentials, organization policy, model assumptions, or
  environment-specific claims;
- document prerequisites, operator decisions, verification, recovery, and safe teardown;
- use exact semantic versions and bump the version for every meaningful content change;
- include no scripts, lifecycle hooks, environment interpolation, dependency resolution, hidden
  config mutation, or implied authority; and
- pass `conductor runbook validate <path>` plus the registry, documentation, privacy, stale-name,
  packed-artifact, and onboarding tests applicable to a built-in bundle.

Community bundles do not need to live in this repository. A normal Git repository copied under a
fleet's `.conductor/runbooks/` directory or listed in `runbooks.paths` is the preferred first
distribution mechanism. `variantOf` and `delta` may document ancestry, but Conductor never fetches
or merges the parent. Published measurements must link their dataset and methodology, preserve
denominators, and identify their authoring context rather than presenting one fleet's result as a
universal product claim.

## Pull requests

Keep changes focused and explain both the user-visible outcome and the architectural seam
used. Call out migrations, public API changes, new dependencies, manual verification, and
known limitations explicitly. Confirm that no private configuration, secrets, local paths,
or organization-specific policy entered the diff.
