# External adapters and embedding

Agent Conductor exposes its existing runtime, terminal, operator-channel, and event-subscriber
seams to embedding applications. Extension is constructor injection into `Supervisor`; it does
not create a plugin loader, a second configuration system, or a parallel policy engine.

The root `agent-conductor` package export is the supported import boundary. Do not import files
from `dist/`.

## Stability during beta

- `Supervisor`, `SupervisorOptions`, configuration types, channel contracts,
  event-subscriber contracts, `TerminalBackend`, channel rendering, and the PR Shepherd API are
  the stable beta surface.
- `SessionRuntime`, its capability and launch types, and the concrete Claude Code and Codex
  runtime classes are experimental during beta. Provider-version testing may require compatible
  harness changes before the stable release.
- The built-in tmux and iTerm classes are not exported yet because their constructors depend on
  Conductor's private persistence store. Injecting an external `TerminalBackend` is supported.

## Embedding host

The runnable [embedding host](../examples/embedding-host.mjs) imports only the package root,
injects a minimal operator channel and event subscriber, disables bundled channel discovery,
starts the supervisor, and shuts down cleanly on `SIGINT` or `SIGTERM`:

```bash
node examples/embedding-host.mjs /path/to/fleet
```

The host process owns construction and secrets for its external adapters. The stock `conductor`
CLI deliberately does not load arbitrary packages from YAML.

## Event subscribers

Implement `ConductorEventSubscriber` when a plugin needs typed fleet facts without polling or
terminal tailing. Inject subscribers with `new Supervisor(fleetDir, { eventSubscribers: [...] })`.
They are observation-only and best-effort; they do not replace commands, operations, or channels.
Conductor also keeps a separate local durable event journal for export, but exposes no subscriber
replay or cursor API. See the complete [event subscriber contract](event-subscribers.md) for the
event catalog, journal, ordering, overflow, failure, privacy, and compatibility guarantees.

## Operator channels

Implement `ChannelAdapter` when integrating an authenticated operator transport:

1. Derive a stable `conversationId` from trusted provider metadata.
2. Authenticate or allowlist the caller before invoking `ChannelHandlers`.
3. Route slash commands through `onCommand` and ordinary text through `onFreeText`.
4. Render outbound semantic actions as native controls, or use `renderChannelMessage` for text.
5. Bound requests and retries, isolate malformed updates, and make start/stop idempotent.
6. Keep credentials in the host application's secret mechanism—not fleet YAML or logs.

The adapter owns transport mechanics only. Lifecycle, messaging, authorization, request claims,
and conversation routing stay in Conductor's canonical operations.

## Terminal backends

Implement `TerminalBackend` for a new pane/process host. It owns pane identity, placement,
launching, process liveness, capture, delivery, rediscovery, titles, and teardown. Advertise
headless support through `capabilities`; unsupported placement can be mapped explicitly by the
backend.

Protected message delivery uses `captureForDelivery` and `submitIfUnchanged` when both exist.
Their token is backend-owned and must reject a submit if pane input changed after capture. If
those methods are absent, Conductor remains conservative but cannot close the backend-specific
observation/write race.

Inject one backend with `new Supervisor(fleetDir, { terminalBackend })`.

## Session runtimes

Implement `SessionRuntime` for another agent CLI. A runtime owns:

- per-session identity, hook, and instruction preparation;
- fresh and resume launch commands;
- runtime capability advertisement;
- input-state parsing and optional ambiguity resolution;
- terminal-chrome stripping;
- lifecycle-event normalization; and
- transcript access when the provider exposes it.

Register runtimes with `new Supervisor(fleetDir, { runtimes: [...] })`. Runtime names are trimmed,
non-empty strings. Duplicate names in the injected array are rejected. An injected runtime may
deliberately wrap or replace a built-in by using `claude-code` or `codex`; `cc` is reserved as the
operator-facing alias for `claude-code`.

The final registry validates the fleet default and every session reference. Registered names are
also used by spawn, start, continue, MCP schemas, validation errors, and generated operator help.

## Verification

An external adapter package should test:

- its parser/formatter or launch-command logic in isolation;
- one failure and recovery path at its provider boundary;
- injection through a real `Supervisor` with an in-memory counterpart for the other seams;
- clean shutdown; and
- subscriber ordering, failure isolation, and sequence-gap reconciliation when it consumes
  Conductor events; and
- compilation and execution from a temporary consumer project installed from the packed
  Conductor tarball.

Real-service or real-runtime tests belong in an explicit manual shakedown and must not require
credentials in the automated suite.
