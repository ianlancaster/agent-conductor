import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '../src/config/schema.js';
import { DeliveryQueue } from '../src/core/delivery.js';
import { Lifecycle } from '../src/core/lifecycle.js';
import { Messaging } from '../src/core/messaging.js';
import { ConductorOperations } from '../src/core/operations.js';
import { OperatorRequests } from '../src/core/operator-requests.js';
import { StallSentinelRouter } from '../src/core/sentinel.js';
import { SessionStateManager } from '../src/core/state.js';
import { ConductorMcpServer } from '../src/mcp/server.js';
import { buildMcpTools } from '../src/mcp/tools.js';
import { parseShepherdConfig } from '../src/shepherd/config.js';
import { ShepherdEngine } from '../src/shepherd/engine.js';
import { ShepherdService } from '../src/shepherd/service.js';
import { ConductorCoordinatorSink } from '../src/shepherd/sinks.js';
import { SqliteShepherdStore } from '../src/shepherd/store.js';
import {
  PermanentDeliveryError,
  type GitHubProvider,
  type OutboxItem,
  type PullRequestDetails,
} from '../src/shepherd/types.js';
import { Store } from '../src/store/index.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';

const PORT = 43_219;
let server: ConductorMcpServer;
let store: Store;
let delivery: DeliveryQueue;
let backend: FakeTerminalBackend;

const item: OutboxItem = {
  id: 1,
  eventId: 'event-id',
  recipient: 'coordinator',
  idempotencyKey: 'shepherd:event-id:coordinator',
  message: 'facts',
  attempts: 0,
  nextAttemptAt: '2026-07-20T00:00:00Z',
};

beforeEach(async () => {
  store = new Store(':memory:');
  backend = new FakeTerminalBackend();
  const runtime = new FakeRuntime();
  const states = new SessionStateManager(store, false);
  const sessions = new Map<string, SessionConfig>([
    [
      'coordinator',
      {
        codename: 'coordinator',
        repo: '/tmp/coordinator',
        runtime: 'claude-code',
        additionalDirs: [],
        schedules: [],
      },
    ],
  ]);
  states.register('coordinator', false);
  const lifecycle = new Lifecycle({
    store,
    backend,
    states,
    runtimes: new Map([
      ['claude-code', runtime],
      ['codex', runtime],
    ]),
    sessions: () => sessions,
    identityFor: (codename) => ({ mcpUrl: '', eventsUrl: '', configDir: `/tmp/${codename}` }),
    config: {
      defaultPlacement: 'pane',
      defaultRuntime: 'claude-code',
      defaultEfforts: { 'claude-code': undefined, 'codex': undefined },
      defaultBypassPermissions: true,
      markerFile: '.agent-marker',
      spawnDirPattern: './{codename}',
      spawnTemplates: {},
      templateCloneTimeoutMs: 5_000,
    },
    baseDir: '/tmp',
    sessionConfigDir: '/tmp/sessions',
    reloadSessions: () => undefined,
    supervisionReset: () => undefined,
  });
  delivery = new DeliveryQueue({
    backend,
    runtimeFor: () => runtime,
    getPane: (session) => lifecycle.getPane(session),
    config: { queueDrainMs: 2_000 },
  });
  const messaging = new Messaging({
    store,
    delivery,
    states,
    sessions: () => sessions,
    startSession: (codename, options) => lifecycle.start(codename, options),
  });
  const operatorRequests = new OperatorRequests({ store, messaging, channelSend: async () => false });
  const sentinel = new StallSentinelRouter({
    config: { captureLines: 40, suppressWindowMs: 300_000, suppressSimilarity: 0.8 },
    backend,
    runtimeFor: () => runtime,
    getPane: (session) => lifecycle.getPane(session),
    isAuto: (session) => states.isAuto(session),
    isPaused: (session) => states.isPaused(session),
    isActive: (session) => states.get(session)?.running === true,
    deliver: async () => 'delivered',
    notifyOperator: async () => undefined,
    logEvent: () => undefined,
  });
  const operations = new ConductorOperations({
    lifecycle,
    messaging,
    operatorRequests,
    sentinel,
    states,
    sessions: () => sessions,
    modelHints: { 'claude-code': [], 'codex': [] },
    effortHints: { 'claude-code': [], 'codex': [] },
    statusReport: () => '',
    tail: async () => '',
    typeInPane: async () => '',
    tailLimits: { defaultLines: 30, maxLines: 500 },
    fleetStallDefaultSeconds: 300,
    retitle: async () => undefined,
    summon: async () => '',
    banish: async () => '',
    setSentinel: () => undefined,
    getDocumentation: async (topic) => `docs:${topic ?? 'index'}`,
  });
  server = new ConductorMcpServer({
    port: PORT,
    host: '127.0.0.1',
    keepAliveTimeoutMs: 1_000,
    tools: buildMcpTools(operations),
    onEvent: () => undefined,
  });
  await server.start();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await server.stop();
  delivery.stop();
  store.close();
});

describe('Shepherd-to-Conductor compatibility contract', () => {
  it('persists once through the real operation and returns the original receipt on retry', async () => {
    const sink = new ConductorCoordinatorSink(`http://127.0.0.1:${String(PORT)}`);
    await expect(sink.send(item)).resolves.toEqual({
      messageId: 1,
      recipient: 'coordinator',
      status: 'delivered',
      deduplicated: false,
    });
    await expect(sink.send({ ...item, message: 'must not replace the original' })).resolves.toEqual({
      messageId: 1,
      recipient: 'coordinator',
      status: 'delivered',
      deduplicated: true,
    });
    expect(store.getMessage(1)?.content).toBe('facts');
    expect(store.getMessage(2)).toBeUndefined();
    expect(backend.paneFor('coordinator')?.launched).toHaveLength(1);
  });

  it('parks unknown-recipient validation errors as permanent', async () => {
    const sink = new ConductorCoordinatorSink(`http://127.0.0.1:${String(PORT)}`);
    await expect(sink.send({ ...item, recipient: 'missing' })).rejects.toBeInstanceOf(PermanentDeliveryError);
  });

  it('rejects a persisted receipt for the wrong recipient', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            structuredContent: { messageId: 9, recipient: 'someone-else', status: 'queued', deduplicated: false },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const sink = new ConductorCoordinatorSink(`http://127.0.0.1:${String(PORT)}`);

    await expect(sink.send(item)).rejects.toThrow('no valid persisted-message receipt');
  });

  it('retries internal Conductor errors instead of parking them as invalid input', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'delivery failed' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const sink = new ConductorCoordinatorSink(`http://127.0.0.1:${String(PORT)}`);

    const failure = await sink.send(item).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PermanentDeliveryError);
  });

  it('delivers an enterprise-scoped CI event through the full engine, outbox, HTTP, and Conductor pipeline', async () => {
    const endpoint = `http://127.0.0.1:${String(PORT)}`;
    const config = parseShepherdConfig({
      version: 2,
      profile: { githubUser: 'octocat' },
      github: { includeOwners: ['example-enterprise'], mode: 'merge-queue', mergeMethod: 'squash' },
      features: { staleThresholdHours: 24 },
      delivery: {
        type: 'conductor',
        endpoint,
        coordinatorSession: 'coordinator',
      },
    });
    const details: PullRequestDetails = {
      repo: 'example-enterprise/platform',
      number: 42,
      title: 'Fix policy sync',
      url: 'https://github.com/example-enterprise/platform/pull/42',
      isDraft: false,
      updatedAt: '2026-07-20T10:00:00Z',
      state: 'OPEN',
      headSha: 'head-a',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      autoMergeRequest: null,
      mergedAt: null,
      closedAt: null,
      checks: [{ id: 'run-1', name: 'test', state: 'FAILURE', bucket: 'fail', workflow: 'CI' }],
      reviews: [],
      comments: [],
      commits: [],
    };
    const github: GitHubProvider = {
      discover: async () => ({ items: [details], exhaustive: true }),
      getPullRequest: async () => details,
      mutate: async () => undefined,
    };
    const shepherdStore = new SqliteShepherdStore(':memory:');
    try {
      const engine = new ShepherdEngine(config, github, shepherdStore, () => new Date('2026-07-20T11:00:00Z'));
      const service = new ShepherdService(config, engine, shepherdStore, new ConductorCoordinatorSink(endpoint));

      await expect(service.pollAndDeliver()).resolves.toMatchObject({ emitted: 1 });
      expect(shepherdStore.listOutbox()).toEqual([]);
      expect(store.getMessage(1)).toMatchObject({
        sender: 'pr-shepherd',
        recipient: 'coordinator',
        status: 'delivered',
      });
      expect(store.getMessage(1)?.content).toContain('ci-failed: example-enterprise/platform#42');
    } finally {
      shepherdStore.close();
    }
  });
});
