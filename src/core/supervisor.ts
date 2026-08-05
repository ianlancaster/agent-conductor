import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChannelAdapter, ChannelMessage } from '../channels/types.js';
import { renderChannelMessage } from '../channels/render.js';
import { buildConfiguredChannels } from '../channels/configured.js';
import { resolveFleetEnvironment } from '../config/environment.js';
import {
  sessionConfigDir,
  loadSessionConfigs,
  loadSupervisorConfig,
  validateFederationExposure,
} from '../config/loader.js';
import { resolveConductorInstance, resolveFleetDataDir, type ResolvedInstance } from '../config/paths.js';
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
import { formatFleetStatusReport, resolvedSessionEffort, resolvedSessionModel, statusReport } from './status.js';
import { observePaneActivity, observePaneInputState } from './activity.js';
import { ShepherdManager } from './shepherd-manager.js';
import { IntegrationManager } from './integration-manager.js';
import { FederationRegistry } from '../federation/registry.js';
import { FederationRouter } from '../federation/router.js';

const PACKAGE_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const SENTINEL_WORKSPACE_KEY = 'sentinel.codename';
const FLEET_WATCH_ENABLED_WORKSPACE_KEY = 'sentinel.fleetWatchEnabled';
const LEGACY_FLEET_WATCHES_WORKSPACE_KEY = 'sentinel.fleetWatches';
import { Scheduler } from './scheduler.js';

export interface SupervisorStartOptions {
  startAll?: boolean;
}

export interface SupervisorOptions {
  /** Named instance under .conductor/instances; omitted preserves the historical default. */
  instance?: string;
  /** Deterministic federation registry seam for embedding and tests. */
  federationDirectory?: string;
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
  readonly baseDir: string;
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
  private readonly federationRegistry: FederationRegistry | undefined;
  private readonly federationRouter: FederationRouter | undefined;
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
  private readonly resolvedInstance: ResolvedInstance;
  private readonly lock: FleetLock;
  private heartbeatTimer: NodeJS.Timeout | undefined;

  constructor(baseDir: string, options: SupervisorOptions = {}) {
    this.resolvedInstance = resolveConductorInstance(baseDir, options.instance);
    this.baseDir = this.resolvedInstance.baseDir;
    baseDir = this.baseDir;
    const inheritedEnv = options.env ?? process.env;
    this.env = resolveFleetEnvironment(this.resolvedInstance, inheritedEnv);
    this.config = loadSupervisorConfig(this.resolvedInstance, this.env);
    this.shepherd = new ShepherdManager(this.config.shepherd);
    const dataDir = resolveFleetDataDir(baseDir, this.config.paths.dataDir);
    const fleetPaths = this.resolvedInstance.paths;
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

    this.sessions = loadSessionConfigs(this.resolvedInstance, {
      tolerant: true,
      defaultRuntime: this.config.defaults.runtime,
    });
    validateFederationExposure(this.config, this.sessions, fleetPaths.supervisorFile, {
      sessionsDir: fleetPaths.sessionsDir,
      // Tolerant startup keeps malformed session files out of the published
      // roster without turning one editor/save error into a fleet-wide outage.
      tolerateUnparsed: true,
    });
    this.federationRegistry =
      this.config.federation === undefined
        ? undefined
        : new FederationRegistry({
            name: this.config.federation.name,
            host: this.config.mcp.host,
            port: this.config.mcp.port,
            sessions: () => [...this.exposedSessions()],
            ...(options.federationDirectory === undefined ? {} : { directory: options.federationDirectory }),
            // Rendezvous follows the launching user environment. A fleet-local
            // .env must not silently put one peer in a different registry.
            env: inheritedEnv,
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
    const fleetId = this.resolvedInstance.fleetId;
    this.runbooks = configuredRunbookRegistry(
      baseDir,
      this.config,
      PACKAGE_VERSION,
      join(PACKAGE_ROOT, 'runbooks'),
      fleetPaths.runbooksDir,
    );
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
        defaultModels: {
          'claude-code': this.config.runtimes.claudeCode.defaultModel,
          'codex': this.config.runtimes.codex.defaultModel,
        },
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
      sessionConfigDir: sessionConfigDir(this.resolvedInstance),
      reloadSessions: (teardownSession) => {
        this.reloadSessions(teardownSession);
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
      startSession: (codename, opts) => this.lifecycle.start(codename, opts),
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
      observeInputState: (session, pane) =>
        observePaneInputState(this.backend, this.runtimeFor(session), session, pane, this.config.health.captureLines),
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
      ...(this.federationRegistry === undefined ? {} : { exposedSessions: () => this.exposedSessions() }),
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
      statusReport: (codename, only) => this.statusReport(codename, only),
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
      setShepherdPausedForSession: async (session, paused) => {
        if (this.shepherd.recipientSession() !== session) return;
        if (paused) await this.shepherd.pause();
        else await this.shepherd.resume();
      },
      getDocumentation: (topic) => this.documentation.read(topic),
      ...(this.federationRegistry === undefined
        ? {}
        : {
            listFederation: () => {
              if (this.federationRouter === undefined) throw new Error('Federation router is unavailable.');
              return this.federationRouter.listFederation();
            },
          }),
      runbookAdoptions: new RunbookAdoptions({
        store: this.store,
        registry: this.runbooks,
        sessions: () => this.sessions,
        events: this.eventBus,
      }),
    });
    this.federationRouter =
      this.federationRegistry === undefined || this.config.federation === undefined
        ? undefined
        : new FederationRouter(this.config.federation.name, this.federationRegistry, this.operations);
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
      startSession: (session, opts) => this.lifecycle.start(session, opts),
      stopSession: (session) => this.lifecycle.stop(session),
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
      onCommand: (line, interactionId) => this.commands.route(line, `cli:${interactionId}`),
      tools: buildMcpTools(this.operations, this.federationRouter),
      configPath: fleetPaths.supervisorFile,
      ...(this.federationRouter === undefined
        ? {}
        : {
            onFederationRequest: (body: unknown) => {
              if (this.federationRouter === undefined) throw new Error('Federation router is unavailable.');
              return this.federationRouter.invokeFromPeer(body);
            },
          }),
    });

    this.watcher = new ConfigWatcher(sessionConfigDir(this.resolvedInstance));
    this.watcher.onChange(() => this.reloadSessions());

    for (const [codename, session] of this.sessions) {
      this.states.register(codename, this.lifecycle.isAgentProject(session));
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
      await this.federationRegistry?.release();
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
      // Publish only after the ingress is listening, so a discoverable fleet is
      // immediately callable. Registry claim failures share startup rollback.
      await this.federationRegistry?.claim();
    } catch (error) {
      await this.rollbackChannelStartup();
      await this.mcpServer.stop();
      throw error;
    }
    if (this.config.federation !== undefined) {
      log().info(
        'federation',
        `Federated as '${this.config.federation.name}'; exposing ${String(this.exposedSessions().size)} session(s).`,
      );
    }

    const heartbeatMs = this.config.supervisor.heartbeatIntervalSeconds * 1000;
    this.heartbeatTimer = setInterval(() => {
      void this.health.heartbeat();
      void this.federationRegistry?.list().catch((error: unknown) => {
        log().warn(
          'federation',
          `Could not refresh peer roster: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, heartbeatMs);
    this.heartbeatTimer.unref();

    this.watcher.start(heartbeatMs);
    this.scheduler.rebuild();
    await this.shepherd.start((recipient) => this.states.isPaused(recipient));

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
    await this.federationRegistry?.release();
    this.store.close();
    this.lock.release();
    log().info('supervisor', 'Stopped (session panes left running).');
  }

  /** Route an operator command line (used by the interactive console). */
  command(line: string): Promise<string> {
    return this.commands.route(line);
  }

  /** Force a config reload synchronously. Exposed for tests (normally driven by the watcher). */
  reloadSessionsForTest(): void {
    this.reloadSessions();
  }

  statusReport(codename?: string, only?: ReadonlySet<string>): string {
    const report = statusReport(
      {
        sessions: () => this.sessions,
        getState: (name) => this.states.get(name),
        runtimeFor: (name) => this.displayRuntimeFor(name),
        modelFor: (name) => this.displayModelFor(name),
        effortFor: (name) => this.displayEffortFor(name),
        sentinelCodename: () => this.sentinel.sentinelCodename(),
        processObservation: (name) => this.lifecycle.processObservation(name),
      },
      codename,
      { shepherdRecipient: this.shepherd.recipientSession() },
      only,
    );
    // A remote list receives only its canonical exposed-session view. The
    // operator-oriented fleet header carries local companion and peer state.
    if (codename !== undefined || only !== undefined) return report;
    const shepherd = this.shepherd.status();
    return formatFleetStatusReport(report, {
      fleetWatchActive: this.sentinel.isFleetWatchEnabled(),
      shepherdOnline: shepherd.state === 'healthy',
      eventJournal: this.eventBus.journalStatus(),
      integrations: this.integrations.status(),
      ...(this.config.federation === undefined || this.federationRegistry === undefined
        ? {}
        : {
            federation: {
              name: this.config.federation.name,
              exposedSessions: [...this.exposedSessions()].sort(),
              peerCount: this.federationRegistry
                .snapshot()
                .filter((record) => record.name !== this.config.federation?.name).length,
            },
          }),
    });
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
    // The old runtime's effort cannot be assumed portable to the process we
    // just identified. Runtime defaults remain available to status rendering.
    this.states.setRunSettings(session, runtimeName, undefined);
  }

  private displayRuntimeFor(session: string): SessionConfig['runtime'] | undefined {
    const configured = this.sessions.get(session)?.runtime;
    return this.states.get(session)?.running === true ? this.lifecycle.runtimeNameFor(session) : configured;
  }

  /** Model string Conductor resolves for this run; null status means the runtime chooses its own default. */
  private displayModelFor(session: string): string | undefined {
    const configured = this.sessions.get(session);
    const runtime = this.displayRuntimeFor(session);
    if (configured === undefined || runtime === undefined) return undefined;
    return resolvedSessionModel(configured, runtime, {
      'claude-code': this.config.runtimes.claudeCode.defaultModel,
      'codex': this.config.runtimes.codex.defaultModel,
    });
  }

  /** Effort resolved for the active run, or the configured next run while stopped. */
  private displayEffortFor(session: string): string | undefined {
    const configured = this.sessions.get(session);
    const runtime = this.displayRuntimeFor(session);
    if (configured === undefined || runtime === undefined) return undefined;
    const resolved = resolvedSessionEffort(configured, runtime, {
      'claude-code':
        this.config.runtimes.claudeCode.defaultEffort ?? this.config.runtimes.claudeCode.env.CLAUDE_CODE_EFFORT_LEVEL,
      'codex': this.config.runtimes.codex.defaultEffort,
    });
    const state = this.states.get(session);
    return state?.running === true ? (state.effort ?? resolved) : resolved;
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
          onCommand: (command, args, context) =>
            this.commands.route(`/${command} ${args.join(' ')}`.trim(), `${channel.name}:${context.conversationId}`),
          onFreeText: (text, context) => this.commands.freeText(text, `${channel.name}:${context.conversationId}`),
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

  private reloadSessions(teardownSession?: string): void {
    const fresh = loadSessionConfigs(this.resolvedInstance, {
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
      }
      this.states.register(codename, this.lifecycle.isAgentProject(session));
      if (isNew) {
        this.eventBus.emit({ type: 'session.registered', session: codename, cause: 'config-added' });
      }
    }
    const configDir = sessionConfigDir(this.resolvedInstance);
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
    void this.federationRegistry?.update().catch((error: unknown) => {
      log().warn(
        'federation',
        `Could not update exposed roster: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private exposedSessions(): ReadonlySet<string> {
    const exposure = this.config.federation?.expose;
    if (exposure === undefined) return new Set<string>();
    if (exposure.includes('*')) return new Set(this.sessions.keys());
    return new Set(exposure.filter((codename) => this.sessions.has(codename)));
  }

  private resolveProtocolPath(): string | undefined {
    const candidates = [
      join(this.baseDir, 'prompts', 'conductor-protocol.md'),
      join(PACKAGE_ROOT, 'prompts', 'conductor-protocol.md'),
    ];
    return candidates.find((candidate) => existsSync(candidate));
  }
}
