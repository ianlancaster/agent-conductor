# Choosing an agent fleet tool

Agent Conductor is one of several tools addressing multi-agent coding. The tools are not
interchangeable: some manage terminal processes, some assign work, some provide remote access,
and some coordinate conversations. Start with the smallest product whose center of gravity
matches your workflow.

This comparison was last reviewed in July 2026. Product capabilities change quickly; follow the
linked project documentation before making a long-term choice.

## Quick decision guide

| If you primarily need…                                                                | Consider…                                                                                                                    | Why                                                                                                                                                  |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate Claude Code and Codex sessions that communicate and share lifecycle controls | **Agent Conductor**                                                                                                          | Runtime-neutral peer messaging with mechanical identity, delivery receipts, operator channels, schedules, and optional sentinel-based stall handling |
| Persistent agent terminals that survive detach and work naturally over SSH            | [Herdr](https://herdr.dev/)                                                                                                  | A Rust terminal multiplexer with real PTYs, semantic agent state, direct attach, a socket API, and plugins across many terminal agents               |
| An opinionated organization of coordinators, workers, tasks, and merges               | [Gas Town](https://github.com/steveyegge/gastown)                                                                            | A larger operating model built around roles, durable work state, mailboxes, and repository workflow                                                  |
| Delegation inside a single Claude Code or Codex conversation                          | Native vendor features                                                                                                       | Lowest setup cost when parent-routed or same-runtime collaboration is sufficient                                                                     |
| A TUI for parallel coding sessions and Git worktrees                                  | [claude-squad](https://github.com/smtg-ai/claude-squad)                                                                      | Focused session and workspace management without requiring a fleet communication protocol                                                            |
| A polished desktop worktree and diff-review workflow                                  | [Conductor](https://www.conductor.build/)                                                                                    | Human-centered macOS workspace and review experience                                                                                                 |
| Remote human control from a phone or browser                                          | [Happy](https://github.com/slopus/happy) or [Omnara](https://github.com/omnara-ai/omnara)                                    | Remote access is the product center rather than agent-to-agent fleet coordination                                                                    |
| Agent messaging without session supervision                                           | [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) or [Agent-MCP](https://github.com/rinadelph/Agent-MCP) | Coordination can be added to processes you already manage another way                                                                                |

## Where Agent Conductor fits

Agent Conductor is a terminal-based tool for highly productive and autonomous fleet coding
sessions. It is designed for a fleet of separate, visible terminal agents, with a shared control
plane that lets the fleet coordinate without hiding the underlying agent processes:

- each session has a mechanically assigned identity;
- Claude Code and Codex use the same lifecycle and communication primitives;
- direct messages have observable receipts and cancellation;
- the local console, Telegram, Slack, and injected channels adapt the same operations;
- optional health routing delegates judgment to a normal agent acting as sentinel.

That makes Conductor a good fit when agents must coordinate over time without requiring the human
operator to relay every message. It is a weaker fit when all work can stay inside one native agent
team, when the main requirement is remote terminal persistence, or when a strongly prescribed task
and merge workflow is desirable.

## Feature comparison

This matrix compares each product's primary shipped model rather than every behavior that could be
added through scripts or plugins.

| Tool                                                                                     | Terminal fleet                                      | Claude + Codex                  | Peer coordination                                               | Stall handling                                                                 | Remote operator                                   | Workflow posture                                                       |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------------- |
| **Agent Conductor**                                                                      | iTerm2 or tmux panes                                | Yes                             | Identified MCP messages, broadcasts, receipts, and cancellation | Mechanical detection plus an agent sentinel that judges and escalates          | Local console, Telegram, Slack, injected adapters | Composable primitives; fleet policy stays in agent/config instructions |
| [Herdr](https://herdr.dev/)                                                              | Persistent native multiplexer with local/SSH attach | Yes, plus other terminal agents | Pane/socket API can read, send, split, and wait                 | Semantic blocked/working/done/idle state; no equivalent sentinel control plane | SSH/direct attach and plugin ecosystem            | Terminal-runtime and multiplexer centered                              |
| [Gas Town](https://github.com/steveyegge/gastown)                                        | tmux-backed roles and workers                       | Yes, plus other runtimes        | Role mailboxes and durable task state                           | Mechanical health roles and escalation                                         | No bundled chat operator channel                  | Strongly opinionated roles, task ledger, and merge flow                |
| [amux](https://github.com/mixpeek/amux)                                                  | tmux control plane                                  | Yes                             | REST channels, mentions, and task claiming                      | Mechanical watchdog and recovery                                               | Web dashboard and iOS client                      | Lightweight pane orchestration with built-in coordination              |
| Native Claude Code/Codex features                                                        | Vendor-owned processes or panes                     | No cross-vendor fleet           | Parent-routed delegation; Claude teams add same-runtime peers   | No cross-process fleet sentinel                                                | Vendor-specific and generally session-scoped      | Native, low-setup delegation inside one runtime                        |
| [claude-squad](https://github.com/smtg-ai/claude-squad)                                  | tmux sessions and Git worktrees                     | Yes, plus other CLIs            | No peer messaging layer                                         | No fleet stall response                                                        | Local TUI                                         | Parallel session/worktree management                                   |
| [Conductor](https://www.conductor.build/)                                                | Desktop-managed worktree sessions                   | Yes, plus Cursor                | No peer messaging layer                                         | No fleet stall response                                                        | macOS desktop app                                 | Human-centered worktree and diff review                                |
| [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail)                    | Does not manage terminals                           | Runtime-neutral MCP             | Searchable mailboxes, threads, and file leases                  | No session supervision                                                         | No operator channel                               | Narrow coordination layer for externally managed agents                |
| [Agent-MCP](https://github.com/rinadelph/Agent-MCP)                                      | Does not manage terminals                           | Runtime-neutral MCP             | Admin/worker communication, task assignment, and shared RAG     | No session supervision                                                         | Dashboard                                         | Task and knowledge coordination for externally managed agents          |
| [Happy](https://github.com/slopus/happy) / [Omnara](https://github.com/omnara-ai/omnara) | Remote clients rather than fleet supervisors        | Claude Code and Codex           | Human-to-agent control, not a peer fleet bus                    | No fleet sentinel                                                              | Mobile/web is the product center                  | Remote access to agents managed through their client model             |

The practical distinction is that Agent Conductor combines terminal session management with a
conversation and supervision plane. Herdr goes deeper on the persistent terminal multiplexer;
Gas Town goes deeper on prescribed organization and task flow; native subagents go smaller and
stay inside one runtime; the coordination-only and remote-client products deliberately own less of
the fleet lifecycle.

## Herdr and Agent Conductor

[Herdr](https://herdr.dev/) is the closest current option from the terminal-runtime direction. It
owns persistent PTY sessions, runs inside an existing terminal, supports local and SSH attachment,
tracks blocked/working/done/idle agent state, and exposes CLI and socket APIs that agents can use to
read, send, split, and wait. Its integrations cover Claude Code, Codex, and many other terminal
agents, and its plugin ecosystem can add review and remote-control workflows.

Choose Herdr when the terminal multiplexer itself is the problem you want solved: durable sessions,
reattachment, remote access, a unified terminal UI, and agent-aware automation. Choose Agent
Conductor when the coordination protocol is the problem: identified conversational messages among
separate agents, delivery state, runtime-neutral lifecycle tools, and sentinel/operator escalation.
They occupy adjacent layers and may be composable, but neither should be described as a drop-in
replacement for the other's center of gravity.

## Native multi-agent features

Claude Code and Codex both provide native delegation. Those features are usually the best first
choice when work belongs to one parent conversation, one runtime, and one machine. They minimize
setup and keep coordination inside the vendor's supported execution model.

Agent Conductor becomes useful when sessions need independent histories and lifecycles, when Claude
Code and Codex must interoperate, when peers need to address one another directly, or when fleet
status and operator channels must outlive one parent turn.

## Task systems, session managers, and communication layers

- **Gas Town** provides much more workflow structure than Agent Conductor. Choose it when named
  roles, durable task state, worker allocation, and merge machinery are wanted as a package.
- **claude-squad** and the macOS **Conductor** app focus on launching parallel sessions and isolated
  branches or worktrees. Choose them when human review of parallel code changes is more important
  than agent-to-agent communication or stall escalation.
- **Happy** and **Omnara** focus on reaching agents remotely. Choose them when the core problem is
  human-to-agent access from another device.
- **MCP Agent Mail** and **Agent-MCP** provide coordination without owning terminal lifecycle. Choose
  that narrower layer when an existing process manager already meets your needs.

## A note on comparison

This page compares product emphasis, not theoretical feature reach. Plugins, scripting, and custom
adapters can make many tools approximate one another. The useful question is which defaults and
primitives match the system you want to operate and maintain.
