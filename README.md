# agent-conductor

Lightweight supervisor for terminal coding agents (Claude Code, Codex).

Gives agents powerful communication primitives and protocols: terminal pane orchestration
(iTerm2, tmux), inter-agent messaging over MCP with unforgeable mechanical identity,
event-driven health monitoring, a stall-sentinel agent, operator channel adapters
(Telegram first), and cron scheduling.

> Under active initial development. See `docs/implementation-plan.md` for the build plan and
> `docs/agent-conductor-registry.md` for the design decisions.

## Development

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test
```

## License

MIT
