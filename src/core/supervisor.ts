import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChannelAdapter } from '../channels/types.js';
import { TelegramAdapter } from '../channels/telegram/index.js';
import { fleetSlug } from '../config/instance.js';
import { sessionConfigDir, loadSessionConfigs, loadSupervisorConfig } from '../config/loader.js';
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
import { CommandRouter } from './commands.js';
import { DeliveryQueue } from './delivery.js';
import { FocusAutoPause } from './focus-autopause.js';
import { HealthMonitor } from './health.js';
import { identityFor } from './identity.js';
import { Lifecycle } from './lifecycle.js';
import { FleetLock } from './lock.js';
import { Messaging } from './messaging.js';
import { StallSentinelRouter } from './sentinel.js';
import { SessionStateManager } from './state.js';
import { statusReport } from './status.js';

const PACKAGE_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
import { Scheduler } from './scheduler.js';

export interface SupervisorStartOptions {
  startAll?: boolean;
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
  private readonly commands: CommandRouter;
  private readonly mcpServer: ConductorMcpServer;
  private readonly scheduler: Scheduler;
  private readonly watcher: ConfigWatcher;
  private readonly channels: ChannelAdapter[] = [];
  private readonly autoPause: FocusAutoPause | undefined;
  private readonly lock: FleetLock;
  private heartbeatTimer: NodeJS.Timeout | undefined;

  constructor(readonly baseDir: string) {
    this.config = loadSupervisorConfig(baseDir);
    const dataDir = join(baseDir, this.config.paths.dataDir);
    initLogger({ level: this.config.supervisor.logLevel, filePath: join(dataDir, 'conductor.log') });
    this.lock = new FleetLock(join(dataDir, 'conductor.lock'));

    this.sessions = loadSessionConfigs(baseDir, { tolerant: true });
    this.store = new Store(join(dataDir, 'conductor.db'));
    this.states = new SessionStateManager(this.store, this.config.defaults.autonomy);

    const fleetId = fleetSlug(baseDir);
    this.backend =
      this.config.terminal.backend === 'tmux'
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
              process.env.TMUX !== undefined &&
              process.env.TMUX_PANE !== undefined
                ? { attachPane: process.env.TMUX_PANE }
                : {}),
            },
          })
        : new ITermBackend({
            store: this.store,
            config: { ...this.config.terminal.iterm, windowName: this.config.terminal.windowName, fleetId },
          });

    const protocolPath = this.resolveProtocolPath();
    this.runtimes.set('claude-code', new ClaudeCodeRuntime({ config: this.config.runtimes.claudeCode, protocolPath }));
    this.runtimes.set('codex', new CodexRuntime({ config: this.config.runtimes.codex, baseDir, protocolPath }));

    this.delivery = new DeliveryQueue({
      backend: this.backend,
      runtimeFor: (session) => this.runtimeFor(session),
      getPane: (session) => this.lifecycle.getPane(session),
      isReady: (session) => this.states.isReady(session),
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
        markerFile: this.config.spawn.markerFile,
        spawnDirPattern: this.config.spawn.dirPattern,
      },
      baseDir,
      sessionConfigDir: sessionConfigDir(baseDir),
      reloadSessions: () => {
        this.reloadSessions();
      },
      healthReset: (session) => {
        this.health.reset(session);
      },
      onStarted: (session) => this.messaging.deliverPendingNotifications(session),
    });

    this.messaging = new Messaging({
      store: this.store,
      delivery: this.delivery,
      states: this.states,
      sessions: () => this.sessions,
      startSession: (codename, opts) => this.lifecycle.start(codename, opts),
      channelSend: (text) => this.channelSend(text),
    });

    this.sentinel = new StallSentinelRouter({
      config: {
        captureLines: this.config.health.captureLines,
        suppressWindowMs: this.config.health.suppressWindowMs,
        suppressSimilarity: this.config.health.suppressSimilarity,
        sentinelCodename: this.config.sentinel.codename,
      },
      backend: this.backend,
      runtimeFor: (session) => this.runtimeFor(session),
      getPane: (session) => this.lifecycle.getPane(session),
      getAutonomy: (session) => this.states.getAutonomy(session),
      isActive: (session) => this.states.get(session)?.running === true,
      deliver: (session, text) => this.delivery.deliverOrQueue(session, text),
      notifyOperator: (text) => this.channelSend(text),
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
      onStall: (session, kind, info) => {
        this.states.setActivity(session, kind === 'idle' ? 'idle' : 'stalled');
        void this.sentinel.handleStall(session, kind, info);
      },
      onSessionEnd: (session) => {
        this.lifecycle.handleSessionEnd(session);
      },
      logEvent: (session, event, detail) => {
        this.store.logHealthEvent(session, event, detail);
      },
    });

    this.autoPause =
      this.backend.capabilities.focusTracking && this.backend.getFocusedSession !== undefined
        ? new FocusAutoPause({
            backend: this.backend,
            states: this.states,
            healthReset: (session) => {
              this.health.reset(session);
            },
            config: {
              checkMs: this.config.terminal.iterm.focusCheckMs,
              resumeDelayMs: this.config.terminal.iterm.autoPauseResumeDelaySeconds * 1000,
              startEnabled: this.config.terminal.iterm.autoPauseOnFocus,
            },
          })
        : undefined;

    this.commands = new CommandRouter({
      lifecycle: this.lifecycle,
      messaging: this.messaging,
      states: this.states,
      delivery: this.delivery,
      sessions: () => this.sessions,
      statusReport: (codename) => this.statusReport(codename),
      tail: (codename, lines) => this.tail(codename, lines),
      tailLimits: {
        defaultLines: this.config.messaging.tailDefaultLines,
        maxLines: this.config.messaging.tailMaxLines,
      },
      autoPause: this.autoPause,
      retitle: (session) => this.retitle(session),
      summon: (session) => this.paneAction(session, 'summon'),
      banish: (session) => this.paneAction(session, 'banish'),
    });

    this.scheduler = new Scheduler({
      sessions: () => this.sessions,
      isActive: (session) => this.states.get(session)?.running === true,
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
      onCommand: (line) => this.commands.route(line),
      tools: buildMcpTools({
        lifecycle: this.lifecycle,
        messaging: this.messaging,
        sentinel: this.sentinel,
        states: this.states,
        delivery: this.delivery,
        sessions: () => this.sessions,
        statusReport: (codename) => this.statusReport(codename),
        tail: (codename, lines) => this.tail(codename, lines),
        tailLimits: {
          defaultLines: this.config.messaging.tailDefaultLines,
          maxLines: this.config.messaging.tailMaxLines,
        },
        retitle: (session) => this.retitle(session),
      }),
    });

    this.watcher = new ConfigWatcher(sessionConfigDir(baseDir));
    this.watcher.onChange(() => {
      this.reloadSessions();
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

    await this.mcpServer.start();
    await this.connectChannels();

    const heartbeatMs = this.config.supervisor.heartbeatIntervalSeconds * 1000;
    this.heartbeatTimer = setInterval(() => {
      void this.health.heartbeat();
    }, heartbeatMs);
    this.heartbeatTimer.unref();

    this.watcher.start(heartbeatMs);
    this.scheduler.rebuild();
    this.autoPause?.start();

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
    const sentinel = this.config.sentinel.codename;
    if (sentinel !== undefined && !this.sessions.has(sentinel)) {
      log().warn('supervisor', `Configured sentinel '${sentinel}' has no session config.`);
    }
    log().info('supervisor', `Ready — ${this.sessions.size} session(s) registered.`);
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.watcher.stop();
    this.scheduler.stop();
    this.autoPause?.stop();
    this.health.stop();
    this.delivery.stop();
    for (const channel of this.channels) {
      await channel.stop();
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
  }

  statusReport(codename?: string): string {
    return statusReport(
      {
        sessions: () => this.sessions,
        getState: (name) => this.states.get(name),
        sentinelCodename: () => this.config.sentinel.codename,
      },
      codename,
    );
  }

  private async tail(codename: string, lines: number): Promise<string> {
    const pane = this.lifecycle.getPane(codename);
    if (pane === undefined) return `${codename} has no active pane.`;
    return this.backend.capture(pane, lines);
  }

  private runtimeFor(session: string): SessionRuntime | undefined {
    const config = this.sessions.get(session);
    return config !== undefined ? this.runtimes.get(config.runtime) : undefined;
  }

  private handleRuntimeEvent(session: string, body: unknown): void {
    const runtime = this.runtimeFor(session);
    if (runtime === undefined) return;
    const parsed = runtime.parseEvent(body);
    if (parsed === null) return;
    log().debug('events', `${session}: ${parsed.type}${parsed.reason !== undefined ? ` (${parsed.reason})` : ''}`);
    // Any lifecycle event proves the runtime process is up — unblock queued
    // deliveries that were held to protect the launch command.
    const wasReady = this.states.isReady(session);
    this.states.setReady(session);
    if (!wasReady && this.states.isReady(session)) {
      // Titles set before/at launch get clobbered by the shell's title escape
      // when the launch command runs; the runtime never touches the title, so
      // a rename applied once it is up sticks.
      void this.retitle(session);
    }
    this.health.handleEvent({ ...parsed, session, receivedAt: Date.now() });
    void this.delivery.drainNow();
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
    await this.backend.rename(pane, tag !== undefined && tag.length > 0 ? `${session} — ${tag}` : session);
  }

  private async connectChannels(): Promise<void> {
    const token = process.env.CONDUCTOR_TELEGRAM_TOKEN;
    const chatId = process.env.CONDUCTOR_TELEGRAM_CHAT_ID;
    if (this.config.channels.telegram.enabled && token !== undefined && chatId !== undefined) {
      const telegram = new TelegramAdapter({ botToken: token, chatId });
      await telegram.start({
        onCommand: (command, args) => this.commands.route(`/${command} ${args.join(' ')}`.trim()),
        onFreeText: (text) => this.commands.freeText(text),
      });
      this.channels.push(telegram);
      log().info('supervisor', 'Telegram channel connected.');
    }
  }

  private async channelSend(text: string): Promise<boolean> {
    // Attached operator consoles (conductor start / conductor console) get
    // every operator-bound message pushed over the /feed SSE stream.
    const consoleDelivered = this.mcpServer.pushToFeed(text);
    if (this.channels.length === 0) {
      if (!consoleDelivered) {
        log().info('operator', text);
        return false;
      }
      return true;
    }
    for (const channel of this.channels) {
      try {
        await channel.send(text);
      } catch (err) {
        log().warn(
          'supervisor',
          `channel ${channel.name} send failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return true;
  }

  private reloadSessions(): void {
    const fresh = loadSessionConfigs(this.baseDir, { tolerant: true });
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
      // parse error would wipe the session's persisted autonomy/tag.
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
    this.scheduler.rebuild();
  }

  private resolveProtocolPath(): string | undefined {
    const candidates = [
      join(this.baseDir, 'prompts', 'conductor-protocol.md'),
      join(PACKAGE_ROOT, 'prompts', 'conductor-protocol.md'),
    ];
    return candidates.find((candidate) => existsSync(candidate));
  }
}
