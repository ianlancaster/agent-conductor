import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChannelAdapter, ChannelMessage } from '../channels/types.js';
import { renderChannelMessage } from '../channels/render.js';
import { buildConfiguredChannels } from '../channels/configured.js';
import { resolveFleetEnvironment } from '../config/environment.js';
import { fleetSlug } from '../config/instance.js';
import { sessionConfigDir, loadSessionConfigs, loadSupervisorConfig } from '../config/loader.js';
import { resolveFleetDataDir, resolveFleetPaths } from '../config/paths.js';
import type { SessionConfig, SupervisorConfig } from '../config/schema.js';
import { ConfigWatcher } from '../config/watcher.js';
import { initLogger, log } from '../logger.js';
import { ConductorMcpServer } from '../mcp/server.js';
import { buildMcpTools } from '../mcp/tools.js';
import { ClaudeCodeRuntime } from '../runtimes/claude-code/index.js';
import { CodexRuntime } from '../runtimes/codex/index.js';
import type { SessionRuntime } from '../runtimes/types.js';
import { Store } from '../store/index.js';
import { ITermBackend } from '../terminals/iterm/index.js';
import { TmuxBackend } from '../terminals/tmux/index.js';
import type { TerminalBackend } from '../terminals/types.js';
import { PACKAGE_VERSION } from '../version.js';
import { ConductorEventBus } from '../events/bus.js';
import { eventJournalDegradedPath } from '../events/journal.js';
import type { ConductorEventSubscriber } from '../events/types.js';
import type { ConductorIntegration } from '../integrations/types.js';
import { configuredRunbookRegistry, type RunbookRegistry } from '../runbooks/registry.js';
import { CommandRouter } from './commands.js';
import { DeliveryQueue } from './delivery.js';
import { ConductorDocumentation } from './documentation.js';
import { HealthMonitor } from './health.js';
import { identityFor } from './identity.js';
import { Lifecycle } from './lifecycle.js';
import { FleetLock } from './lock.js';
import { Messaging } from './messaging.js';
import { ConductorOperations } from './operations.js';
import { OperatorRequests } from './operator-requests.js';
import { RunbookAdoptions } from './runbook-adoptions.js';
import { StallSentinelRouter } from './sentinel.js';
import { SessionStateManager } from './state.js';
import {
  formatFleetStatusReport,
  launchTimeFieldEdits,
  type ModelDrift,
  type OperatorReach,
  resolvedSessionEffort,
  resolvedSessionModel,
  statusReport,
} from './status.js';
import { observePaneActivity } from './activity.js';
import { ShepherdManager } from './shepherd-manager.js';
import { IntegrationManager } from './integration-manager.js';

const PACKAGE_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');

/** Repeat interval while a queue stays blocked. */
const UNDELIVERABLE_REWARN_MS = 30 * 60 * 1000;
const SENTINEL_WORKSPACE_KEY = 'sentinel.codename';
const FLEET_WATCH_ENABLED_WORKSPACE_KEY = 'sentinel.fleetWatchEnabled';
const LEGACY_FLEET_WATCHES_WORKSPACE_KEY = 'sentinel.fleetWatches';
import { Scheduler } from './scheduler.js';

export interface SupervisorStartOptions {
  startAll?: boolean;
}

export interface SupervisorOptions {
  /** Additional operator adapters. They receive the same canonical command surface as the built-ins. */
  channels?: ChannelAdapter[];
  /** Disable environment-configured built-in adapters, primarily for embedding and tests. */
  includeConfiguredChannels?: boolean;
  /** Supply inherited fallback values; the fleet's .conductor/.env remains authoritative. */
  env?: NodeJS.ProcessEnv;
  /** Override Claude's state path when embedding the conductor (primarily for isolated tests). */
  claudeJsonPath?: string;
  /** Inject a terminal adapter when embedding or testing. */
  terminalBackend?: TerminalBackend;
  /**
   * Inject session runtimes. An injected runtime may decorate or replace a
   * built-in by name; duplicate names within this array are rejected.
   */
  runtimes?: SessionRuntime[];
  /** Live, observation-only event consumers for embedding hosts and plugins. */
  eventSubscribers?: ConductorEventSubscriber[];
  /** Trusted deterministic background integrations owned by this Supervisor lifecycle. */
  integrations?: ConductorIntegration[];
}

/** Thin orchestrator: constructs the modules, wires the seams, owns the loops. */
export class Supervisor {
  readonly config: SupervisorConfig;
  private sessions: Map<string, SessionConfig>;

  private readonly store: Store;
  private readonly runbooks: RunbookRegistry;
  private readonly documentation: ConductorDocumentation;
  private readonly eventBus: ConductorEventBus;
  private readonly states: SessionStateManager;
  private readonly backend: TerminalBackend;
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly delivery: DeliveryQueue;
  private readonly lifecycle: Lifecycle;
  private readonly health: HealthMonitor;
  private readonly sentinel: StallSentinelRouter;
  private readonly messaging: Messaging;
  private readonly operations: ConductorOperations;
  private readonly operatorRequests: OperatorRequests;
  private readonly commands: CommandRouter;
  private readonly mcpServer: ConductorMcpServer;
  private readonly scheduler: Scheduler;
  private readonly watcher: ConfigWatcher;
  private readonly shepherd: ShepherdManager;
  private readonly integrations: IntegrationManager;
  private readonly channelCandidates: ChannelAdapter[];
  private readonly channels: ChannelAdapter[] = [];
  private readonly channelFailures = new Map<string, string>();
  private readonly env: NodeJS.ProcessEnv;
  private readonly lock: FleetLock;
  /** mtime of the supervisor config actually loaded into this process. */
  private readonly supervisorConfigFile: string;
  private supervisorConfigMtimeMs: number | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private readonly undeliverableWarnedAt = new Map<string, number>();
  /** Operator notifications this run that reached no channel and no console. */
  private undeliveredOperatorNotices = 0;
  private undeliveredOperatorSince: string | undefined;
  /** Last inbound operator interaction this run; null until a human acts. */
  private lastOperatorInteractionAt: string | undefined;
  private operatorAttached: boolean | undefined;

  constructor(
    readonly baseDir: string,
    options: SupervisorOptions = {},
  ) {
    this.env = resolveFleetEnvironment(baseDir, options.env ?? process.env);
    this.config = loadSupervisorConfig(baseDir, this.env);
    this.shepherd = new ShepherdManager(this.config.shepherd);
    const dataDir = resolveFleetDataDir(baseDir, this.config.paths.dataDir);
    const fleetPaths = resolveFleetPaths(baseDir);
    initLogger({ level: this.config.supervisor.logLevel, filePath: join(dataDir, 'conductor.log') });
    this.lock = new FleetLock(join(dataDir, 'conductor.lock'), process.pid, baseDir);
    const configuredChannels =
      (options.includeConfiguredChannels ?? true)
        ? buildConfiguredChannels(this.config, this.env)
        : { channels: [], unavailable: [] };
    this.channelCandidates = [...(options.channels ?? []), ...configuredChannels.channels];
    for (const unavailable of configuredChannels.unavailable) {
      this.channelFailures.set(unavailable.name, unavailable.reason);
    }

    this.sessions = loadSessionConfigs(baseDir, {
      tolerant: true,
      defaultRuntime: this.config.defaults.runtime,
    });
    const protocolPath = this.resolveProtocolPath();
    this.runtimes.set(
      'claude-code',
      new ClaudeCodeRuntime({
        config: this.config.runtimes.claudeCode,
        protocolPath,
        claudeJsonPath: options.claudeJsonPath,
      }),
    );
    this.runtimes.set(
      'codex',
      new CodexRuntime({
        config: this.config.runtimes.codex,
        baseDir,
        protocolPath,
        sessionDataDir: join(dataDir, 'sessions'),
      }),
    );
    const injectedRuntimeNames = new Set<string>();
    for (const runtime of options.runtimes ?? []) {
      const name = runtime.name.trim();
      if (name.length === 0 || name !== runtime.name) {
        throw new Error('Injected runtime names must be non-empty and must not have surrounding whitespace.');
      }
      if (name === 'cc') throw new Error("Injected runtime name 'cc' is reserved as the claude-code command alias.");
      if (injectedRuntimeNames.has(name)) throw new Error(`Duplicate injected runtime name '${name}'.`);
      injectedRuntimeNames.add(name);
      this.runtimes.set(name, runtime);
    }
    this.validateRuntimeReferences();
    const fleetId = fleetSlug(baseDir);
    this.runbooks = configuredRunbookRegistry(baseDir, this.config, PACKAGE_VERSION, join(PACKAGE_ROOT, 'runbooks'));
    this.documentation = new ConductorDocumentation({
      referencePath: join(PACKAGE_ROOT, 'docs', 'agent-guide.md'),
      fleetDir: baseDir,
      fleetPaths,
      runbooks: this.runbooks,
    });
    this.store = new Store(join(dataDir, 'conductor.db'));
    const journalDegradedMarker = eventJournalDegradedPath(dataDir);
    this.eventBus = new ConductorEventBus(fleetId, options.eventSubscribers, {
      ...(this.config.events.journal.enabled ? { journal: this.store } : {}),
      initialJournalDegraded: this.config.events.journal.enabled && existsSync(journalDegradedMarker),
      onJournalFailure: () => {
        if (existsSync(journalDegradedMarker)) return;
        writeFileSync(journalDegradedMarker, `${JSON.stringify({ occurredAt: new Date().toISOString() })}\n`, {
          flag: 'wx',
        });
      },
    });
    this.states = new SessionStateManager(
      this.store,
      this.config.defaults.auto,
      this.eventBus,
      this.config.supervisor.maxTagLength,
    );
    const storedSentinel = this.store.getWorkspaceValue<string | null>(SENTINEL_WORKSPACE_KEY);
    const sentinelCodename =
      storedSentinel === undefined ? this.config.sentinel.codename : (storedSentinel ?? undefined);
    const storedFleetWatchEnabled = this.store.getWorkspaceValue<unknown>(FLEET_WATCH_ENABLED_WORKSPACE_KEY);
    const legacyFleetWatches = this.store.getWorkspaceValue<unknown>(LEGACY_FLEET_WATCHES_WORKSPACE_KEY);
    const fleetWatchEnabled =
      typeof storedFleetWatchEnabled === 'boolean'
        ? storedFleetWatchEnabled
        : Array.isArray(legacyFleetWatches) && legacyFleetWatches.length > 0;
    if (storedFleetWatchEnabled === undefined && fleetWatchEnabled) {
      this.store.setWorkspaceValue(FLEET_WATCH_ENABLED_WORKSPACE_KEY, true);
    }
    if (legacyFleetWatches !== undefined) this.store.deleteWorkspaceValue(LEGACY_FLEET_WATCHES_WORKSPACE_KEY);

    this.backend =
      options.terminalBackend ??
      (this.config.terminal.backend === 'tmux'
        ? new TmuxBackend({
            store: this.store,
            config: {
              sessionName: this.config.terminal.tmux.sessionName,
              windowName: this.config.terminal.windowName,
              fleetId,
              paneBorders: this.config.terminal.tmux.paneBorders,
              // Launched from inside tmux → panes join the operator's own
              // session/window (like iTerm splitting the conductor window).
              ...(this.config.terminal.tmux.attachToCurrent &&
              this.env.TMUX !== undefined &&
              this.env.TMUX_PANE !== undefined
                ? { attachPane: this.env.TMUX_PANE }
                : {}),
            },
          })
        : new ITermBackend({
            store: this.store,
            config: { ...this.config.terminal.iterm, windowName: this.config.terminal.windowName, fleetId },
            env: this.env,
          }));

    this.delivery = new DeliveryQueue({
      backend: this.backend,
      runtimeFor: (session) => this.runtimeFor(session),
      runtimeCandidates: (session) => this.runtimeCandidates(session),
      getPane: (session) => this.lifecycle.getPane(session),
      lifecycleBusy: (session) => this.lifecycle.operationInFlight(session) !== undefined,
      onRuntimeObserved: (session) => {
        this.markRuntimeObserved(session);
      },
      onRuntimeDetected: (session, runtimeName) => {
        this.correctActiveRuntime(session, runtimeName);
      },
      onSubmitting: (session) => {
        const boundary = this.health.captureTurnBoundary();
        return () => {
          if (!this.health.markTurnActive(session, boundary)) return;
          if (this.states.get(session)?.running === true) this.states.setActivity(session, 'working');
          this.sentinel.noteWorking(session);
        };
      },
      config: this.config.messaging,
    });

    this.lifecycle = new Lifecycle({
      store: this.store,
      backend: this.backend,
      states: this.states,
      runtimes: this.runtimes,
      sessions: () => this.sessions,
      identityFor: (codename) =>
        identityFor(codename, { host: this.config.mcp.host, port: this.config.mcp.port, dataDir }),
      config: {
        defaultPlacement: this.config.defaults.placement,
        defaultRuntime: this.config.defaults.runtime,
        defaultEfforts: {
          'claude-code':
            this.config.runtimes.claudeCode.defaultEffort ??
            this.config.runtimes.claudeCode.env.CLAUDE_CODE_EFFORT_LEVEL,
          'codex': this.config.runtimes.codex.defaultEffort,
        },
        defaultBypassPermissions: this.config.defaults.bypassPermissions,
        markerFile: this.config.spawn.markerFile,
        spawnDirPattern: this.config.spawn.dirPattern,
        spawnTemplates: this.config.spawn.templates,
        templateCloneTimeoutMs: this.config.spawn.templateCloneTimeoutSeconds * 1000,
      },
      baseDir,
      sessionConfigDir: sessionConfigDir(baseDir),
      reloadSessions: (teardownSession) => {
        this.reloadSessions(teardownSession);
      },
      refreshSessions: () => {
        this.watcher.checkNow();
      },
      supervisionReset: (session) => {
        this.health.reset(session);
        if (this.states.get(session)?.activity === 'working') this.health.markTurnActive(session);
        this.sentinel.reset(session);
      },
      observeActivity: (session, pane) =>
        observePaneActivity(this.backend, this.runtimeFor(session), session, pane, this.config.health.captureLines),
      reconcileActivity: (session, pane) => this.health.reconcileActivity(session, pane),
      onRunning: (session) => {
        void this.recoverPendingMessages(session);
      },
      events: this.eventBus,
    });

    this.messaging = new Messaging({
      store: this.store,
      delivery: this.delivery,
      states: this.states,
      sessions: () => this.sessions,
      // Auto-start on delivery is a lifecycle transition like any other, and
      // it should say so on the seat it is claiming.
      startSession: (codename, opts) => this.lifecycle.start(codename, { ...opts, initiator: 'delivery' }),
      events: this.eventBus,
    });
    this.integrations = new IntegrationManager({
      integrations: options.integrations,
      dataDir,
      events: this.eventBus,
      sendToSession: (integrationName, codename, message, idempotencyKey) =>
        this.messaging.sendIntegrationToSession(integrationName, codename, message, idempotencyKey),
    });

    this.operatorRequests = new OperatorRequests({
      store: this.store,
      messaging: this.messaging,
      channelSend: (message) => this.channelSend(message),
      events: this.eventBus,
      allowOptions: () => this.config.messaging.allowOperatorRequestOptions,
    });

    this.sentinel = new StallSentinelRouter({
      config: {
        captureLines: this.config.health.captureLines,
        suppressWindowMs: this.config.health.suppressWindowMs,
        suppressSimilarity: this.config.health.suppressSimilarity,
        sentinelCodename,
        fleetStallThresholdSeconds: Math.floor(this.config.health.fleetStallConfirmMs / 1000),
      },
      backend: this.backend,
      runtimeFor: (session) => this.runtimeFor(session),
      getPane: (session) => this.lifecycle.getPane(session),
      isAuto: (session) => this.states.isAuto(session),
      isPaused: (session) => this.states.isPaused(session),
      activityFor: (session) => this.states.get(session)?.activity,
      isEphemeral: (session) => this.sessions.get(session)?.ephemeral === true,
      isActive: async (session) => {
        // State can lag behind reality after a runtime conversation boundary
        // (notably Claude /clear). Route against authoritative terminal-process
        // liveness, using the same reconciliation as /status.
        await this.lifecycle.reconcile(session);
        return this.states.get(session)?.running === true;
      },
      deliver: (session, text) => this.delivery.deliverOrQueue(session, text),
      notifyOperator: (text) => this.channelSend({ text }),
      logEvent: (session, event, detail) => {
        this.store.logHealthEvent(session, event, detail);
      },
      recentMessages: (session, limit) => this.store.getRecentMessageActivity(session, limit),
      initialFleetWatchEnabled: fleetWatchEnabled,
      initialSessions: this.sessions.keys(),
      onFleetWatchChanged: (enabled) => {
        this.store.setWorkspaceValue(FLEET_WATCH_ENABLED_WORKSPACE_KEY, enabled);
      },
      events: this.eventBus,
    });

    this.health = new HealthMonitor({
      config: this.config.health,
      backend: this.backend,
      runtimeFor: (session) => this.runtimeFor(session),
      getPane: (session) => this.lifecycle.getPane(session),
      getActiveSessions: () => this.states.activeSessions(),
      onRuntimeObserved: (session) => {
        if (this.markRuntimeObserved(session)) void this.delivery.drainNow();
      },
      observeActivity: (session, pane) =>
        observePaneActivity(this.backend, this.runtimeFor(session), session, pane, this.config.health.captureLines),
      onStall: (session, kind, info) => {
        // A stall kind is causal evidence for the sentinel, not a separate
        // mechanical activity state. A live runtime that is not working is idle.
        this.states.setActivity(session, 'idle');
        void this.sentinel.handleStall(session, kind, info);
      },
      onWorking: (session) => {
        if (this.states.get(session)?.running === true) this.states.setActivity(session, 'working');
        this.sentinel.noteWorking(session);
      },
      onSessionEnd: (session) => {
        this.lifecycle.handleSessionEnd(session);
      },
      logEvent: (session, event, detail) => {
        this.store.logHealthEvent(session, event, detail);
      },
    });

    this.operations = new ConductorOperations({
      lifecycle: this.lifecycle,
      messaging: this.messaging,
      operatorRequests: this.operatorRequests,
      sentinel: this.sentinel,
      states: this.states,
      sessions: () => this.sessions,
      allowOperatorRequestOptions: () => this.config.messaging.allowOperatorRequestOptions,
      modelHints: {
        'claude-code': this.config.runtimes.claudeCode.availableModels,
        'codex': this.config.runtimes.codex.availableModels,
        ...Object.fromEntries([...injectedRuntimeNames].map((name) => [name, [] as string[]])),
      },
      effortHints: {
        'claude-code': this.config.runtimes.claudeCode.availableEfforts,
        'codex': this.config.runtimes.codex.availableEfforts,
        ...Object.fromEntries([...injectedRuntimeNames].map((name) => [name, [] as string[]])),
      },
      runtimeNames: [...this.runtimes.keys()].sort(),
      statusReport: (codename) => this.statusReport(codename),
      tail: (codename, lines) => this.tail(codename, lines),
      typeInPane: (codename, text) => this.typeInPane(codename, text),
      tailLimits: {
        defaultLines: this.config.messaging.tailDefaultLines,
        maxLines: this.config.messaging.tailMaxLines,
      },
      retitle: (session) => this.retitle(session),
      summon: (session) => this.paneAction(session, 'summon'),
      banish: (session) => this.paneAction(session, 'banish'),
      setSentinel: (session) => this.setSentinel(session),
      getDocumentation: (topic) => this.documentation.read(topic),
      runbookAdoptions: new RunbookAdoptions({
        store: this.store,
        registry: this.runbooks,
        sessions: () => this.sessions,
        events: this.eventBus,
      }),
    });
    this.commands = new CommandRouter(this.operations);

    this.scheduler = new Scheduler({
      sessions: () => this.sessions,
      isActive: async (session) => {
        // Cron may fire after Ctrl-C but before the next heartbeat/status call.
        // Inspect the terminal process before deciding to type into an
        // allegedly active session; an idle shell must be restarted instead.
        await this.lifecycle.reconcile(session);
        return this.states.get(session)?.running === true;
      },
      isPaused: (session) => this.states.isPaused(session),
      startSession: (session, opts) => this.lifecycle.start(session, { ...opts, initiator: 'schedule' }),
      stopSession: (session) => this.lifecycle.stop(session, { initiator: 'schedule' }),
      deliver: (session, text) => this.delivery.deliverOrQueue(session, text),
      events: this.eventBus,
    });

    this.mcpServer = new ConductorMcpServer({
      port: this.config.mcp.port,
      host: this.config.mcp.host,
      keepAliveTimeoutMs: this.config.mcp.keepAliveTimeoutMs,
      onEvent: (session, body) => {
        this.handleRuntimeEvent(session, body);
      },
      onCommand: (line, interactionId) => {
        this.noteOperatorInteraction();
        return this.commands.route(line, `cli:${interactionId}`);
      },
      tools: buildMcpTools(this.operations),
    });

    this.watcher = new ConfigWatcher(sessionConfigDir(baseDir));
    this.watcher.onChange(() => this.reloadSessions());
    this.supervisorConfigFile = fleetPaths.supervisorFile;
    this.supervisorConfigMtimeMs = this.supervisorConfigMtime();

    for (const [codename, session] of this.sessions) {
      this.states.register(codename, this.lifecycle.isAgentProject(session), session.auto);
    }
  }

  private validateRuntimeReferences(): void {
    const available = [...this.runtimes.keys()].sort();
    const availableText = available.join(', ');
    if (!this.runtimes.has(this.config.defaults.runtime)) {
      throw new Error(
        `Fleet default selects unknown runtime '${this.config.defaults.runtime}'. Registered runtimes: ${availableText}.`,
      );
    }
    for (const session of this.sessions.values()) {
      if (!this.runtimes.has(session.runtime)) {
        throw new Error(
          `Session '${session.codename}' selects unknown runtime '${session.runtime}'. Registered runtimes: ${availableText}.`,
        );
      }
    }
  }

  async start(opts: SupervisorStartOptions = {}): Promise<void> {
    this.lock.acquire();
    try {
      await this.startLocked(opts);
    } catch (err) {
      // A failed startup must not leave the fleet dir locked.
      this.lock.release();
      throw err;
    }
  }

  private async startLocked(opts: SupervisorStartOptions): Promise<void> {
    // A subscriber attached from boot receives the complete roster before any
    // surviving panes can produce started/ready/activity events.
    for (const codename of this.sessions.keys()) {
      this.eventBus.emit({ type: 'session.registered', session: codename, cause: 'startup' });
    }
    this.operatorRequests.recoverStaleClaims();
    const discardedMessages = this.store.cancelPendingLocalMessagesOnRestart();
    for (const message of discardedMessages) {
      this.eventBus.emit({
        type: 'message.cancelled',
        receiptId: message.id,
        sender: message.sender,
        recipient: message.recipient,
        reason: 'conductor-restarted',
      });
    }
    if (discardedMessages.length > 0) {
      log().info(
        'delivery',
        `Cancelled ${String(discardedMessages.length)} queued local message(s) from the previous conductor run.`,
      );
    }
    log().info('supervisor', `Starting agent-conductor (backend: ${this.backend.name})`);
    await this.backend.init();

    // Re-adopt panes that survived a conductor restart.
    try {
      for (const [codename, pane] of await this.backend.rediscover()) {
        if (this.sessions.has(codename)) {
          await this.lifecycle.adopt(codename, pane);
          void this.retitle(codename);
        }
      }
      // Rediscovery proves that panes survived, not that their agent processes
      // did. A pane may now be an idle shell after Ctrl-C while the conductor
      // was down.
      await this.lifecycle.reconcile();
      // Persisted state can say "running" for sessions whose panes did NOT
      // survive (window closed, tmux server gone, reboot). Those are dead —
      // reconcile to stopped, or status reports ghosts as stalled/working.
      for (const codename of this.states.activeSessions()) {
        if (this.lifecycle.getPane(codename) === undefined) {
          log().info('supervisor', `${codename}: no surviving pane — marking stopped`);
          this.lifecycle.handleSessionEnd(codename);
        }
      }
    } catch (err) {
      // Rediscovery itself failed — pane liveness is UNKNOWN, so leave the
      // persisted state alone rather than declaring live sessions dead.
      log().warn('supervisor', `Pane rediscovery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await this.connectChannels();
      // /health is the CLI's readiness signal. Expose it only after every
      // optional channel has either connected or been explicitly marked
      // unavailable, so `conductor start` cannot observe a transient false-ready
      // process that is about to roll startup back.
      await this.mcpServer.start();
    } catch (error) {
      await this.rollbackChannelStartup();
      await this.mcpServer.stop();
      throw error;
    }

    const heartbeatMs = this.config.supervisor.heartbeatIntervalSeconds * 1000;
    this.heartbeatTimer = setInterval(() => {
      this.checkSupervisorConfigDrift();
      this.publishOperatorAttachment();
      void this.checkUndeliverableQueues();
      void this.health.heartbeat();
      // The sentinel is excluded from fleet watch by design, so without this it
      // is the one seat nothing observes until a stall needs routing.
      void this.sentinel.checkSentinelHealth();
    }, heartbeatMs);
    this.heartbeatTimer.unref();

    // Publish the initial attachment state once channels have settled, so the
    // journal carries a value from boot rather than only from the first change.
    this.publishOperatorAttachment();
    this.watcher.start(heartbeatMs);
    this.scheduler.rebuild();
    await this.shepherd.start();

    if (opts.startAll === true) {
      for (const codename of this.sessions.keys()) {
        try {
          await this.lifecycle.start(codename);
        } catch (err) {
          log().error('supervisor', `${codename} failed to start: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    await this.integrations.start();

    // Initial registered sessions begin as stopped until surviving panes have
    // been rediscovered and optional start-all launches finish. Channels must
    // also be ready before a threshold-zero alert can be emitted.
    this.sentinel.activateFleetWatch();

    // The sentinel is optional extra functionality — never nag about its
    // absence. A configured-but-missing codename IS a config error, though.
    const sentinel = this.sentinel.sentinelCodename();
    if (sentinel !== undefined && !this.sessions.has(sentinel)) {
      log().warn('supervisor', `Configured sentinel '${sentinel}' has no session config.`);
    }
    log().info('supervisor', `Ready — ${this.sessions.size} session(s) registered.`);
    // Say it at boot as well as on demand. A detached conductor with no channel
    // enabled will detect stalls, fleet-wide darkness and a dead sentinel, and
    // deliver none of it. The warning also lands in the log, which is the same
    // dead end — but an operator reads the log at startup, and this is the last
    // moment before the fleet starts running unattended.
    if (this.channels.length === 0 && this.mcpServer.feedClientCount() === 0) {
      log().warn(
        'supervisor',
        'No operator channel is enabled and no console is attached — every alarm this fleet raises ' +
          '(stalls, fleet-down, sentinel failure) will terminate in this log and reach nobody. ' +
          'Attach with `conductor console`, or enable Telegram or Slack.',
      );
    }
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.watcher.stop();
    this.scheduler.stop();
    this.health.stop();
    this.sentinel.stop();
    await this.integrations.stop();
    await this.shepherd.stop();
    this.delivery.stop();
    const stoppedChannels = this.channels.splice(0);
    const stopResults = await Promise.allSettled(stoppedChannels.map((channel) => channel.stop()));
    for (const [index, result] of stopResults.entries()) {
      if (result.status === 'rejected') {
        log().warn(
          'supervisor',
          `channel ${stoppedChannels[index]?.name ?? String(index)} stop failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        );
      }
    }
    await this.mcpServer.stop();
    this.store.close();
    this.lock.release();
    log().info('supervisor', 'Stopped (session panes left running).');
  }

  /** Route an operator command line (used by the interactive console). */
  command(line: string): Promise<string> {
    this.noteOperatorInteraction();
    return this.commands.route(line);
  }

  /** Force a config reload synchronously. Exposed for tests (normally driven by the watcher). */
  reloadSessionsForTest(): void {
    this.reloadSessions();
  }

  /**
   * @param audience `session` omits operator reachability. Whether a human is
   * attached is deliberately not observable by managed sessions: an agent that
   * can tell would be able to behave differently when unobserved, and that is
   * not a capability to hand out as a side effect of a status field.
   */
  statusReport(codename?: string, audience: 'operator' | 'session' = 'operator'): string {
    const report = statusReport(
      {
        sessions: () => this.sessions,
        getState: (name) => this.states.get(name),
        runtimeFor: (name) => this.displayRuntimeFor(name),
        modelFor: (name) => this.displayModelFor(name),
        declaredModelFor: (name) => this.declaredModelFor(name),
        modelDriftFor: (name) => this.modelDriftFor(name),
        effortFor: (name) => this.displayEffortFor(name),
        declaredEffortFor: (name) => this.declaredEffortFor(name),
        sentinelCodename: () => this.sentinel.sentinelCodename(),
        processObservation: (name) => this.lifecycle.processObservation(name),
        operationInFlight: (name) => this.lifecycle.operationInFlight(name),
      },
      codename,
      { shepherdRecipient: this.shepherd.recipientSession() },
    );
    if (codename !== undefined) return report;
    const shepherd = this.shepherd.status();
    return formatFleetStatusReport(report, {
      fleetWatch: this.sentinel.fleetWatchStatus(),
      shepherdOnline: shepherd.state === 'healthy',
      ...(audience === 'operator' ? { operatorReach: this.operatorReach() } : {}),
      eventJournal: this.eventBus.journalStatus(),
      integrations: this.integrations.status(),
    });
  }

  /**
   * Whether anything this fleet raises can reach a human right now. Computed at
   * read time, not at boot: a console can attach or detach at any moment, so a
   * value captured at startup would be exactly the kind of stale fact that
   * makes an instrument lie.
   */
  operatorReach(): OperatorReach {
    const channels = this.channels.map((channel) => channel.name);
    const consoles = this.mcpServer.feedClientCount();
    const backlog = {
      undelivered: this.undeliveredOperatorNotices,
      ...(this.undeliveredOperatorSince !== undefined ? { undeliveredSince: this.undeliveredOperatorSince } : {}),
    };
    if (channels.length === 0 && consoles === 0) {
      return {
        state: 'inert',
        reason:
          'no operator channel is enabled and no console is attached — enable Telegram or Slack, or run conductor console',
        channels,
        consoles,
        ...backlog,
      };
    }
    // A transport exists but has failed this run. Not inert — a retry may land —
    // but not something to describe as reachable either.
    if (this.undeliveredOperatorNotices > 0 && consoles === 0) {
      return {
        state: 'degraded',
        reason: 'every configured operator channel has failed to deliver this run',
        channels,
        consoles,
        ...backlog,
      };
    }
    return { state: 'armed', channels, consoles, ...backlog };
  }

  /** Raise an operator notification through the real send path. Tests only. */
  notifyOperatorForTest(text: string): Promise<boolean> {
    return this.channelSend({ text });
  }

  /** Structured companion status for embedding and tests. */
  shepherdStatus(): ReturnType<ShepherdManager['status']> {
    return this.shepherd.status();
  }

  /** Structured status for trusted embedding integrations. */
  integrationStatus(): ReturnType<IntegrationManager['status']> {
    return this.integrations.status();
  }

  private async tail(codename: string, lines: number): Promise<string> {
    const pane = this.lifecycle.getPane(codename);
    if (pane === undefined) return `${codename} has no active pane.`;
    return this.backend.capture(pane, lines);
  }

  /** Raw escape hatch: intentionally bypasses composer detection and queuing. */
  private async typeInPane(codename: string, text: string): Promise<string> {
    if (!this.sessions.has(codename)) return `Unknown session: ${codename}`;
    const pane = this.lifecycle.getPane(codename);
    if (pane === undefined) return `${codename} has no active pane.`;
    try {
      await this.backend.run(pane, text);
      return `Typed into ${codename}'s pane.`;
    } catch (err) {
      return `Failed to type into ${codename}'s pane: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Report recipients whose queues have stopped draining. Delivery refusing to
   * write into an occupied or unclassifiable pane is correct behaviour; doing
   * so indefinitely without telling anyone is not, and it is how a wedged
   * sentinel took fleet-wide supervision down for hours while every status
   * field read healthy.
   *
   * Reported straight to the operator, never through the sentinel: routing an
   * alarm about a dead router through that router would be the same defect.
   */
  private async checkUndeliverableQueues(): Promise<void> {
    const blocked = this.delivery.blockedDeliveries();
    const blockedSessions = new Set(blocked.map((entry) => entry.session));
    for (const session of [...this.undeliverableWarnedAt.keys()]) {
      if (blockedSessions.has(session)) continue;
      this.undeliverableWarnedAt.delete(session);
      await this.channelSend({ text: `✅ Delivery to ${session} recovered — its queued messages are draining again.` });
    }

    const now = Date.now();
    for (const entry of blocked) {
      const isSentinel = this.sentinel.sentinelCodename() === entry.session;
      const threshold = isSentinel
        ? this.config.messaging.sentinelUndeliverableWarnMs
        : this.config.messaging.undeliverableWarnMs;
      const blockedForMs = now - entry.since;
      if (blockedForMs < threshold) continue;
      const warnedAt = this.undeliverableWarnedAt.get(entry.session);
      if (warnedAt !== undefined && now - warnedAt < UNDELIVERABLE_REWARN_MS) continue;
      this.undeliverableWarnedAt.set(entry.session, now);
      const minutes = String(Math.floor(blockedForMs / 60_000));
      const detail = `${String(entry.pending)} message(s) queued, undeliverable for ${minutes} minute(s) (${entry.skipReason})`;
      this.store.logHealthEvent(entry.session, 'delivery_blocked', detail);
      await this.channelSend({
        text: isSentinel
          ? `🚨 Sentinel ${entry.session} is not accepting messages — ${detail}. Stall routing reaches the sentinel as messages, so fleet-wide stall routing is not being delivered. Check its pane: a session waiting on a prompt cannot receive.`
          : `⚠️ ${entry.session} is not accepting messages — ${detail}. Its pane is holding a prompt or a draft; nothing will arrive until that clears.`,
      });
    }
  }

  /**
   * Publish whether any operator surface is attached, and when a human last
   * acted. Whether anyone is listening decides what deferring to a human costs:
   * with an operator attached an unanswered question is a pause, and unattended
   * it is a termination with no timeout and no signal.
   *
   * Emitted as an observation for host applications and the event journal, and
   * deliberately NOT readable by managed sessions. A session that could see it
   * would change its own behaviour on the basis of the measurement, which turns
   * a recorded condition into an intervention.
   */
  private publishOperatorAttachment(): void {
    const surfaces = [
      ...(this.mcpServer.feedClientCount() > 0 ? ['console'] : []),
      ...this.channels.map((channel) => channel.name),
    ];
    const attached = surfaces.length > 0;
    if (this.operatorAttached === attached) return;
    this.operatorAttached = attached;
    this.eventBus.emit({
      type: 'operator.attachment.changed',
      attached,
      surfaces,
      lastInteractionAt: this.lastOperatorInteractionAt ?? null,
    });
  }

  /** Any inbound operator action, from any surface. */
  private noteOperatorInteraction(): void {
    this.lastOperatorInteractionAt = new Date().toISOString();
  }

  private async recoverPendingMessages(codename?: string): Promise<void> {
    try {
      await this.messaging.recoverPendingMessages(codename);
    } catch (err) {
      log().error(
        'delivery',
        `${codename ?? 'fleet'}: current-run queued delivery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private runtimeFor(session: string): SessionRuntime | undefined {
    const runtime = this.lifecycle.runtimeNameFor(session);
    return runtime !== undefined ? this.runtimes.get(runtime) : undefined;
  }

  private runtimeCandidates(session: string): SessionRuntime[] {
    const primary = this.runtimeFor(session);
    return [
      ...(primary === undefined ? [] : [primary]),
      ...[...this.runtimes.values()].filter((runtime) => runtime.name !== primary?.name),
    ];
  }

  private correctActiveRuntime(session: string, runtimeName: string): void {
    const state = this.states.get(session);
    if (state?.running !== true || state.runtime === runtimeName || !this.runtimes.has(runtimeName)) return;
    log().warn(
      'delivery',
      `${session}: visible composer identifies ${runtimeName}; correcting stale active runtime ${state.runtime ?? '(unknown)'}`,
    );
    // Neither the old runtime's effort nor its model can be assumed portable to
    // the process we just identified, and we did not launch that process, so its
    // model is unknown rather than inherited. Runtime defaults remain available
    // to status rendering.
    this.states.setRunSettings(session, { runtime: runtimeName, effort: undefined, model: undefined });
  }

  private displayRuntimeFor(session: string): SessionConfig['runtime'] | undefined {
    const configured = this.sessions.get(session)?.runtime;
    return this.states.get(session)?.running === true ? this.lifecycle.runtimeNameFor(session) : configured;
  }

  /**
   * The model actually in force: the recorded launch while a process is running,
   * otherwise what the config would resolve to on the next launch. A running
   * session whose launch was never recorded reports the launch as unknown rather
   * than falling back to the declaration, which is the substitution that let a
   * seat run one model for twenty hours under a config naming another.
   */
  private displayModelFor(session: string): string | undefined {
    const state = this.states.get(session);
    if (state?.running === true) return state.model;
    return this.declaredModelFor(session);
  }

  /** What the config resolves to for the next launch, independent of any live process. */
  private declaredModelFor(session: string): string | undefined {
    const configured = this.sessions.get(session);
    const runtime = this.displayRuntimeFor(session);
    if (configured === undefined || runtime === undefined) return undefined;
    return resolvedSessionModel(configured, runtime, {
      'claude-code': this.config.runtimes.claudeCode.defaultModel,
      'codex': this.config.runtimes.codex.defaultModel,
    });
  }

  /**
   * Named drift between a running process and its declaration. Launch-time
   * fields are frozen at launch, so a config edit under a live session changes
   * only what the NEXT launch will do. Reporting the declaration as though it
   * described the process is what made this invisible.
   */
  private modelDriftFor(session: string): ModelDrift | undefined {
    const state = this.states.get(session);
    if (state?.running !== true) return undefined;
    const declared = this.declaredModelFor(session);
    if (declared === undefined || state.model === declared) return undefined;
    return { declared, launched: state.model, launchedAt: state.launchedAt };
  }

  /** Effort in force: the launched value while running, the next launch's while stopped. */
  private displayEffortFor(session: string): string | undefined {
    const state = this.states.get(session);
    const declared = this.declaredEffortFor(session);
    return state?.running === true ? (state.effort ?? declared) : declared;
  }

  /** What the config resolves to for the next launch, independent of any live process. */
  private declaredEffortFor(session: string): string | undefined {
    const configured = this.sessions.get(session);
    const runtime = this.displayRuntimeFor(session);
    if (configured === undefined || runtime === undefined) return undefined;
    return resolvedSessionEffort(configured, runtime, {
      'claude-code':
        this.config.runtimes.claudeCode.defaultEffort ?? this.config.runtimes.claudeCode.env.CLAUDE_CODE_EFFORT_LEVEL,
      'codex': this.config.runtimes.codex.defaultEffort,
    });
  }

  private handleRuntimeEvent(session: string, body: unknown): void {
    const runtime = this.runtimeFor(session);
    if (runtime === undefined) return;
    const parsed = runtime.parseEvent(body);
    if (parsed === null) return;
    log().debug('events', `${session}: ${parsed.type}${parsed.reason !== undefined ? ` (${parsed.reason})` : ''}`);
    // Any lifecycle event proves the runtime process is up — unblock queued
    // deliveries that were held to protect the launch command.
    this.markRuntimeObserved(session);
    this.health.handleEvent({ ...parsed, session, receivedAt: Date.now() });
    void this.delivery.drainNow();
  }

  /** Record either hook, foreground-process, or runtime-chrome proof of a completed launch. */
  private markRuntimeObserved(session: string): boolean {
    const wasReady = this.states.isReady(session);
    this.states.setReady(session);
    const becameReady = !wasReady && this.states.isReady(session);
    if (becameReady) {
      // Titles set before/at launch get clobbered by the shell's title escape
      // when the launch command runs; the runtime never touches the title, so
      // a rename applied once it is up sticks.
      void this.retitle(session);
    }
    return becameReady;
  }

  /** Route /summon and /banish to the backend, with capability + liveness checks. */
  private async paneAction(session: string, action: 'summon' | 'banish'): Promise<string> {
    const pane = this.lifecycle.getPane(session);
    if (pane === undefined) return `${session} has no pane — it is not running.`;
    try {
      if (action === 'summon') {
        if (this.backend.summon === undefined) return `Summon is not supported on the ${this.backend.name} backend.`;
        return await this.backend.summon(pane, session);
      }
      if (this.backend.banish === undefined) {
        return `Banish needs detachable panes — not supported on the ${this.backend.name} backend.`;
      }
      return await this.backend.banish(pane, session);
    } catch (err) {
      return `${action} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Re-apply a session's pane title: `codename` or `codename — tag`. */
  private async retitle(session: string): Promise<void> {
    const pane = this.lifecycle.getPane(session);
    if (pane === undefined) return;
    const tag = this.states.getTag(session);
    await this.backend.rename(pane, tag !== undefined && tag.length > 0 ? `${session} — ${tag}` : session, session);
  }

  setSentinel(session: string | undefined): void {
    if (session !== undefined && !this.sessions.has(session)) {
      throw new Error(`Unknown session: ${session}`);
    }
    this.sentinel.setSentinel(session);
    this.store.setWorkspaceValue(SENTINEL_WORKSPACE_KEY, session ?? null);
  }

  private async connectChannels(): Promise<void> {
    for (const [name, reason] of this.channelFailures) {
      log().error('supervisor', `${name} channel unavailable (${reason}); conductor will continue without it.`);
    }
    for (const channel of this.channelCandidates) {
      try {
        await channel.start({
          onCommand: (command, args, context) => {
            this.noteOperatorInteraction();
            return this.commands.route(
              `/${command} ${args.join(' ')}`.trim(),
              `${channel.name}:${context.conversationId}`,
            );
          },
          onFreeText: (text, context) => {
            this.noteOperatorInteraction();
            return this.commands.freeText(text, `${channel.name}:${context.conversationId}`);
          },
        });
        this.channels.push(channel);
        this.channelFailures.delete(channel.name);
        log().info('supervisor', `${channel.name} channel connected.`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        log().error(
          'supervisor',
          `${channel.name} channel failed to connect; conductor will continue without it: ${reason}`,
        );
        try {
          await channel.stop();
        } catch (stopError) {
          log().warn(
            'supervisor',
            `${channel.name} channel cleanup failed after startup error: ${stopError instanceof Error ? stopError.message : String(stopError)}`,
          );
        }
      }
    }
  }

  private async rollbackChannelStartup(): Promise<void> {
    const started = this.channels.splice(0);
    const results = await Promise.allSettled(started.map((channel) => channel.stop()));
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        log().warn(
          'supervisor',
          `channel ${started[index]?.name ?? String(index)} rollback failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        );
      }
    }
  }

  private async channelSend(message: ChannelMessage): Promise<boolean> {
    const delivered = await this.channelSendInner(message);
    // Callers legitimately ignore this boolean — an alarm has nothing better to
    // do when it cannot be raised. So the failure is counted here instead, at
    // the one choke point, and reported through status. Discarding it at ten
    // call sites is what made a fleet with no operator transport look identical
    // to one with a listening operator.
    if (!delivered) {
      this.undeliveredOperatorNotices += 1;
      this.undeliveredOperatorSince ??= new Date().toISOString();
    }
    return delivered;
  }

  private async channelSendInner(message: ChannelMessage): Promise<boolean> {
    // Attached operator consoles (conductor start / conductor console) get
    // every operator-bound message pushed over the /feed SSE stream.
    const consoleDelivered = this.mcpServer.pushToFeed(message);
    if (this.channels.length === 0) {
      if (!consoleDelivered) {
        log().info('operator', renderChannelMessage(message));
        return false;
      }
      return true;
    }
    const results = await Promise.allSettled(this.channels.map((channel) => channel.send(message)));
    let delivered = consoleDelivered;
    for (const [index, result] of results.entries()) {
      const channel = this.channels[index];
      if (result.status === 'rejected') {
        log().warn(
          'supervisor',
          `channel ${channel?.name ?? String(index)} send failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        );
      } else {
        delivered = true;
      }
    }
    return delivered;
  }

  /**
   * Session files hot-reload; supervisor settings do not. Silence there means a
   * fleet can run for hours on values nobody believes are in effect — the file
   * says `defaults.auto: true` while every session registered since boot is
   * unwatched. Report the divergence instead of leaving it invisible; applying
   * it would mean re-deriving ports, backends, and runtimes underneath live panes.
   */
  private checkSupervisorConfigDrift(): void {
    const current = this.supervisorConfigMtime();
    if (current === undefined || current === this.supervisorConfigMtimeMs) return;
    this.supervisorConfigMtimeMs = current;
    const message =
      'supervisor.yaml changed after this Conductor process started. The running fleet still uses the settings ' +
      'loaded at boot — including defaults.auto for newly registered sessions, health thresholds, and runtime ' +
      'settings. Restart Conductor to apply them.';
    log().warn('supervisor', message);
    void this.channelSend({ text: `⚠️ ${message}` });
  }

  private supervisorConfigMtime(): number | undefined {
    try {
      return statSync(this.supervisorConfigFile).mtimeMs;
    } catch {
      return undefined;
    }
  }

  private reloadSessions(teardownSession?: string): void {
    const fresh = loadSessionConfigs(this.baseDir, {
      tolerant: true,
      defaultRuntime: this.config.defaults.runtime,
    });
    for (const [codename, session] of fresh) {
      if (this.runtimes.has(session.runtime)) continue;
      const previous = this.sessions.get(codename);
      log().error(
        'supervisor',
        `Session '${codename}' selects unknown runtime '${session.runtime}' — available: ${[...this.runtimes.keys()].sort().join(', ')}.`,
      );
      if (previous === undefined) fresh.delete(codename);
      else fresh.set(codename, previous);
    }
    for (const [codename, session] of fresh) {
      const isNew = !this.sessions.has(codename);
      if (isNew) {
        log().info('supervisor', `Session registered: ${codename}`);
      } else {
        this.warnOnLaunchFieldEdit(codename, this.sessions.get(codename), session);
      }
      // A setting that applies to one runtime must not be silently dropped on
      // another: an operator who wrote it believes the seat is bounded.
      if (session.askUserQuestionTimeout !== undefined && session.runtime !== 'claude-code') {
        log().warn(
          'supervisor',
          `${codename} sets askUserQuestionTimeout but runs ${session.runtime}; that setting is Claude Code only and has no effect here.`,
        );
      }
      this.states.register(codename, this.lifecycle.isAgentProject(session), session.auto);
      if (isNew) {
        this.eventBus.emit({ type: 'session.registered', session: codename, cause: 'config-added' });
      }
    }
    const configDir = sessionConfigDir(this.baseDir);
    for (const codename of this.sessions.keys()) {
      if (fresh.has(codename)) continue;
      const kept = this.sessions.get(codename);
      // Distinguish a genuinely deleted config from one that merely failed to
      // parse this tick (an editor's atomic save the mtime poller caught
      // mid-write). Only a truly-gone file deregisters — otherwise a transient
      // parse error would wipe the session's persisted auto/tag state.
      const fileStillPresent =
        existsSync(join(configDir, `${codename}.yaml`)) || existsSync(join(configDir, `${codename}.yml`));
      if (fileStillPresent) {
        log().warn('supervisor', `Config for ${codename} failed to parse — keeping last-good registration.`);
        if (kept !== undefined) fresh.set(codename, kept);
      } else if (this.states.get(codename)?.running === true && codename !== teardownSession) {
        log().warn('supervisor', `Config for ${codename} removed but session is active — keeping registered.`);
        if (kept !== undefined) fresh.set(codename, kept);
      } else {
        log().info('supervisor', `Session deregistered: ${codename}`);
        this.states.deregister(codename);
        this.eventBus.emit({
          type: 'session.deregistered',
          session: codename,
          cause: codename === teardownSession ? 'teardown' : 'config-removed',
        });
      }
    }
    this.sessions = fresh;
    this.sentinel.setRegisteredSessions(fresh.keys());
    this.scheduler.rebuild();
  }

  /**
   * Launch-time fields are frozen at launch. Editing one under a running session
   * changes only what its NEXT launch will do, and the edit is otherwise
   * indistinguishable from having taken effect — which is how a seat ran one
   * model for twenty hours under a config naming another, with three separate
   * instruments agreeing with the config and all of them wrong.
   *
   * The remedy is named because the obvious repair does not work: only a stop and
   * start re-reads these, and clearing a session's context does not.
   */
  private warnOnLaunchFieldEdit(codename: string, previous: SessionConfig | undefined, next: SessionConfig): void {
    if (previous === undefined || this.states.get(codename)?.running !== true) return;
    const changed = launchTimeFieldEdits(previous, next);
    if (changed.length === 0) return;
    log().warn(
      'supervisor',
      `${codename} is running and its launch-time config changed (${changed.join('; ')}). ` +
        'The live process keeps what it was launched with; restart the session to apply.',
    );
  }

  private resolveProtocolPath(): string | undefined {
    const candidates = [
      join(this.baseDir, 'prompts', 'conductor-protocol.md'),
      join(PACKAGE_ROOT, 'prompts', 'conductor-protocol.md'),
    ];
    return candidates.find((candidate) => existsSync(candidate));
  }
}
