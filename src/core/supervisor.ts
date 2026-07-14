import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChannelAdapter, ChannelChoice } from '../channels/types.js';
import { TelegramAdapter } from '../channels/telegram/index.js';
import { agentConfigDir, loadAgentConfigs, loadSupervisorConfig } from '../config/loader.js';
import type { AgentConfig, SupervisorConfig } from '../config/schema.js';
import { ConfigWatcher } from '../config/watcher.js';
import { initLogger, log } from '../logger.js';
import { ConductorMcpServer } from '../mcp/server.js';
import { buildMcpTools } from '../mcp/tools.js';
import { ClaudeCodeRuntime } from '../runtimes/claude-code/index.js';
import { CodexRuntime } from '../runtimes/codex/index.js';
import type { AgentRuntime } from '../runtimes/types.js';
import { Store } from '../store/index.js';
import { ITermBackend } from '../terminals/iterm/index.js';
import { TmuxBackend } from '../terminals/tmux/index.js';
import type { TerminalBackend } from '../terminals/types.js';
import { CommandRouter } from './commands.js';
import { DeliveryQueue } from './delivery.js';
import { FocusAutoPause } from './focus-autopause.js';
import { HealthMonitor } from './health.js';
import { HumanInputBroker } from './human-input.js';
import { identityFor } from './identity.js';
import { Lifecycle } from './lifecycle.js';
import { Messaging } from './messaging.js';
import { StallSentinelRouter } from './sentinel.js';
import { AgentStateManager } from './state.js';
import { statusReport } from './status.js';

const PACKAGE_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
import { Scheduler } from './scheduler.js';

export interface SupervisorStartOptions {
  startAll?: boolean;
}

/** Thin orchestrator: constructs the modules, wires the seams, owns the loops. */
export class Supervisor {
  readonly config: SupervisorConfig;
  private agents: Map<string, AgentConfig>;

  private readonly store: Store;
  private readonly states: AgentStateManager;
  private readonly backend: TerminalBackend;
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly delivery: DeliveryQueue;
  private readonly lifecycle: Lifecycle;
  private readonly health: HealthMonitor;
  private readonly sentinel: StallSentinelRouter;
  private readonly humanInput: HumanInputBroker;
  private readonly messaging: Messaging;
  private readonly commands: CommandRouter;
  private readonly mcpServer: ConductorMcpServer;
  private readonly scheduler: Scheduler;
  private readonly watcher: ConfigWatcher;
  private readonly channels: ChannelAdapter[] = [];
  private readonly autoPause: FocusAutoPause | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;

  constructor(readonly baseDir: string) {
    this.config = loadSupervisorConfig(baseDir);
    const dataDir = join(baseDir, this.config.paths.dataDir);
    initLogger({ level: this.config.supervisor.logLevel, filePath: join(dataDir, 'conductor.log') });

    this.agents = loadAgentConfigs(baseDir, { tolerant: true });
    this.store = new Store(join(dataDir, 'conductor.db'));
    this.states = new AgentStateManager(this.store, this.config.defaults.autonomy);

    this.backend =
      this.config.terminal.backend === 'tmux'
        ? new TmuxBackend({
            store: this.store,
            config: { sessionName: this.config.terminal.tmux.sessionName, windowName: this.config.terminal.windowName },
          })
        : new ITermBackend({
            store: this.store,
            config: { ...this.config.terminal.iterm, windowName: this.config.terminal.windowName },
          });

    const protocolPath = this.resolveProtocolPath();
    this.runtimes.set('claude-code', new ClaudeCodeRuntime({ config: this.config.runtimes.claudeCode, protocolPath }));
    this.runtimes.set('codex', new CodexRuntime({ config: this.config.runtimes.codex, baseDir, protocolPath }));

    this.delivery = new DeliveryQueue({
      backend: this.backend,
      runtimeFor: (agent) => this.runtimeFor(agent),
      getPane: (agent) => this.lifecycle.getPane(agent),
      config: this.config.messaging,
    });

    this.lifecycle = new Lifecycle({
      store: this.store,
      backend: this.backend,
      states: this.states,
      runtimes: this.runtimes,
      agents: () => this.agents,
      identityFor: (codename) =>
        identityFor(codename, { host: this.config.mcp.host, port: this.config.mcp.port, dataDir }),
      config: {
        defaultPlacement: this.config.defaults.placement,
        markerFile: this.config.spawn.markerFile,
        spawnDirPattern: this.config.spawn.dirPattern,
      },
      baseDir,
      agentConfigDir: agentConfigDir(baseDir),
      reloadAgents: () => {
        this.reloadAgents();
      },
      healthReset: (agent) => {
        this.health.reset(agent);
      },
      onStarted: (agent) => this.messaging.deliverPendingNotifications(agent),
    });

    this.messaging = new Messaging({
      store: this.store,
      delivery: this.delivery,
      states: this.states,
      agents: () => this.agents,
      startAgent: (codename, opts) => this.lifecycle.start(codename, opts),
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
      runtimeFor: (agent) => this.runtimeFor(agent),
      getPane: (agent) => this.lifecycle.getPane(agent),
      getAutonomy: (agent) => this.states.getAutonomy(agent),
      isActive: (agent) => this.states.get(agent)?.sessionActive === true,
      deliver: (agent, text) => this.delivery.deliverOrQueue(agent, text),
      notifyOperator: (text) => this.channelSend(text),
      logEvent: (agent, event, detail) => {
        this.store.logHealthEvent(agent, event, detail);
      },
    });

    this.health = new HealthMonitor({
      config: this.config.health,
      backend: this.backend,
      runtimeFor: (agent) => this.runtimeFor(agent),
      getPane: (agent) => this.lifecycle.getPane(agent),
      getActiveAgents: () => this.states.activeAgents(),
      onStall: (agent, kind, info) => {
        this.states.setActivity(agent, kind === 'idle' ? 'idle' : 'stalled');
        void this.sentinel.handleStall(agent, kind, info);
      },
      onSessionEnd: (agent) => {
        this.lifecycle.handleSessionEnd(agent);
      },
      logEvent: (agent, event, detail) => {
        this.store.logHealthEvent(agent, event, detail);
      },
    });

    this.humanInput = new HumanInputBroker({
      notifyOperator: (text, buttons) => this.channelSend(text, buttons),
      sentinelCodename: () => this.config.sentinel.codename,
      isActive: (agent) => this.states.get(agent)?.sessionActive === true,
      getAutonomy: (agent) => this.states.getAutonomy(agent),
      deliver: (agent, text) => this.delivery.deliverOrQueue(agent, text),
    });

    this.autoPause =
      this.backend.capabilities.focusTracking && this.backend.getFocusedAgent !== undefined
        ? new FocusAutoPause({
            backend: this.backend,
            states: this.states,
            healthReset: (agent) => {
              this.health.reset(agent);
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
      humanInput: this.humanInput,
      states: this.states,
      delivery: this.delivery,
      agents: () => this.agents,
      statusReport: (codename) => this.statusReport(codename),
      tail: (codename, lines) => this.tail(codename, lines),
      tailLimits: {
        defaultLines: this.config.messaging.tailDefaultLines,
        maxLines: this.config.messaging.tailMaxLines,
      },
      autoPause: this.autoPause,
    });

    this.scheduler = new Scheduler({
      agents: () => this.agents,
      isActive: (agent) => this.states.get(agent)?.sessionActive === true,
      isPaused: (agent) => this.states.isPaused(agent),
      startAgent: (agent, opts) => this.lifecycle.start(agent, opts),
      stopAgent: (agent) => this.lifecycle.stop(agent),
      deliver: (agent, text) => this.delivery.deliverOrQueue(agent, text),
    });

    this.mcpServer = new ConductorMcpServer({
      port: this.config.mcp.port,
      host: this.config.mcp.host,
      keepAliveTimeoutMs: this.config.mcp.keepAliveTimeoutMs,
      isSentinel: (caller) => this.sentinel.isSentinel(caller),
      onEvent: (agent, body) => {
        this.handleRuntimeEvent(agent, body);
      },
      onCommand: (line) => this.commands.route(line),
      tools: buildMcpTools({
        lifecycle: this.lifecycle,
        messaging: this.messaging,
        humanInput: this.humanInput,
        sentinel: this.sentinel,
        states: this.states,
        delivery: this.delivery,
        agents: () => this.agents,
        statusReport: (codename) => this.statusReport(codename),
        tail: (codename, lines) => this.tail(codename, lines),
        tailLimits: {
          defaultLines: this.config.messaging.tailDefaultLines,
          maxLines: this.config.messaging.tailMaxLines,
        },
      }),
    });

    this.watcher = new ConfigWatcher(agentConfigDir(baseDir));
    this.watcher.onChange(() => {
      this.reloadAgents();
    });

    for (const [codename, agent] of this.agents) {
      this.states.register(codename, this.lifecycle.isAgentProject(agent));
    }
  }

  async start(opts: SupervisorStartOptions = {}): Promise<void> {
    log().info('supervisor', `Starting agent-conductor (backend: ${this.backend.name})`);
    await this.backend.init();

    // Re-adopt panes that survived a conductor restart.
    try {
      for (const [codename, pane] of await this.backend.rediscover()) {
        if (this.agents.has(codename)) this.lifecycle.adopt(codename, pane);
      }
    } catch (err) {
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
      for (const codename of this.agents.keys()) {
        try {
          await this.lifecycle.start(codename);
        } catch (err) {
          log().error('supervisor', `${codename} failed to start: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    const sentinel = this.config.sentinel.codename;
    if (sentinel === undefined) {
      log().warn('supervisor', 'No sentinel configured — autonomous agents will be unsupervised.');
    } else if (!this.agents.has(sentinel)) {
      log().warn('supervisor', `Configured sentinel '${sentinel}' has no agent config.`);
    }
    log().info('supervisor', `Ready — ${this.agents.size} agent(s) registered.`);
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
    log().info('supervisor', 'Stopped (agent panes left running).');
  }

  /** Route an operator command line (used by the interactive console). */
  command(line: string): Promise<string> {
    return this.commands.route(line);
  }

  statusReport(codename?: string): string {
    return statusReport(
      {
        agents: () => this.agents,
        getState: (name) => this.states.get(name),
        sentinelCodename: () => this.config.sentinel.codename,
        pendingStallCount: () => this.sentinel.pendingStalls().length,
      },
      codename,
    );
  }

  private async tail(codename: string, lines: number): Promise<string> {
    const pane = this.lifecycle.getPane(codename);
    if (pane === undefined) return `${codename} has no active pane.`;
    return this.backend.capture(pane, lines);
  }

  private runtimeFor(agent: string): AgentRuntime | undefined {
    const config = this.agents.get(agent);
    return config !== undefined ? this.runtimes.get(config.runtime) : undefined;
  }

  private handleRuntimeEvent(agent: string, body: unknown): void {
    const runtime = this.runtimeFor(agent);
    if (runtime === undefined) return;
    const parsed = runtime.parseEvent(body);
    if (parsed === null) return;
    log().debug('events', `${agent}: ${parsed.type}${parsed.reason !== undefined ? ` (${parsed.reason})` : ''}`);
    this.health.handleEvent({ ...parsed, agent, receivedAt: Date.now() });
  }

  private async connectChannels(): Promise<void> {
    const token = process.env.CONDUCTOR_TELEGRAM_TOKEN;
    const chatId = process.env.CONDUCTOR_TELEGRAM_CHAT_ID;
    if (this.config.channels.telegram.enabled && token !== undefined && chatId !== undefined) {
      const telegram = new TelegramAdapter({ botToken: token, chatId });
      await telegram.start({
        onCommand: (command, args) => this.commands.route(`/${command} ${args.join(' ')}`.trim()),
        onFreeText: (text) => this.commands.freeText(text),
        onCallback: (data) => this.commands.callback(data),
      });
      this.channels.push(telegram);
      log().info('supervisor', 'Telegram channel connected.');
    }
  }

  private async channelSend(text: string, buttons?: ChannelChoice[][]): Promise<boolean> {
    if (this.channels.length === 0) {
      log().info('operator', text);
      return false;
    }
    for (const channel of this.channels) {
      try {
        await channel.send(text, buttons !== undefined ? { buttons } : undefined);
      } catch (err) {
        log().warn(
          'supervisor',
          `channel ${channel.name} send failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return true;
  }

  private reloadAgents(): void {
    const fresh = loadAgentConfigs(this.baseDir, { tolerant: true });
    for (const [codename, agent] of fresh) {
      if (!this.agents.has(codename)) {
        log().info('supervisor', `Agent registered: ${codename}`);
      }
      this.states.register(codename, this.lifecycle.isAgentProject(agent));
    }
    for (const codename of this.agents.keys()) {
      if (!fresh.has(codename)) {
        if (this.states.get(codename)?.sessionActive === true) {
          log().warn('supervisor', `Config for ${codename} removed but session is active — keeping registered.`);
          const kept = this.agents.get(codename);
          if (kept !== undefined) fresh.set(codename, kept);
        } else {
          log().info('supervisor', `Agent deregistered: ${codename}`);
          this.states.deregister(codename);
        }
      }
    }
    this.agents = fresh;
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
