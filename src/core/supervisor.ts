import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChannelAdapter, ChannelMessage } from '../channels/types.js';
import { renderChannelMessage } from '../channels/render.js';
import { buildConfiguredChannels } from '../channels/configured.js';
import { resolveFleetEnvironment } from '../config/environment.js';
import { fleetSlug } from '../config/instance.js';
import {
  sessionConfigDir,
  loadSessionConfigs,
  loadSupervisorConfig,
  validateFederationExposure,
} from '../config/loader.js';
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
import { buildFederationOperatorCommands } from '../federation/commands.js';
import { LocalFederationAdapter } from '../federation/local.js';
import { FederationOperations } from '../federation/operations.js';
import { FederationService, federationInstanceId } from '../federation/service.js';
import { ITermBackend } from '../terminals/iterm/index.js';
import { TmuxBackend } from '../terminals/tmux/index.js';
import type { TerminalBackend } from '../terminals/types.js';
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
import { StallSentinelRouter } from './sentinel.js';
import { SessionStateManager } from './state.js';
import { resolvedSessionEffort, resolvedSessionModel, statusReport } from './status.js';

const PACKAGE_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const SENTINEL_WORKSPACE_KEY = 'sentinel.codename';
import { Scheduler } from './scheduler.js';

export interface SupervisorStartOptions {
  startAll?: boolean;
}

export interface SupervisorOptions {
  /** Additional operator adapters. They receive the same canonical command surface as the built-ins. */
  channels?: ChannelAdapter[];
  /** Disable environment-configured built-in adapters, primarily for embedding and tests. */
  includeConfiguredChannels?: boolean;
  /** Override the inherited environment before merging the fleet's .conductor/.env. */
  env?: NodeJS.ProcessEnv;
  /** Override Claude's state path when embedding the conductor (primarily for isolated tests). */
  claudeJsonPath?: string;
  /** Inject a terminal adapter when embedding or testing. */
  terminalBackend?: TerminalBackend;
}

/** Thin orchestrator: constructs the modules, wires the seams, owns the loops. */
export class Supervisor {
  readonly config: SupervisorConfig;
  private sessions: Map<string, SessionConfig>;

  private readonly store: Store;
  private readonly states: SessionStateManager;
  private readonly backend: TerminalBackend;
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly delivery: DeliveryQueue;
  private readonly lifecycle: Lifecycle;
  private readonly health: HealthMonitor;
  private readonly sentinel: StallSentinelRouter;
  private readonly messaging: Messaging;
  private readonly operations: ConductorOperations;
  private readonly federationService: FederationService | undefined;
  private readonly federationOperations: FederationOperations | undefined;
  private readonly operatorRequests: OperatorRequests;
  private readonly commands: CommandRouter;
  private readonly mcpServer: ConductorMcpServer;
  private readonly scheduler: Scheduler;
  private readonly watcher: ConfigWatcher;
  private readonly channelCandidates: ChannelAdapter[];
  private readonly channels: ChannelAdapter[] = [];
  private readonly env: NodeJS.ProcessEnv;
  private readonly lock: FleetLock;
  private heartbeatTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly baseDir: string,
    options: SupervisorOptions = {},
  ) {
    this.env = resolveFleetEnvironment(baseDir, options.env ?? process.env);
    this.config = loadSupervisorConfig(baseDir, this.env);
    const dataDir = resolveFleetDataDir(baseDir, this.config.paths.dataDir);
    const fleetPaths = resolveFleetPaths(baseDir);
    initLogger({ level: this.config.supervisor.logLevel, filePath: join(dataDir, 'conductor.log') });
    this.lock = new FleetLock(join(dataDir, 'conductor.lock'));
    this.channelCandidates = [
      ...(options.channels ?? []),
      ...((options.includeConfiguredChannels ?? true) ? buildConfiguredChannels(this.config, this.env) : []),
    ];

    this.sessions = loadSessionConfigs(baseDir, {
      tolerant: true,
      defaultRuntime: this.config.defaults.runtime,
    });
    const federationProblems = validateFederationExposure(this.config, this.sessions);
    if (federationProblems.length > 0) {
      throw new Error(`Invalid federation configuration: ${federationProblems.join('; ')}`);
    }
    this.store = new Store(join(dataDir, 'conductor.db'));
    this.states = new SessionStateManager(this.store, this.config.defaults.auto);
    const storedSentinel = this.store.getWorkspaceValue<string | null>(SENTINEL_WORKSPACE_KEY);

    const fleetId = fleetSlug(baseDir);
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

    this.delivery = new DeliveryQueue({
      backend: this.backend,
      runtimeFor: (session) => this.runtimeFor(session),
      getPane: (session) => this.lifecycle.getPane(session),
      onRuntimeObserved: (session) => {
        this.markRuntimeObserved(session);
      },
      onDelivered: (session) => {
        if (this.states.get(session)?.running === true) this.states.setActivity(session, 'working');
        this.health.reset(session);
        this.sentinel.noteWorking(session);
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
      reloadSessions: () => {
        this.reloadSessions();
      },
      supervisionReset: (session) => {
        this.health.reset(session);
        this.sentinel.reset(session);
      },
      onRunning: (session) => {
        void this.recoverPendingMessages(session);
      },
    });

    this.messaging = new Messaging({
      store: this.store,
      delivery: this.delivery,
      states: this.states,
      sessions: () => this.sessions,
      startSession: (codename, opts) => this.lifecycle.start(codename, opts),
    });

    if (this.config.federation.local.enabled) {
      const instanceId = federationInstanceId(this.store);
      const serviceRef: { current?: FederationService } = {};
      const currentService = (): FederationService => {
        if (serviceRef.current === undefined) throw new Error('Federation service is not initialized.');
        return serviceRef.current;
      };
      const configuredRegistry = this.config.federation.local.registryDir;
      const registryDir =
        configuredRegistry === null
          ? join(homedir(), '.agent-conductor', 'federation')
          : isAbsolute(configuredRegistry)
            ? configuredRegistry
            : resolve(baseDir, configuredRegistry);
      const adapter = new LocalFederationAdapter({
        registryDir,
        instanceId,
        fleet: this.config.federation.name,
        ...(this.config.federation.description !== undefined
          ? { description: this.config.federation.description }
          : {}),
        heartbeatMs: this.config.federation.local.heartbeatSeconds * 1000,
        staleAfterMs: this.config.federation.local.staleAfterSeconds * 1000,
        exposedDirectory: () => currentService().exposedDirectory(instanceId),
        accept: (source, message) => currentService().acceptInbound(source, message),
        status: (source, sourceSession, messageId) =>
          Promise.resolve(currentService().inboundStatus(source, sourceSession, messageId)),
      });
      const service = new FederationService({
        store: this.store,
        messaging: this.messaging,
        states: this.states,
        sessions: () => this.sessions,
        adapter,
        config: {
          fleet: this.config.federation.name,
          ...(this.config.federation.description !== undefined
            ? { description: this.config.federation.description }
            : {}),
          exposedSessions: this.config.federation.sessions.expose,
          sessionDescriptions: this.config.federation.sessions.descriptions,
        },
      });
      serviceRef.current = service;
      this.federationService = service;
      this.federationOperations = new FederationOperations(service);
    }
    this.operatorRequests = new OperatorRequests({
      store: this.store,
      messaging: this.messaging,
      channelSend: (message) => this.channelSend(message),
    });

    this.sentinel = new StallSentinelRouter({
      config: {
        captureLines: this.config.health.captureLines,
        suppressWindowMs: this.config.health.suppressWindowMs,
        suppressSimilarity: this.config.health.suppressSimilarity,
        sentinelCodename: storedSentinel === undefined ? this.config.sentinel.codename : (storedSentinel ?? undefined),
      },
      backend: this.backend,
      runtimeFor: (session) => this.runtimeFor(session),
      getPane: (session) => this.lifecycle.getPane(session),
      isAuto: (session) => this.states.isAuto(session),
      isPaused: (session) => this.states.isPaused(session),
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
      onStall: (session, kind, info) => {
        this.states.setActivity(session, kind === 'idle' ? 'idle' : 'stalled');
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
      modelHints: {
        'claude-code': this.config.runtimes.claudeCode.availableModels,
        'codex': this.config.runtimes.codex.availableModels,
      },
      effortHints: {
        'claude-code': this.config.runtimes.claudeCode.availableEfforts,
        'codex': this.config.runtimes.codex.availableEfforts,
      },
      statusReport: (codename) => this.statusReport(codename),
      tail: (codename, lines) => this.tail(codename, lines),
      typeInPane: (codename, text) => this.typeInPane(codename, text),
      tailLimits: {
        defaultLines: this.config.messaging.tailDefaultLines,
        maxLines: this.config.messaging.tailMaxLines,
      },
      fleetStallDefaultSeconds: Math.floor(this.config.health.fleetStallConfirmMs / 1000),
      retitle: (session) => this.retitle(session),
      summon: (session) => this.paneAction(session, 'summon'),
      banish: (session) => this.paneAction(session, 'banish'),
      setSentinel: (session) => this.setSentinel(session),
      getDocumentation: (topic) =>
        new ConductorDocumentation({
          referencePath: join(PACKAGE_ROOT, 'docs', 'agent-guide.md'),
          fleetDir: baseDir,
          fleetPaths,
        }).read(topic),
    });
    this.commands = new CommandRouter(
      this.operations,
      this.federationOperations === undefined ? [] : buildFederationOperatorCommands(this.federationOperations),
    );

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
    });

    this.mcpServer = new ConductorMcpServer({
      port: this.config.mcp.port,
      host: this.config.mcp.host,
      keepAliveTimeoutMs: this.config.mcp.keepAliveTimeoutMs,
      onEvent: (session, body) => {
        this.handleRuntimeEvent(session, body);
      },
      onCommand: (line, interactionId) => this.commands.route(line, `cli:${interactionId}`),
      tools: buildMcpTools(this.operations, this.federationOperations),
    });

    this.watcher = new ConfigWatcher(sessionConfigDir(baseDir), [resolveFleetPaths(baseDir).supervisorFile]);
    this.watcher.onChange(() => {
      this.reloadSessions();
      this.reloadFederationPolicy();
    });

    for (const [codename, session] of this.sessions) {
      this.states.register(codename, this.lifecycle.isAgentProject(session));
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
    this.operatorRequests.recoverStaleClaims();
    log().info('supervisor', `Starting agent-conductor (backend: ${this.backend.name})`);
    await this.backend.init();

    // Re-adopt panes that survived a conductor restart.
    try {
      for (const [codename, pane] of await this.backend.rediscover()) {
        if (this.sessions.has(codename)) {
          this.lifecycle.adopt(codename, pane);
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

    await this.recoverPendingMessages();

    await this.mcpServer.start();
    try {
      await this.federationService?.start();
      await this.connectChannels();
    } catch (error) {
      await this.rollbackChannelStartup();
      await this.federationService?.stop();
      await this.mcpServer.stop();
      throw error;
    }

    const heartbeatMs = this.config.supervisor.heartbeatIntervalSeconds * 1000;
    this.heartbeatTimer = setInterval(() => {
      void this.health.heartbeat();
    }, heartbeatMs);
    this.heartbeatTimer.unref();

    this.watcher.start(heartbeatMs);
    this.scheduler.rebuild();

    if (opts.startAll === true) {
      for (const codename of this.sessions.keys()) {
        try {
          await this.lifecycle.start(codename);
        } catch (err) {
          log().error('supervisor', `${codename} failed to start: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

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
    // Close peer ingress before the final-hop queue. Otherwise a peer request
    // racing channel shutdown can recreate delivery work against a closing Store.
    await this.federationService?.stop();
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
    return this.commands.route(line);
  }

  /** Force a config reload synchronously. Exposed for tests (normally driven by the watcher). */
  reloadSessionsForTest(): void {
    this.reloadSessions();
    this.reloadFederationPolicy();
  }

  statusReport(codename?: string): string {
    const report = statusReport(
      {
        sessions: () => this.sessions,
        getState: (name) => this.states.get(name),
        runtimeFor: (name) => this.displayRuntimeFor(name),
        modelFor: (name) => this.displayModelFor(name),
        effortFor: (name) => this.displayEffortFor(name),
        sentinelCodename: () => this.sentinel.sentinelCodename(),
      },
      codename,
    );
    if (codename !== undefined || this.federationService === undefined) return report;
    const health = this.federationService.health();
    const contact =
      health.lastContactAt === null ? 'none' : `${formatDuration(Math.max(0, Date.now() - health.lastContactAt))} ago`;
    const oldest = health.oldestPendingAgeMs === null ? 'none' : formatDuration(health.oldestPendingAgeMs);
    return (
      `${report}\n\nFederation:\n` +
      `  ${health.adapter} · ${health.running ? 'running' : 'stopped'} · last contact: ${contact}` +
      ` · queued: ${String(health.queued)} · received: ${String(health.received)}` +
      ` · oldest pending: ${oldest} · last error: ${health.lastErrorCode ?? 'none'}`
    );
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
        `${codename ?? 'fleet'}: pending-message recovery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private runtimeFor(session: string): SessionRuntime | undefined {
    const runtime = this.lifecycle.runtimeNameFor(session);
    return runtime !== undefined ? this.runtimes.get(runtime) : undefined;
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
    for (const channel of this.channelCandidates) {
      await channel.start({
        onCommand: (command, args, context) =>
          this.commands.route(`/${command} ${args.join(' ')}`.trim(), `${channel.name}:${context.conversationId}`),
        onFreeText: (text, context) => this.commands.freeText(text, `${channel.name}:${context.conversationId}`),
      });
      this.channels.push(channel);
      log().info('supervisor', `${channel.name} channel connected.`);
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
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        const channel = this.channels[index];
        log().warn(
          'supervisor',
          `channel ${channel?.name ?? String(index)} send failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        );
      }
    }
    return true;
  }

  private reloadSessions(): void {
    const fresh = loadSessionConfigs(this.baseDir, {
      tolerant: true,
      defaultRuntime: this.config.defaults.runtime,
    });
    for (const [codename, session] of fresh) {
      if (!this.sessions.has(codename)) {
        log().info('supervisor', `Session registered: ${codename}`);
      }
      this.states.register(codename, this.lifecycle.isAgentProject(session));
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
      } else if (this.states.get(codename)?.running === true) {
        log().warn('supervisor', `Config for ${codename} removed but session is active — keeping registered.`);
        if (kept !== undefined) fresh.set(codename, kept);
      } else {
        log().info('supervisor', `Session deregistered: ${codename}`);
        this.states.deregister(codename);
      }
    }
    this.sessions = fresh;
    for (const watch of this.sentinel.pruneFleetWatches(new Set(fresh.keys()))) {
      log().warn('supervisor', `Fleet watch '${watch}' disarmed because one of its sessions was deregistered.`);
    }
    this.scheduler.rebuild();
  }

  private reloadFederationPolicy(): void {
    let fresh: SupervisorConfig;
    try {
      fresh = loadSupervisorConfig(this.baseDir, this.env);
    } catch (error) {
      log().warn(
        'federation',
        `Supervisor config failed to parse — keeping last-good federation policy: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    const problems = validateFederationExposure(fresh, this.sessions);
    if (problems.length > 0) {
      log().warn('federation', `Invalid federation policy — keeping last-good policy: ${problems.join('; ')}`);
      return;
    }
    if (
      fresh.federation.local.enabled !== this.config.federation.local.enabled ||
      fresh.federation.name !== this.config.federation.name
    ) {
      log().warn('federation', 'Federation enablement and name changes require a Conductor restart.');
    }
    if (this.federationService === undefined) return;
    this.federationService.updatePolicy({
      ...(fresh.federation.description !== undefined ? { description: fresh.federation.description } : {}),
      exposedSessions: fresh.federation.sessions.expose,
      sessionDescriptions: fresh.federation.sessions.descriptions,
    });
    this.config.federation.description = fresh.federation.description;
    this.config.federation.sessions = fresh.federation.sessions;
  }

  private resolveProtocolPath(): string | undefined {
    const candidates = [
      join(this.baseDir, 'prompts', 'conductor-protocol.md'),
      join(PACKAGE_ROOT, 'prompts', 'conductor-protocol.md'),
    ];
    return candidates.find((candidate) => existsSync(candidate));
  }
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${String(Math.round(milliseconds))}ms`;
  if (milliseconds < 60_000) return `${String(Math.round(milliseconds / 1_000))}s`;
  if (milliseconds < 3_600_000) return `${String(Math.round(milliseconds / 60_000))}m`;
  return `${String(Math.round(milliseconds / 3_600_000))}h`;
}
