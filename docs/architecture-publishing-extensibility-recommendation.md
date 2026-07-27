# Agent Conductor Architecture, Publishing, and Extensibility Recommendation

**Date:** 2026-07-24  
**Status:** Certified recommendation  
**Primary:** Agent Conductor maintainer (`agent-conductor`)  
**Peer reviewer:** `ac-fable-reviewer`  
**Review method:** Independent repository and provider-documentation research, followed by
adversarial peer review and a final addendum incorporating independently verified findings.

## Executive decision

Agent Conductor should:

1. Keep its hybrid instruction architecture: dynamic runtime wiring, a small mandatory
   turn-zero protocol, optional skills/plugins, and lazy version-matched documentation.
2. Slim the mandatory protocol, but never replace it with MCP descriptions, skills, or plugins.
3. Move Codex protocol delivery from the repository root to a generated per-session
   `$CODEX_HOME/AGENTS.override.md` before beta; do not use `developer_instructions` for the full
   protocol.
4. Publish the first public beta under a scoped npm name as `0.2.0-beta.0` with the `beta`
   dist-tag.
5. Use global npm installation as the durable installation path and npx as a zero-install trial
   path.
6. Add a guided onboarding documentation topic and a copyable first-agent prompt.
7. Keep the built-in adapters in the core package for the beta.
8. Describe the current extension surface honestly: operator channels and terminal backends are
   injectable, while session runtimes and stock-CLI plugin registration are not yet open extension
   points.

No broad rewrite is warranted. The existing primitives and adapter boundaries are sound; the
remaining work is primarily prompt-layer refinement, packaging, onboarding, and public-contract
clarification.

## 1. Instruction architecture

### Recommended layers

| Layer               | Responsibility                                                                   | Delivery                                                  |
| ------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Runtime wiring      | Mechanical identity, per-session MCP endpoint, lifecycle hooks, runtime settings | `SessionRuntime` implementation                           |
| Mandatory bootstrap | Turn-zero interaction rules and cross-tool safety invariants                     | Claude system-prompt append; Codex always-on instructions |
| Optional workflows  | Onboarding, PR Shepherd setup, adapter authoring, troubleshooting routines       | Skills/plugins when useful                                |
| Detailed knowledge  | Version-matched configuration, recipes, paths, and reference material            | Lazy `get_conductor_docs` topics                          |

This reflects the division recommended by both provider ecosystems:

- Claude Code distinguishes always-on instructions, on-demand skills, MCP connections, hooks, and
  plugin distribution.
- Codex distinguishes durable AGENTS guidance, progressive-disclosure skills, MCP capabilities, and
  plugin distribution.

The current implementation already has the essential shape:

- Claude uses `--append-system-prompt-file` for the Conductor protocol and optional per-session
  instructions (`src/runtimes/claude-code/index.ts`).
- Codex writes a marker-managed `AGENTS.override.md` inside each session's isolated `CODEX_HOME`,
  leaving the repository root untouched (`src/runtimes/codex/index.ts` and
  `src/runtimes/codex/config-gen.ts`).
- `get_conductor_docs` lazily serves topics from the documentation shipped with the running package
  (`src/core/documentation.ts`).

### Why MCP alone is insufficient

MCP tool descriptions explain capabilities and arguments, but they cannot supply the complete
interaction protocol.

Three independent gaps are decisive:

1. **Incoming-message interpretation:** `[Message from ...]`, `[Broadcast from ...]`, and
   `[Sentinel]` arrive as pane text. A tool description cannot tell an agent how to interpret text
   it received before selecting a tool.
2. **Deferred tool discovery:** a runtime may not load an MCP tool schema until it decides the tool
   is relevant. Norms such as “do not poll a peer” must be available before the agent considers
   polling or terminal inspection.
3. **Cross-tool semantics:** event-driven turn ending, automatic signatures, non-impersonation,
   receipt handling, and operator-channel reply behavior govern the interaction model rather than
   one individual tool.

The Conductor must therefore retain a mandatory turn-zero instruction layer.

### Why skills and plugins cannot replace the bootstrap

Skills are pull-based. They load after explicit invocation or implicit matching. The Conductor
protocol is push-based: it must govern the first incoming message and the first tool decision.

Plugins improve distribution but do not change skill activation semantics. They can also be absent,
disabled, stale, or outside the scope owned by a particular Conductor installation.

Skills and plugins are still useful for task-shaped workflows, including:

- First-fleet onboarding.
- PR Shepherd configuration elicitation.
- Adapter authoring and validation.
- Troubleshooting and release procedures.

Those workflows should remain additive. `get_conductor_docs` stays the runtime-neutral source of
truth.

### Slim the mandatory protocol

The current `prompts/conductor-protocol.md` spends substantial always-on context repeating the MCP
tool catalog. The protocol should retain:

- Envelope interpretation and mechanical identity.
- Event-driven peer communication.
- Restrictions on polling and routine terminal tailing.
- Sentinel and remote-operator behavior.
- Message receipt and raw-pane-input safety.
- Documentation discovery and fleet-secret handling.
- Automatic signatures and non-impersonation.

Ordinary tool mechanics should live in canonical MCP operation descriptions. Detailed procedures
should live in lazy documentation or optional skills.

The goal is a smaller bootstrap without moving any turn-zero behavioral invariant out of it.

### Codex transport recommendation

The current `AGENTS.override.md` implementation is functional but invasive:

- It creates or edits a file in the consumer's repository.
- It manages a `.gitignore` entry.
- It must preserve tracked overrides and re-embed the repository's `AGENTS.md`.
- The per-session `CODEX_HOME` copies shared configuration and links authentication, but does not
  inherit the operator's global AGENTS guidance. Managed Codex sessions therefore silently lose
  durable personal instructions.

The completed compatibility and precedence spike found that `developer_instructions` is not a safe
transport for the full mandatory protocol:

- A trusted repository's `.codex/config.toml` scalar-replaces a value written into the
  per-session home.
- A CLI `-c` override wins but scalar-replaces both user and project developer instructions.
- A resumed thread retains the developer instructions from thread creation; changed config and
  CLI values do not reach the ordinary resumed turn.
- Compaction eventually rehydrates the current value, but that is not an acceptable update
  mechanism for mandatory protocol changes.

Instead, generate `$CODEX_HOME/AGENTS.override.md` for each managed session. Compose the operator's
active global guidance first, the Conductor protocol second, and `systemPromptFile` last. This
preserves turn-zero delivery, refreshes on resume, restores global guidance and native project
instruction discovery, and prevents two sessions in one repository from racing over a shared
override file.

Durable session instructions strengthen that transport without changing the repository boundary.
On every start or continue, Conductor validates at most 5 KiB of UTF-8 session instructions and
atomically prepares private protocol and session snapshots in the session's generated config
directory. Claude Code launches from those snapshots and relies on its supported compaction reuse
of system-prompt layers. Codex uses the same exact prepared layers at launch and restores them once
through its compact-only `SessionStart` hook. Source edits do not hot-rewrite a live process; they
activate only on a deliberate start or continue. The compact hook produces local context without
terminal input and independently of the best-effort Conductor lifecycle relay.

The migration requires a one-release cleanup pass for existing repository overrides, an explicit
fleet-protocol precedence statement, and a byte-limit guard that can bound inherited global
guidance but never truncate the Conductor protocol or session prompt. The detailed implementation
and acceptance conditions live in the [pre-beta roadmap](pre-beta-roadmap.md).

`developer_instructions` may be reconsidered later only for a small immutable kernel after
project-config composition, resume versioning, content partitioning, and restart-on-kernel-change
are designed. `model_instructions_file` remains unsuitable because it replaces built-in
instructions.

### Optional provider plugins

Claude's `--plugin-dir` can load a Conductor-owned, package-shipped plugin without user-scope
installation. That makes it a promising future delivery channel for optional Claude skills and
operator conveniences while retaining version matching.

This does not change the mandatory-bootstrap decision. Codex and Claude skills remain pull-based,
and `get_conductor_docs` remains the common cross-runtime source.

## 2. Beta publishing and onboarding

### Package audit

The package is mechanically close to publishable.

`npm pack --dry-run` succeeded with:

- Approximately 311 KB compressed.
- Approximately 1.306 MB unpacked.
- 259 files.
- Compiled binaries, prompts, examples, documentation, and scaffold assets included.
- No fleet environment file or obvious secret included.

The remaining blockers are product identity, first-run experience, public API boundaries, and the
release process.

### Scoped npm identity is mandatory

The unscoped npm name `agent-conductor` is already owned by an unrelated maintainer and currently
serves a different `agent-conductor@0.3.0` package. This repository must not publish under that name,
and documentation should warn users to install the exact scoped package to reduce typo risk.

Preferred name:

```text
@agent-conductor/conductor
```

Fallback:

```text
@ianlancaster/agent-conductor
```

The scope must be chosen and reserved before editing installation documentation.

`@agent-conductor/conductor` has the cleanest executable inference because its unscoped portion,
`conductor`, already matches the existing `conductor` bin. If the fallback
`@ianlancaster/agent-conductor` is chosen, add an `agent-conductor` bin alias pointing to the main
CLI so npm can select an executable when the package exposes both `conductor` and `pr-shepherd`.

### Durable installation versus npx

The canonical durable installation should be:

```bash
npm install --global @agent-conductor/conductor@beta
conductor start
```

The zero-install trial should be:

```bash
npx --yes @agent-conductor/conductor@beta start
```

npx installs into npm's cache and temporarily adds package executables to `PATH`; it does not
create a durable global link. It is appropriate for an interactive trial. It should not be the
documented path for `conductor daemon install`, because a daemon must reference a stable executable.

Do not add a self-installing create wrapper or a postinstall script that attempts to install the
package globally. `conductor start` already owns copy-once fleet scaffolding.

### Beta version and release security

The pending changesets produce a minor release from the current `0.1.0`. The first public build
should therefore be:

```text
0.2.0-beta.0
```

Publish it with the `beta` dist-tag so the project does not implicitly promise stability through
`latest`.

Use npm trusted publishing from an approval-protected GitHub Actions environment. OIDC avoids a
long-lived publish token and provides provenance for a public package built from the public
repository.

The release workflow or manual runbook must cover:

1. Enter Changesets prerelease mode.
2. Materialize and review the release version/changelog.
3. Run the complete quality gate.
4. Run `npm pack` and install the tarball into a temporary prefix.
5. Smoke-test `conductor` and `pr-shepherd`.
6. Publish with the `beta` tag.
7. Verify the registry metadata, provenance, executable selection, and README.

### Beta-readiness blockers

Before publishing:

1. Choose and reserve the scoped npm identity.
2. Rewrite README installation and quick-start material with npm-first instructions.
3. Remove `pnpm` from consumer prerequisites; retain it for source contributors.
4. Add `conductor doctor` or equivalent `conductor start` preflight checks for:
   - Supported Node version.
   - At least one configured agent runtime on `PATH`.
   - `tmux` or supported iTerm environment.
   - `curl`.
   - Optional `gh` when PR Shepherd is enabled.
5. Add an onboarding documentation topic.
6. Print a copyable first-agent prompt after initial scaffolding.
7. Add an explicit package `exports` map so deep `dist/` imports do not accidentally become public
   API.
8. Add packed-artifact installation and binary smoke tests.
9. Make `pr-shepherd --version` report the package version rather than a hardcoded internal V2
   label.
10. Document and automate the prerelease publishing process.

### Agent-led onboarding

Add `onboarding` as a new lazy topic in `docs/agent-guide.md` and
`CONDUCTOR_DOC_TOPICS`.

The topic should guide the agent through:

- Confirming authoritative fleet paths from `get_conductor_docs`.
- Fleet goals and managed repositories.
- Claude Code versus Codex defaults.
- Model, effort, and permission-bypass posture.
- Terminal backend and interactive versus daemon operation.
- Spawn locations, templates, and worktree use.
- Hand-driven versus automatic sessions.
- Sentinel configuration.
- Telegram or Slack.
- Optional schedules.
- Optional PR Shepherd setup.
- Configuration validation and a one-session shakedown before automation.

Recommended copyable prompt:

> Help me onboard this Conductor fleet. First call `get_conductor_docs` without a topic, then read
> `onboarding` and `fleet-configuration`. Interview me one decision at a time, explain the safe
> defaults and tradeoffs, and make only changes I approve. Finish by validating the configuration
> and helping me run one hand-driven test session.

## 3. Consumer adapter extensibility

### Current state

The extension architecture is partially open:

- A consumer can implement `ChannelAdapter` and inject it through
  `SupervisorOptions.channels`.
- A consumer can inject a `TerminalBackend`.
- A consumer can inject observation-only `ConductorEventSubscriber` instances for typed fleet
  facts without polling or terminal tailing.
- The public entry point exports the channel contracts and built-in Slack and Telegram adapters.
- External adapters require the consumer to construct `Supervisor` in a small embedding host.

The following are not currently supported:

- Loading a third-party adapter from stock `conductor` CLI configuration.
- Registering a custom `SessionRuntime` through `SupervisorOptions`.
- Naming a third-party runtime in configuration; the runtime schema is the closed enum
  `claude-code | codex`.
- Discovering or loading arbitrary extension modules from `supervisor.yaml`.

The documentation and root exports currently make `SessionRuntime` appear more open than the
product actually is.

### Keep built-ins in core for the beta

Do not split Slack, Telegram, Claude Code, Codex, iTerm, or tmux into independently versioned
packages yet.

Reasons:

- No demonstrated consumer requires an independent release cycle.
- Runtime parsing is coupled to provider terminal behavior that changes across releases.
- Separate packages would create a compatibility matrix before the public contract is mature.
- The current in-core adapters are already thin translations around shared Conductor primitives.

The adapter design is sound. Packaging and registration are the incomplete parts.

### Public contract for the beta

The beta should explicitly support:

- `Supervisor`.
- `SupervisorOptions`.
- `ChannelAdapter` and its related channel types.
- `TerminalBackend` where embedding requires it.
- `ConductorEvent`, `ConductorEventSubscriber`, and the event vocabulary constant.
- Canonical rendering helpers intentionally exported from the package root.

Add a package `exports` map and document which exports are stable during the beta.

For `SessionRuntime`, choose one honest position before publication:

1. Mark it experimental and move it to an experimental subpath; or
2. Open registration deliberately by adding `runtimes?: SessionRuntime[]`, validating runtime
   selection against the registered map, and widening the closed configuration enum.

The second option should not be treated as a trivial type change. It expands the public
compatibility contract and should be implemented only with an external-runtime example and
contract tests.

### External channel documentation

Provide a complete external channel example that demonstrates:

- Authenticated conversation identity.
- `ChannelHandlers` routing.
- Semantic action rendering.
- Retry, request-bound, and shutdown behavior.
- Secret handling outside committed YAML.
- Pure parser/renderer tests.
- A scripted service double.
- A real `Supervisor` integration test.
- A minimal JavaScript embedding host.

This enables third-party adapters without a fork or pull request, while being explicit that the
consumer runs an embedding host rather than the stock CLI.

### Do not add arbitrary config module loading

Do not add `import(path)` or package-name execution directly from `supervisor.yaml` during the beta.
The supervisor process holds fleet environment values and controls agent processes. Treating an
editable configuration field as arbitrary code execution is a trust-boundary change.

If demand later justifies a plugin loader, design it separately with:

- Explicit trust and allowlisting.
- A versioned extension manifest.
- API-version negotiation.
- Controlled module resolution.
- Failure isolation.
- Clear secret exposure rules.
- An adversarial security review.

## 4. Prioritized work

### Beta blockers

1. Migrate Codex protocol delivery into the per-session home and clean up legacy repository
   overrides.
2. Open and document the consumer runtime-registration contract.
3. Deduplicate the mandatory prompt against canonical MCP descriptions.
4. Add the onboarding topic, first-agent prompt, and runtime/terminal diagnostics.
5. Choose and reserve the scoped package name.
6. Rewrite npm-first installation and quick-start documentation.
7. Add a beta publishing runbook/workflow and prerelease mode.
8. Bound the public package surface with `exports` and packed-artifact smoke tests.
9. Align binary version reporting.

The detailed order, implementation requirements, and release gates are maintained in the
[pre-beta roadmap](pre-beta-roadmap.md).

### Post-beta refinements

1. Consider a minimal immutable Codex developer-instruction kernel only after its five design
   conditions are satisfied.
2. Experiment with package-shipped Claude skills through `--plugin-dir` when a concrete workflow
   benefits.
3. Continue release and compatibility automation based on beta feedback.

## 5. Explicitly rejected directions

This recommendation rejects:

- MCP-tool-descriptions-only operation.
- Replacing turn-zero instructions with pull-based skills.
- Requiring a plugin installation for managed-session correctness.
- Using Codex `model_instructions_file`, which replaces built-in instructions.
- A self-installing npx/create wrapper.
- Publishing under the occupied unscoped `agent-conductor` name.
- Splitting built-in adapters into packages before the extension contract matures.
- Arbitrary dynamic module loading from fleet YAML.

## 6. Certification record

The maintainer independently inspected:

- Runtime prompt and configuration generation.
- MCP operation descriptions.
- Lazy documentation routing.
- Public package exports.
- Supervisor adapter construction and injection.
- Strict configuration schemas.
- npm package contents and executable metadata.
- Registry package-name availability.
- Changesets and CI/release state.
- Current official Claude Code, Codex, and npm documentation.

`ac-fable-reviewer` performed an adversarial repository review and delivered:

- An independent architecture assessment.
- A challenge of MCP-only and skills-only approaches.
- A beta-blocker and onboarding analysis.
- An adapter extensibility audit.
- An addendum incorporating the npm-name collision, Codex `developer_instructions`, Claude
  `--plugin-dir`, global AGENTS inheritance, and the verified adapter limitations.
- A multi-stage adversarial Codex transport review incorporating live start, resume, compaction,
  project-config precedence, and home-AGENTS refresh evidence.

The final recommendations above incorporate that review and supersede the reviewer's initial
unscoped npm/npx suggestion.

## Official external references

- [Claude Code extension overview](https://code.claude.com/docs/en/features-overview)
- [Claude Code memory and instruction behavior](https://code.claude.com/docs/en/memory)
- [Claude Code plugins](https://code.claude.com/docs/en/plugins)
- [Claude Code plugin reference](https://code.claude.com/docs/en/plugins-reference)
- [Codex custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Codex and ChatGPT skills](https://learn.chatgpt.com/docs/build-skills)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [OpenAI plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [npm exec and npx behavior](https://docs.npmjs.com/cli/v11/commands/npm-exec/)
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm publishing](https://docs.npmjs.com/cli/publish/)
