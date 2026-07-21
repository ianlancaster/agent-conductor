# Contributing to Agent Conductor

Thanks for helping improve Agent Conductor. The project is intentionally small: it provides
reliable lifecycle, messaging, observability, and stall-routing primitives for terminal agent
fleets without becoming a workflow engine or making LLM decisions itself.

Read [CLAUDE.md](CLAUDE.md) before changing code. Despite the filename, it is the canonical
developer guide for every contributor and coding agent. It documents the architecture,
invariants, extension seams, and testing strategy.

## Development setup

Agent Conductor requires Node.js 22 or newer and pnpm.

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

Those four checks are the pre-commit quality gate and run in CI. The test suite includes a
real tmux E2E suite when tmux is installed.

## Choosing the right extension point

- Add fleet behavior, validation, or authorization to `ConductorOperations`. Operator
  commands and session MCP tools are adapters over that canonical registry.
- Implement `ChannelAdapter` for an external operator transport such as Telegram or Slack.
- Implement `SessionRuntime` for an agent CLI.
- Implement `TerminalBackend` for a terminal emulator or multiplexer.

The local console is a native `/cmd` and `/feed` client, not a `ChannelAdapter`. See the
extension taxonomy in [CLAUDE.md](CLAUDE.md#extension-taxonomy) before introducing a new
abstraction.

Keep transport-specific behavior behind its seam. Adapters may parse, authenticate, format,
retry, and translate service capabilities; they must not duplicate lifecycle, messaging,
state, or authorization policy from the core.

Outbound channel messages are semantic: `ChannelMessage.actions` carry display labels and
canonical operator commands. Adapters with native controls may render them as buttons;
text-only adapters should use `renderChannelMessage`. Never put transport-specific callback
payloads or core policy in the shared message contract.

## Making a change

1. Inspect the current worktree and preserve unrelated changes.
2. Add or update focused tests with the implementation.
3. Update user documentation and `prompts/conductor-protocol.md` when a public operation or
   session-facing behavior changes.
4. Run the full quality gate.
5. Add a changeset with `pnpm changeset` for a user-facing change. Internal refactors and
   test-only changes generally do not need one.

Public package exports live in `src/index.ts`. Treat changes to exported interfaces,
configuration schemas, operation schemas, command syntax, persisted data, and generated
files as public compatibility decisions even before the first stable release.

## Testing expectations

Use the narrowest test that proves the behavior, then add an integration test at the seam:

- Core orchestration: real core modules with the fakes in `test/fakes/`.
- Operator channels: pure parser/formatter tests, a scripted API double, and a
  `FakeChannel` supervisor pipeline test.
- Session MCP: operation surface-contract tests plus real HTTP tests where transport behavior
  matters.
- Runtimes and terminals: interface-level tests; keep AppleScript and command construction
  behind pure helpers.
- Filesystem and git behavior: isolated temporary directories and real git repositories.
- End-to-end terminal behavior: the tmux E2E suite and, when needed, a manual shakedown under
  `test/manual/`.

Tests must not require real credentials, contact production services, or depend on a
developer's global runtime configuration.

## Persistence and configuration

SQLite migrations in `src/store/index.ts` are append-only. Add a new `MIGRATIONS` entry;
never edit a migration that may already have run in a user's fleet.

All configuration is validated with strict Zod schemas. Unknown keys should remain errors,
and every optional setting needs a default or a clearly defined absence behavior. Secrets do
not belong in YAML, fixtures, logs, examples, or committed environment files.

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

## Pull requests

Keep changes focused and explain both the user-visible outcome and the architectural seam
used. Call out migrations, public API changes, new dependencies, manual verification, and
known limitations explicitly.
