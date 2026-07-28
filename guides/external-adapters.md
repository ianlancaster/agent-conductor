# External adapters and embedding

Agent Conductor exposes its runtime, terminal, operator-channel, event-subscriber, and background
integration seams to embedding applications. Extension is constructor injection into `Supervisor`;
it does not create a plugin loader, a second configuration system, or a parallel policy engine.

The root `agent-conductor` package export is the supported import boundary. Do not import files
from `dist/`.

## Stability during beta

- `Supervisor`, `SupervisorOptions`, configuration types, channel contracts,
  event-subscriber and background-integration contracts, `TerminalBackend`, channel rendering,
  and the PR Shepherd API are the stable beta surface.
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

The host process owns construction and secrets for directly injected extensions. The stock
`conductor` CLI can also load an explicitly named trusted local integration file; it never
discovers packages or executable code automatically.

## Background integrations

Use `ConductorIntegration` for trusted deterministic work that must run beside the Supervisor and
wake a model only when mechanical reconciliation finds something relevant. Typical examples are
repository watchers, CI monitors, ticket synchronizers, and calendar or inbox pollers.

```ts
import type {
  ConductorEvent,
  ConductorIntegration,
  ConductorIntegrationContext,
  MessageReceipt,
} from 'agent-conductor';

export class RepositoryWatcher implements ConductorIntegration {
  readonly name = 'repository-watcher';
  private context?: ConductorIntegrationContext;
  private timer?: NodeJS.Timeout;
  private running = false;

  async start(context: ConductorIntegrationContext): Promise<void> {
    this.context = context;
    await this.reconcile();
    if (context.signal.aborted) return;
    this.timer = setInterval(() => void this.reconcile(), 2 * 60 * 60 * 1_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.context = undefined;
  }

  onEvent(event: ConductorEvent): void {
    if (event.type === 'session.activity.changed') {
      // Coalesce a content-free hint; never perform Git/network work inline.
      this.markLocalActivityDirty();
    }
  }

  private async reconcile(): Promise<void> {
    const context = this.context;
    if (context === undefined || context.signal.aborted || this.running) return;
    this.running = true;
    try {
      const change = await this.fetchAndCompare(context.stateDir, context.signal);
      if (change === undefined) {
        context.reportHealth({ state: 'healthy' });
        return;
      }
      const receipt: MessageReceipt = await context.sendToSession('assistant', change.prompt, {
        idempotencyKey: change.immutableIdentity,
      });
      if (receipt.status === 'delivered') {
        await this.commitCursorAtomically(context.stateDir, change.nextCursor);
      }
      context.reportHealth({
        state: receipt.status === 'delivered' ? 'healthy' : 'degraded',
        detail: receipt.status === 'delivered' ? undefined : 'delivery awaiting retry',
      });
    } catch {
      if (!context.signal.aborted) {
        context.reportHealth({ state: 'degraded', detail: 'repository reconciliation failed' });
      }
    } finally {
      this.running = false;
    }
  }
}
```

The abbreviated provider-specific methods above belong to the external package. Conductor grants
only:

- `signal`: aborted before protected delivery, MCP, or persistence teardown;
- `stateDir`: `<dataDir>/integrations/<name>`, created owner-only where supported and retained
  across normal stops;
- `sendToSession`: protected delivery with mandatory sender-scoped idempotency;
- `reportHealth`: bounded operator-safe `healthy`, `degraded`, or `failed` status; and
- optional metadata-only events through the same independent bounded queue as ordinary
  `ConductorEventSubscriber` implementations.

`start()` initializes resources, registers timers or loops, and returns. It must not remain
pending for the service lifetime. Honor `signal`, prevent overlapping work, bound provider calls,
and make `stop()` safe after partial initialization. A startup or shutdown failure is isolated
from the core and shown in fleet status. A resolved `start()` does not imply health; the
integration remains `starting` until it calls `reportHealth`.

Integration names are lowercase alphanumeric identifiers with internal dashes. Conductor derives
the sender mechanically as `integration:<name>` and renders `[Integration: <name>]`; the
integration cannot impersonate an operator or session. The context exposes no
`ConductorOperations`, raw pane access, fleet store, environment, secrets, lifecycle controls, or
event publication.

### State, events, and delivery

The integration owns the contents, schema, migrations, locks, and atomic writes below `stateDir`.
It is durable state, not a cache, and Conductor never deletes it during normal shutdown.
Provider credentials remain outside supervisor YAML. Direct embedders and configured modules own
their own provider configuration mechanism.

Events are lossy hints. They begin only after `start()` succeeds, may contain sequence gaps, and
are detached before `stop()` begins. A callback already in progress may finish, but the aborted
context refuses new delivery. Perform slow Git or network reconciliation in integration-owned
bounded machinery, not inline in `onEvent`. The provider cursor or remote source remains
authoritative after restart.

Protected delivery is intentionally at-least-once processing rather than an atomic transaction
across the Conductor database and integration state:

1. Derive an immutable logical change identity, such as repository plus old/new commit SHA.
2. Use it unchanged as `idempotencyKey` on every retry.
3. Retain the previous cursor for `queued` or retryable `cancelled` receipts.
4. Atomically advance the cursor after `delivered`, including
   `deduplicated: true, status: delivered`.

A restart-cancelled receipt is reactivated by retrying the same key. An explicitly cancelled
receipt stays cancelled. `delivered` means Conductor wrote the protected envelope to a ready pane
or successfully launched the target with it; it does not acknowledge that the model completed
the requested work. Require a separate application-level acknowledgement if that distinction
matters.

### Fleet-configured construction

`integrations` is a trusted-local-code boundary. Only a trusted fleet owner may edit it: every
listed module executes in the Conductor process with the same operating-system authority as
Conductor itself. The narrow `ConductorIntegrationContext` is an API boundary, not a sandbox.
Never put credentials or other secrets in `options`.

```yaml
integrations:
  - module: ./integrations/water-cooler/dist/index.js
    options:
      targetSession: coordinator
      workingCheckout: ./.conductor/data/water-cooler-checkout
      remoteUrl: https://example.invalid/team/water-cooler.git
      schedule: '0 9,11,13,15,17 * * 1-5'
      timeZone: America/Denver
```

`module` is either an absolute filesystem path or an explicit `./` path contained by the fleet
root. Bare package names, URLs, `file:` strings, and escaping relative paths are rejected. An
absolute path is an intentional trusted-owner escape hatch. `conductor validate`, `doctor`, and
the parent `start` preflight resolve and stat the path but deliberately never import it. The
foreground Conductor process is the single execution point. Foreground and daemon starts resolve
the file from the configured fleet root, not the caller's current working directory.

The executable ESM file default-exports one synchronous factory:

```ts
import type { ConductorIntegrationFactory } from 'agent-conductor';

const createIntegration: ConductorIntegrationFactory = ({ fleetDir, options }) => {
  return new RepositoryWatcher({
    fleetDir,
    options: parseRepositoryWatcherOptions(options),
  });
};

export default createIntegration;
```

The factory receives the resolved `fleetDir` plus a shallow-frozen copy of the opaque `options`
mapping. Shallow freezing is mutation hygiene, not isolation: copy and validate nested values
before normalizing them. Conductor invokes factories once per entry, in configuration order.
Factories must perform pure synchronous construction only—do not start timers, open handles, or
perform Git/network work there. Put all resource acquisition in `start()`. If a later module
fails, Supervisor never exists and objects returned by earlier factories do not receive
`stop()`. Imports, factory errors, thenable returns, and invalid return values fail startup before
readiness instead of silently omitting a configured service.

Module and options changes require a deliberate Conductor restart. There is no discovery,
package-name resolution, TypeScript transpilation, hot reload, compatibility manifest, or secret
system.

### Direct embedding

Inject instances explicitly:

```ts
const supervisor = new Supervisor(fleetDir, {
  integrations: [new RepositoryWatcher(watcherConfig)],
});
```

These are trusted in-process extensions, not security-sandboxed plugins. Their packages have the
same process authority as the embedding host even though the Conductor context is deliberately
narrow. The host owns dependency resolution, configuration, and secrets. Direct construction
with `new Supervisor(...)` intentionally does not read or execute `supervisor.yaml.integrations`;
only the stock foreground CLI loads those configured files. Use `supervisor.integrationStatus()`
for the stable structured status snapshot.

## Event subscribers

Implement `ConductorEventSubscriber` when a plugin needs typed fleet facts without polling or
terminal tailing. Inject subscribers with `new Supervisor(fleetDir, { eventSubscribers: [...] })`.
They are observation-only and best-effort; they do not replace commands, operations, or channels.
Use a background integration instead when the same trusted in-process component also needs
protected session delivery, lifecycle, health, or durable state.
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
- background integration abort fencing, startup/shutdown failure isolation, stable delivery keys,
  cursor recovery, and owner-only state paths when applicable;
- subscriber ordering, failure isolation, and sequence-gap reconciliation when it consumes
  Conductor events; and
- compilation and execution from a temporary consumer project installed from the packed
  Conductor tarball.

Real-service or real-runtime tests belong in an explicit manual shakedown and must not require
credentials in the automated suite.
