# Agent Conductor

Agent Conductor is a terminal-based control plane for highly productive, autonomous
fleet-based coding sessions. It runs several Claude Code and OpenAI Codex agents as a
coordinated fleet: spawning them into real terminal panes, managing persistent sessions,
creating isolated worktree or template workers, and giving every agent a consistent way
to communicate with its peers and the human operator.

The practical benefit is simple: you can delegate parallel work without becoming the
message bus, terminal babysitter, and process manager yourself. Agents keep their own
runtime and conversation history, while Conductor supplies the shared mechanics they
need—identity, lifecycle, messaging, status, and optional stall supervision.

Conductor is deliberately not a workflow engine or an LLM-powered orchestrator. Its
primitives are small, inspectable, and composable. You decide how the fleet works; the
agents remain visible in ordinary iTerm2 or tmux panes.

> **Project status:** Agent Conductor is in an internal GitHub-distributed beta and is
> not yet published to npm. Interfaces may change before the first stable release.

## Quick start

You need:

- Node.js 22.13 or newer (or Node 23.4 or newer on the non-LTS Node 23 line)
- Claude Code (`claude`) and/or OpenAI Codex (`codex`)
- SPARTAN (`spartan`) plus Codex when using the optional SPARTAN runtime
- iTerm2 on macOS, or tmux on macOS/Linux
- `curl`

Install the GitHub beta globally with npm:

```bash
npm install --global https://github.com/ianlancaster/agent-conductor/releases/download/v0.2.0-beta.0/agent-conductor-0.2.0-beta.0.tgz
```

Or with pnpm:

```bash
pnpm add --global https://github.com/ianlancaster/agent-conductor/releases/download/v0.2.0-beta.0/agent-conductor-0.2.0-beta.0.tgz
```

Create a fleet directory and start Conductor:

```bash
mkdir -p ~/my-fleet
cd ~/my-fleet
conductor start
```

The first start creates a complete `.conductor/` configuration and opens the operator
console. At the `conductor>` prompt, spawn a Claude Code onboarding assistant:

```text
/spawn onboarding-helper
```

To use Codex instead:

```text
/spawn onboarding-helper -r codex
```

To use the Codex-compatible SPARTAN launcher instead:

```text
/spawn onboarding-helper -r spartan
```

Conductor opens the assistant in a new pane. Move to that pane and paste this prompt
directly into the assistant:

```text
Help me onboard this Conductor fleet. First call get_conductor_docs without a topic, then read onboarding and fleet-configuration. Interview me one decision at a time, explain the safe defaults and tradeoffs, and make only changes I approve. Finish by validating the configuration and helping me run one hand-driven test session. After that succeeds, offer the runbook catalog without configuring a runbook unless I choose one. If I choose a bootstrap recipe, offer to create and drive its awakening flows from briefs I approve, pausing whenever an answer is not explicit.
```

The assistant can discover the version-matched handbook and the active fleet's real
configuration paths. It will guide you through a minimal manual session before offering
automation, remote channels, or other optional features.

Run `conductor doctor` whenever you want an actionable environment and configuration
check. The console opened by `conductor start` owns its Conductor process, so `Ctrl+C`
stops it. Use `conductor console` only when you intentionally want an additional,
non-owning console. If a crashed or forcibly closed owning console leaves its process behind,
run `conductor kill` from the fleet directory; it stops only that fleet's recorded Conductor and
leaves all session panes running.

For the full walkthrough, including what the generated files mean, continue with
[Getting Started](docs/getting-started.md).

## Why use it?

- **Run mixed fleets.** Claude Code, Codex, and the Codex-compatible SPARTAN launcher share one runtime-neutral control plane
  while retaining their native terminals, settings, and conversation histories.
- **Delegate in parallel.** Spawn persistent agents, disposable workers, Git worktrees,
  or registered repository templates without hand-building every terminal session.
- **Coordinate directly.** Agents send signed messages through mechanically assigned
  identities instead of scraping one another's terminals or relying on a shared chat.
- **Federate local fleets when needed.** Opt-in same-machine federation exposes a chosen
  roster and routes the existing agent tools between otherwise independent Conductors.
- **Keep work observable.** The operator console, live status view, pane output, receipts,
  and logs expose what the fleet is doing and whether communication was delivered.
- **Add supervision only when useful.** Auto mode, a designated stall sentinel, fleet
  watch, schedules, and remote operator channels are optional layers over the same core
  primitives.

## Work with the fleet

The operator console uses a small command language. Run `/help` for the complete,
version-matched reference; these are the commands used most often:

| Task                                      | Command                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| Inspect the fleet or one session          | `/status` · `/status <session>`                                           |
| Create or restore a session               | `/spawn <name> [-r claude-code\|codex\|spartan] [-s <id>] [--path <dir>]` |
| Start, resume, or stop it                 | `/start <session>` · `/continue <session> [-s <id>]` · `/stop <session>`  |
| Send a message                            | `/tell <session> <message>` · `/broadcast <message>`                      |
| Hold a group conversation                 | `/room create <name> <session...>` · `/room say <name> <msg>`             |
| Make free text target one session         | `/talk <session>`                                                         |
| Inspect recent terminal output            | `/tail <session> [lines]`                                                 |
| Set or clear a concise status tag         | `/tag <session> [text]`                                                   |
| Temporarily suspend or restore automation | `/pause <session>` · `/resume <session>`                                  |
| Record an approved runbook condition      | `/runbook adopt <id> --version <v> --topic <topic>`                       |
| Remove a spawned session                  | `/teardown <session> [--delete]`                                          |

A typical hand-driven session looks like this:

```text
/spawn api-helper -r codex --path /absolute/path/to/project
/tell api-helper inspect the API layer and propose the smallest safe refactor
/status api-helper
/tail api-helper 40
/stop api-helper
/continue api-helper
```

`/spawn` registers the session and starts a fresh conversation by default. `-r` selects a runtime;
if omitted, the fleet default is used. Pass `-s <id>` or `--session-id <id>` to materialize the
workspace and resume that exact native conversation on the first launch. The same flags on
`/continue` select a specific conversation for an existing registration instead of that runtime's
most recent conversation. Explicit IDs are opaque, runtime-specific values. A respawn must reuse
the original codename and runtime; `continue all` cannot accept one.

When several sessions need one conversation rather than a mesh of direct messages, convene a
room. Everything said in a room reaches every member, so replies land in front of the whole
group:

```text
/room create design-review implementer reviewer
/room join design-review
/room say design-review settle the API boundary before implementation starts
/room list design-review
/room close design-review
```

`/room join` with no session name puts the operator in the room, so room traffic reaches the
console and any connected channel. Rooms broadcast to members that are running and skip members
that are stopped rather than starting them, and membership changes are informational — agents are
instructed to treat them as a no-op. Rooms span federated fleets; see
[Local federation](guides/federation.md).

When `spartan` and `codex` are installed, `/spawn api-helper -r spartan` launches the same
managed Codex experience through SPARTAN. Conductor preserves its isolated `CODEX_HOME`, native
Codex options, model and effort controls, continuation history, hooks, and readiness detection.
SPARTAN-specific support runs behind the wrapper; configure Codex behavior under `runtimes.codex`
and only the launcher path under `runtimes.spartan.binary`.

Messages sent with `/tell` or the agent-facing `send_to_session` operation are signed with
mechanical sender identity and return observable delivery receipts. `/type` is intentionally
different: it writes raw terminal input for prompts and slash commands, bypasses the
protected delivery queue, and can overwrite operator typing. Use it only for deliberate
terminal control.

## Status and observability

There are three complementary status surfaces:

- `/status` is the canonical fleet snapshot inside any operator interface.
- `conductor status [session]` is a persistent, read-only terminal panel. It redraws one
  canonical status frame every 15 seconds, reports whether Conductor is online, and
  reconnects across restarts. Press `q` to leave it; use `--once` for one snapshot or
  `--interval <duration>` to change the refresh cadence.
- `conductor statusline` is a one-time, optional setup command for richer footers inside
  Claude Code and Codex panes. It does not display fleet status.

The Claude Code status line shows model, context used, cost, project, worktree, Git branch,
and staged/modified counts. Codex uses its native status-line fields for model and reasoning,
context used, tokens used, project, and Git branch. Restart an existing agent process after
running `conductor statusline` so it receives the new runtime settings.

For diagnosis, `conductor logs [session]` reads recent persisted health events,
`conductor validate` checks strict fleet configuration, and `/tail` reads pane output.
Managed agents can use `list_sessions` and `get_session_status` for structured,
non-invasive status without scraping peers' terminals.
Status reconciliation uses each runtime's own activity parser to repair missed lifecycle hooks in
both directions. It is deliberately separate from protected-delivery input detection: Claude Code
and Codex can expose a composer while a turn is still running, so active-turn evidence wins over
composer visibility. An inconclusive capture preserves the previous state rather than guessing.
Before routing a completed turn as idle, Conductor also uses the runtime input parser to suppress
the stall when a human has text waiting in the composer.
Session tags are deliberately concise: `/tag` and `set_tag` reject labels longer than 50
Unicode characters by default without changing the existing tag. Fleets can change the
mechanical limit with `supervisor.maxTagLength`; supervisor settings apply after restart.

## Run autonomous sessions

Autonomy is composed from three small controls:

1. A **sentinel** is a normal Claude Code or Codex session configured with the shipped
   [sentinel instructions](prompts/sentinel.md).
2. `/auto <session>` toggles stall routing for one worker. Auto off is the normal
   hand-driven state; auto on routes that worker's stalls to the sentinel.
3. `/fleet-watch` toggles fleet-wide darkness detection. It watches every registered session
   except the sentinel and follows roster and activity changes automatically. Stopped sessions
   count as non-working rather than disappearing from the fleet.

The guided onboarding assistant can configure the sentinel safely. The underlying session
configuration is intentionally ordinary:

```yaml
# .conductor/config/sessions/watch.yaml
codename: watch
repo: /absolute/path/to/a/sentinel-workspace
runtime: claude-code
systemPromptFile: ./.conductor/prompts/sentinel.md
```

Copy [prompts/sentinel.md](prompts/sentinel.md) into `.conductor/prompts/sentinel.md`, or
have the onboarding assistant do it using the authoritative fleet paths. Session files
hot-reload. `systemPromptFile` is a private, per-session instruction layer (maximum 5 KiB
UTF-8): Conductor validates and snapshots it on each start or continue, applies it after the
mandatory protocol, and retains it across Claude Code and Codex compaction without typing into
the pane or modifying the repository. Source edits take effect on the next start or continue.
Then start and designate the sentinel before enabling autonomous workers:

```text
/start watch
/sentinel watch
/spawn implementer --path /absolute/path/to/implementation-workspace
/spawn reviewer -r codex --path /absolute/path/to/review-workspace
/auto implementer
/auto reviewer
/fleet-watch
/tell implementer implement the agreed change and coordinate review when ready
/tell reviewer review the implementation when the implementer contacts you
```

Auto and fleet watch are independent. Auto routes an individual session's stalls. Fleet
watch alerts when no registered non-sentinel session is working for the configured
confirmation interval—15 seconds by default. A one-session fleet is valid; an empty fleet
does not alert.
Both settings survive Conductor restarts. `/pause` suppresses automated messages to the target
from schedules, stall routing, background integrations, and PR Shepherd without changing its
saved auto setting or blocking human messages; `/resume` restores that automation.

### What the stall sentinel does

Conductor mechanically identifies evidence such as an ended turn that stayed quiet, a
permission/input block, context compaction, or—in runtimes without authoritative completion
events—a silent unchanged pane. It does not decide
whether that state is actually a problem and it never calls an LLM itself.

For compaction, Conductor waits for the runtime's compact-complete event and confirms that a
composer is actually visible before routing the stall. It never types a generic `continue` into
the worker. The sentinel decides whether the compacted session should resume and can supply the
fleet-specific reorientation prompt when it should.

The sentinel receives a self-contained `[Stall]` or `[Fleet Stall]` message and decides what
to do. Each alert includes the ISO-8601 UTC time Conductor classified the stall; recent direct-message
facts use the same timestamp format so the sentinel can compare communication to the stall boundary.
It can inspect structured status or recent pane output, send one precise nudge, ask the operator
through `send_to_operator`, or deliberately do nothing when the agent really finished.
Fleet-specific rules—what is safe to retry, what requires approval, and when to escalate—belong in
the sentinel's instructions rather than in Conductor core. If no sentinel is configured, Conductor
sends stall alerts directly to the operator.

## Is Agent Conductor the right tool?

Several good tools cover adjacent parts of multi-agent development. Choose based on the
problem you most need to solve. This compact view compares built-in product capabilities:

✅ built in · 🟡 partial, adjacent, or plugin-based · ❌ not a primary capability

| Tool                                                                                                                        | Terminal fleet | Claude + Codex | Peer messaging | Stall response | Remote operator |
| --------------------------------------------------------------------------------------------------------------------------- | :------------: | :------------: | :------------: | :------------: | :-------------: |
| **Agent Conductor**                                                                                                         |       ✅       |       ✅       |       ✅       |       ✅       |       ✅        |
| [Herdr](https://herdr.dev/)                                                                                                 |       ✅       |       ✅       |       🟡       |       🟡       |       🟡        |
| [Gas Town](https://github.com/steveyegge/gastown)                                                                           |       ✅       |       ✅       |       ✅       |       ✅       |       ❌        |
| [amux](https://github.com/mixpeek/amux)                                                                                     |       ✅       |       ✅       |       ✅       |       ✅       |       ✅        |
| Native Claude Code or Codex teams                                                                                           |       🟡       |       ❌       |       🟡       |       ❌       |       🟡        |
| [claude-squad](https://github.com/smtg-ai/claude-squad) / [Conductor](https://www.conductor.build/)                         |       ✅       |       ✅       |       ❌       |       ❌       |       ❌        |
| [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) / [Agent-MCP](https://github.com/rinadelph/Agent-MCP) |       ❌       |       ✅       |       ✅       |       ❌       |       🟡        |
| [Happy](https://github.com/slopus/happy) / [Omnara](https://github.com/omnara-ai/omnara)                                    |       ❌       |       ✅       |       ❌       |       ❌       |       ✅        |

Capability checks do not capture each product's philosophy: for example, Gas Town provides a
more prescribed operating model, while Herdr goes deeper on terminal persistence. See
[Choosing an agent fleet tool](docs/alternatives.md) for the maintained detailed matrix,
workflow tradeoffs, and source links.

## Feature map

| Capability          | What it provides                                                                          | Learn more                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Session lifecycle   | Spawn, start, continue, stop, pause, resume, and tear down agents                         | [Lifecycle and status](docs/agent-guide.md#session-lifecycle-placement-models-and-status)            |
| Claude Code + Codex | Runtime overrides, model and effort selection, isolated runtime configuration             | [Getting Started](docs/getting-started.md#step-1--one-hand-driven-session-the-shakedown)             |
| Agent messaging     | Direct messages, broadcasts, operator messages, delivery receipts, and cancellation       | [Communication and receipts](docs/agent-guide.md#communication-receipts-and-operator-escalation)     |
| Rooms               | Named group conversations across sessions and federated fleets, with the operator present | [Rooms](docs/agent-guide.md#rooms-group-conversation)                                                |
| Local federation    | Opt-in discovery and existing agent operations across same-machine fleets                 | [Local federation](guides/federation.md)                                                             |
| Parallel workspaces | Empty sessions, registered Git templates, and linked Git worktrees                        | [Worktrees and templates](docs/agent-guide.md#worktrees-templates-and-full-fleet-workspace-patterns) |
| Shareable runbooks  | Versioned local workflow knowledge built from ordinary primitives                         | [Authoring and sharing runbooks](guides/runbooks.md)                                                 |
| Stall supervision   | Per-session auto mode, a normal agent acting as sentinel, and fleet-wide stall detection  | [Supervision](docs/agent-guide.md#auto-mode-sentinels-fleet-watch-and-escalation-policy)             |
| Recurring work      | Cron schedules that prompt managed sessions using normal lifecycle behavior               | [Scheduling](docs/agent-guide.md#cron-schedules-and-recurring-agent-work)                            |
| Operator access     | Local console, one-shot commands, live status, Telegram, Slack, and adapter APIs          | [Operator channels](docs/agent-guide.md#operator-console-telegram-slack-and-injected-channels)       |
| Plugin events       | Typed live observations plus a local content-free event journal and JSONL export          | [Event subscribers](guides/event-subscribers.md)                                                     |
| Background services | Trusted injected integrations with protected delivery, durable state, and truthful health | [External integrations](guides/external-adapters.md#background-integrations)                         |
| PR Shepherd         | Optional GitHub PR polling and policy-driven coordination                                 | [PR Shepherd V2](docs/pr-shepherd.md)                                                                |

All operator interfaces use the same command language, and all managed agents receive
the same runtime-neutral MCP operations. Run `/help` in the operator console for the
authoritative command reference; managed agents can inspect their authoritative tool
schemas directly.

## Advanced features

### Local federation and named instances

Federation is an opt-in connection between independent Conductors on the same machine. Each
participating fleet chooses one public name and either an explicit exposed roster or `'*'` for
its current roster. Managed agents receive one `list_federation` discovery tool and an optional
`fleet` argument on the existing routable tools; non-federated fleets receive exactly the
ordinary local tool surface.

Running `conductor start` still selects the historical default instance. When two Conductors
must share one fleet directory, use `conductor --instance <name> start`; named instances keep
their configuration, environment, data, pane ownership, port, and daemon identity under
`.conductor/instances/<name>/`. Federation and named instances are independent: fleets in
different directories can federate, and same-directory instances need not.

See [Local Conductor Federation](guides/federation.md) for the minimal configuration, routing
semantics, exposure boundary, and copyable same-directory example.

### Worktrees, templates, schedules, and headless sessions

`/spawn` can create an empty workspace, clone a registered Git template with `--template`,
or create a linked Git worktree with `--worktree` and `--branch`. Repeatable `--add-dir`
flags expose shared records outside the workspace, and `--system-prompt` attaches a durable,
5 KiB role script without writing generated instructions into the worktree. Missing, unreadable,
non-file, invalid UTF-8, or oversized instruction sources fail the start visibly rather than being
silently skipped. `/teardown --delete`
removes only safe, Conductor-owned directories and refuses dirty worktrees. Teardown retains the
codename's native conversation data; deleting that history is not implicit in workspace or
registration cleanup. A later `/spawn <same-name> --session-id <id>` can therefore rebuild a
disposable workspace and resume that conversation without an intervening fresh launch. Session YAML
can also define Croner-compatible `schedules`; an inactive session starts with the prompt,
while an active session receives it through the normal protected delivery path. Pausing the
session defers cron occurrences, including one that was reconciling activity when pause began.

The tmux backend supports `--headless` sessions and unattended operation over SSH.
`conductor daemon install` creates a user-level launchd or systemd service for a globally
installed release. These features use the same lifecycle and messaging primitives as
visible panes rather than introducing a separate worker model.

### Runbooks and workflow recipes

Runbooks let a fleet author or community contributor package the arrangement that makes their
agents productive: roles, layout, prompts, review gates, verification, and recovery. They are
versioned local knowledge bundles, not executable workflow definitions. Conductor discovers
built-in, fleet-owned, and explicitly configured local bundles and exposes their declared topics
through the same `get_conductor_docs` catalog agents already use.

After the first hand-driven session works, ask the onboarding assistant: “Show me the runbook
catalog and help me configure Engineering Management Tier 1.” It should explain the selected
workflow, gather your choices, and make only approved changes. If you want to label the resulting
work for later evaluation, it prepares an exact operator-only `/runbook adopt` command; merely
reading a runbook never activates it or grants authority.

Start with the built-in [Engineering Management](runbooks/agent-conductor/engineering-management/README.md)
bundle, then see [Authoring and sharing runbooks](guides/runbooks.md) to create, validate, version,
share, and record adoption of your own recipes.

### Operator adapters

The local console, Telegram, Slack, and injected operator channels all adapt the same
canonical command router. Telegram uses a private bot and authorized chat ID; Slack uses a
private App Home conversation over outbound Socket Mode. Both can run together, render
selectable `send_to_operator` choices, and keep credentials in the fleet's owner-only,
gitignored `.conductor/.env`.

An optional channel failing to start does not take down agent lifecycle or peer messaging.
External integrations implement the small `ChannelAdapter` contract and own only transport
concerns—authentication, parsing, formatting, service limits, retries, and shutdown. Core
commands and policy remain in `ConductorOperations`, so a new channel does not need to
reimplement fleet behavior. See the [Telegram guide](guides/telegram-adapter.md),
[Slack guide](guides/slack-adapter.md), and [external adapter contract](guides/external-adapters.md).

### Plugin and integration events

Embedding hosts can inject typed `ConductorEventSubscriber` implementations to react to
lifecycle, activity, stall, fleet-stall, schedule, and operator-request outcomes without polling
status or tailing panes. Subscribers observe metadata-only facts and never enter Conductor's
control path. Delivery is live, ordered, best-effort, and failure-isolated; sequence numbers make
restarts and dropped events detectable so consumers can reconcile through existing pull surfaces.
See the [event subscriber contract](guides/event-subscribers.md) for the exported TypeScript API,
event catalog, privacy boundary, and delivery semantics.

### Background integrations

`ConductorIntegration` implementations handle deterministic work that should not wake a model on
every poll: repository watchers, CI monitors, ticket synchronizers, calendars, and similar
services. Conductor owns bounded lifecycle, cancellation, health, a namespaced durable state
directory, and mechanically identified protected delivery:

```text
[Integration: water-cooler] Peer bulletins changed on origin/main…
```

The integration owns timers, provider credentials, reconciliation, overlap policy, and cursor
schema. It receives no operator authority, raw terminal access, fleet store, secrets, or general
control operations. A paused target rejects new integration delivery as retryable work, and an
automated message already waiting in Conductor's protected queue remains held until resume.

The stock CLI can load an explicit trusted local ESM file during foreground startup:

```yaml
integrations:
  - module: ./integrations/water-cooler/dist/index.js
    options:
      targetSession: coordinator
```

Only a trusted fleet owner may edit this executable-code list. Validation checks that the file
exists but deliberately never executes it; the foreground process imports it once during
startup. Relative paths must stay inside the fleet root, options must not contain secrets, and
module changes require a restart. There is no package discovery, manifest, marketplace, or hot
reload. Direct embedders may instead inject objects through `SupervisorOptions.integrations`.
See the [external integration contract](guides/external-adapters.md#background-integrations).

### PR Shepherd

PR Shepherd V2 is an opt-in GitHub polling companion shipped in the same package. It watches
configured pull requests, evaluates checks/reviews/merge readiness, stores its own durable
state, and can either print factual events or deliver them through Conductor to a coordinator
agent. The coordinator then uses ordinary fleet primitives to dispatch review, coordinate a
fix, or ask the operator.

The first `conductor start` creates an inert Shepherd profile; it does not poll until a
GitHub identity is configured and Shepherd is explicitly enabled. The recommended rollout is
observation first: authenticate `gh`, validate the profile, run one baseline-only
`poll --once` with stdout delivery, and move automation policies from `off` or `notify` to
`execute` only after the observed decisions are correct. A managed Shepherd runs headless by
default, appears in fleet status while healthy, and cannot take down Conductor if it fails.
See [PR Shepherd V2](docs/pr-shepherd.md) for its policy and delivery model.

## How it works

```text
 Claude Code ─┐                          ┌─ iTerm2 panes
              ├─ session-facing MCP ─┐  └─ tmux panes
 Codex ───────┘                      │
                                    ▼
                              ConductorOperations
                              canonical control plane
                                    ▲
                                    │
 Local console ──┐                  │
 Telegram ───────┼─ operator adapters
 Slack ──────────┼─ operator adapters
 Other channels ─┘
```

The canonical operation registry owns behavior, validation, descriptions, and MCP
schemas. Session-facing MCP tools and operator commands adapt that same operation set,
which keeps lifecycle and messaging behavior consistent across runtimes and channels.

Conductor itself never calls an LLM. If supervision detects a stall, it sends a
self-contained event to the configured sentinel—a normal Claude Code or Codex session
that can inspect, message, escalate, or do nothing using ordinary Conductor tools.

Fleet configuration, secrets, runtime state, and logs live under `.conductor/` in the
fleet directory. Session files hot-reload; supervisor-level changes take effect after a
restart. Existing files are never overwritten by the startup scaffold.

## Documentation

Start here:

- [Getting Started](docs/getting-started.md) — first fleet, configuration anatomy,
  shakedown, supervision, remote control, worktrees, and unattended operation.
- [Managed-agent handbook](docs/agent-guide.md) — version-matched operational recipes,
  configuration maintenance, composition patterns, and troubleshooting. Managed agents
  can also read it lazily through `get_conductor_docs`.
- [Complete supervisor example](examples/supervisor.yaml) — every setting and effective
  default.
- [Engineering management runbook](runbooks/agent-conductor/engineering-management/README.md) — a tiered,
  end-to-end EM, worker, review, Sentinel, and PR Shepherd fleet pattern.
- [Authoring and sharing runbooks](guides/runbooks.md) — bundle format, local discovery,
  versioning, adoption provenance, event export, and contribution rules.

Optional integrations:

- [Telegram setup](guides/telegram-adapter.md)
- [Slack setup](guides/slack-adapter.md)
- [PR Shepherd V2](docs/pr-shepherd.md)

Extending or contributing:

- [External adapters and embedding](guides/external-adapters.md) — background integrations,
  operator channels, event subscribers, terminal backends, and experimental runtime adapters.
- [Event subscribers](guides/event-subscribers.md) — typed plugin events, ordering, failure
  isolation, compatibility, and privacy guarantees.
- [Contributing](CONTRIBUTING.md) — product bar, tests, documentation, and completion
  contract.
- [Architecture and agent guide](CLAUDE.md) — core boundaries and repository invariants.
- [GitHub beta release runbook](docs/beta-release-runbook.md) — package certification,
  checksums, cohort installation, and release policy.
- [Choosing an agent fleet tool](docs/alternatives.md) — a candid comparison with native
  agent features and adjacent open-source products.

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md) before changing the
core or an adapter. `pnpm verify:package` certifies the packed artifact and a disposable
external consumer before release.

## License

[MIT](LICENSE)
