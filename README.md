# Agent Conductor

Agent Conductor is a local control plane for running several Claude Code and OpenAI
Codex agents as a coordinated fleet. It can spawn agents into real terminal panes,
start and stop persistent sessions, create isolated worktree or template sessions,
and give every agent a consistent way to communicate with its peers and the human
operator.

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

Conductor opens the assistant in a new pane. Move to that pane and paste this prompt
directly into the assistant:

```text
Help me onboard this Conductor fleet. First call get_conductor_docs without a topic, then read onboarding and fleet-configuration. Interview me one decision at a time, explain the safe defaults and tradeoffs, and make only changes I approve. Finish by validating the configuration and helping me run one hand-driven test session.
```

The assistant can discover the version-matched handbook and the active fleet's real
configuration paths. It will guide you through a minimal manual session before offering
automation, remote channels, or other optional features.

Run `conductor doctor` whenever you want an actionable environment and configuration
check. The console opened by `conductor start` owns its Conductor process, so `Ctrl+C`
stops it. Use `conductor console` only when you intentionally want an additional,
non-owning console.

For the full walkthrough, including what the generated files mean, continue with
[Getting Started](docs/getting-started.md).

## Why use it?

- **Run mixed fleets.** Claude Code and Codex share one runtime-neutral control plane
  while retaining their native terminals, settings, and conversation histories.
- **Delegate in parallel.** Spawn persistent agents, disposable workers, Git worktrees,
  or registered repository templates without hand-building every terminal session.
- **Coordinate directly.** Agents send signed messages through mechanically assigned
  identities instead of scraping one another's terminals or relying on a shared chat.
- **Keep work observable.** The operator console, live status view, pane output, receipts,
  and logs expose what the fleet is doing and whether communication was delivered.
- **Add supervision only when useful.** Auto mode, a designated stall sentinel, fleet
  watch, schedules, and remote operator channels are optional layers over the same core
  primitives.

## Is Agent Conductor the right tool?

Several good tools cover adjacent parts of multi-agent development. Choose based on the
problem you most need to solve:

| Start with                                                                                           | When your priority is                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Agent Conductor**                                                                                  | A mixed Claude Code and Codex fleet whose separate agents need direct, identified communication, shared lifecycle controls, and optional stall/operator escalation |
| [Herdr](https://herdr.dev/)                                                                          | A persistent, agent-aware terminal multiplexer with SSH reattachment, broad terminal-agent support, semantic state, and a plugin ecosystem                         |
| [Gas Town](https://github.com/steveyegge/gastown)                                                    | An opinionated multi-agent operating model with roles, a durable task ledger, and merge workflow                                                                   |
| Native Claude Code or Codex multi-agent features                                                     | Delegation contained inside one vendor runtime and led by a parent or team lead                                                                                    |
| [claude-squad](https://github.com/smtg-ai/claude-squad) or [Conductor](https://www.conductor.build/) | Parallel worktrees and human-centered session or diff review, without a peer communication layer                                                                   |
| [Happy](https://github.com/slopus/happy) or [Omnara](https://github.com/omnara-ai/omnara)            | Remote human access to coding agents from mobile or web clients                                                                                                    |
| [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail)                                | Agent mailboxes and coordination without adopting a terminal/session supervisor                                                                                    |

These categories overlap, and some tools can be composed. See [Choosing an agent fleet
tool](docs/alternatives.md) for the fuller comparison and tradeoffs.

## Feature map

| Capability          | What it provides                                                                         | Learn more                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Session lifecycle   | Spawn, start, continue, stop, pause, resume, and tear down agents                        | [Lifecycle and status](docs/agent-guide.md#session-lifecycle-placement-models-and-status)            |
| Claude Code + Codex | Runtime overrides, model and effort selection, isolated runtime configuration            | [Getting Started](docs/getting-started.md#step-1--one-hand-driven-session-the-shakedown)             |
| Agent messaging     | Direct messages, broadcasts, operator messages, delivery receipts, and cancellation      | [Communication and receipts](docs/agent-guide.md#communication-receipts-and-operator-escalation)     |
| Parallel workspaces | Empty sessions, registered Git templates, and linked Git worktrees                       | [Worktrees and templates](docs/agent-guide.md#worktrees-templates-and-full-fleet-workspace-patterns) |
| Stall supervision   | Per-session auto mode, a normal agent acting as sentinel, and fleet-wide stall detection | [Supervision](docs/agent-guide.md#auto-mode-sentinels-fleet-watch-and-escalation-policy)             |
| Recurring work      | Cron schedules that prompt managed sessions using normal lifecycle behavior              | [Scheduling](docs/agent-guide.md#cron-schedules-and-recurring-agent-work)                            |
| Operator access     | Local console, one-shot commands, live status, Telegram, Slack, and adapter APIs         | [Operator channels](docs/agent-guide.md#operator-console-telegram-slack-and-injected-channels)       |
| PR Shepherd         | Optional GitHub PR polling and policy-driven coordination                                | [PR Shepherd V2](docs/pr-shepherd.md)                                                                |

All operator interfaces use the same command language, and all managed agents receive
the same runtime-neutral MCP operations. Run `/help` in the operator console for the
authoritative command reference; managed agents can inspect their authoritative tool
schemas directly.

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

Optional integrations:

- [Telegram setup](guides/telegram-adapter.md)
- [Slack setup](guides/slack-adapter.md)
- [PR Shepherd V2](docs/pr-shepherd.md)

Extending or contributing:

- [External adapters and embedding](guides/external-adapters.md) — operator channels,
  terminal backends, and experimental runtime adapters.
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
