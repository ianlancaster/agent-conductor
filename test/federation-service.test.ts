import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionConfig } from '../src/config/schema.js';
import { DeliveryQueue } from '../src/core/delivery.js';
import { Messaging } from '../src/core/messaging.js';
import { SessionStateManager } from '../src/core/state.js';
import { FederationService } from '../src/federation/service.js';
import {
  FederationError,
  type FederatedWireMessage,
  type FederationAdapter,
  type FederationAdapterHealth,
  type FederationHopReceipt,
  type FederationPeerRoute,
  type FederationPrincipal,
} from '../src/federation/types.js';
import { Store } from '../src/store/index.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';

let store: Store;
let states: SessionStateManager;
let sessions: Map<string, SessionConfig>;
let now: number;
let adapter: FakeFederationAdapter;
let service: FederationService;
let delivery: DeliveryQueue;

beforeEach(() => {
  store = new Store(':memory:');
  states = new SessionStateManager(store, false);
  sessions = new Map([
    ['alpha', session('alpha')],
    ['hidden', session('hidden')],
  ]);
  states.register('alpha', false);
  states.register('hidden', false);
  now = 1_000;
  adapter = new FakeFederationAdapter();
  const backend = new FakeTerminalBackend();
  delivery = new DeliveryQueue({
    backend,
    runtimeFor: () => new FakeRuntime(),
    getPane: () => undefined,
    config: { queueDrainMs: 2_000 },
  });
  const messaging = new Messaging({
    store,
    delivery,
    states,
    sessions: () => sessions,
    startSession: async () => {
      throw new Error('federation must not start a session');
    },
  });
  service = new FederationService({
    store,
    messaging,
    states,
    sessions: () => sessions,
    adapter,
    config: {
      fleet: 'fleet-a',
      exposedSessions: ['alpha'],
      sessionDescriptions: { alpha: 'Public alpha' },
    },
    now: () => now,
    random: () => 0,
  });
});

afterEach(() => {
  delivery.stop();
  store.close();
});

describe('FederationService', () => {
  it('is exposure-default-deny for both outbound and inbound work', async () => {
    adapter.routes = [route('beta@fleet-b', 'instance-b')];
    await expect(service.sendToPeer('hidden', 'beta@fleet-b', 'hello')).rejects.toThrow(
      "Session 'hidden' is not in federation.sessions.expose",
    );
    await expect(service.acceptInbound(sourceRecord(), wire({ destinationSession: 'hidden' }))).rejects.toThrow(
      "Session 'hidden' is not in federation.sessions.expose",
    );
    expect(store.getPendingMessages()).toEqual([]);
    await expect(service.sendToPeer('alpha', 'beta@fleet-b', 'unsafe\u009bterminal')).rejects.toThrow(
      /unsupported control characters/,
    );
  });

  it('persists before sending, retries the same id after a transient failure, and transfers retry ownership', async () => {
    adapter.routes = [route('beta@fleet-b', 'instance-b')];
    adapter.sendError = new Error('temporary destination failure');

    const queued = await service.sendToPeer('alpha', 'beta@fleet-b', 'hello', 'stable');
    expect(queued).toMatchObject({ status: 'queued', deduplicated: false });
    expect(adapter.sent).toHaveLength(1);
    const originalId = adapter.sent[0]?.messageId;
    expect(originalId).toBe(queued.messageId);

    adapter.sendError = undefined;
    now = 5_000;
    await service.drainNow();
    expect(adapter.sent).toHaveLength(2);
    expect(adapter.sent[1]?.messageId).toBe(originalId);
    expect(service.messageStatus(queued.messageId, 'alpha')?.status).toBe('received');

    const deduplicated = await service.sendToPeer('alpha', 'beta@fleet-b', 'changed', 'stable');
    expect(deduplicated).toMatchObject({ messageId: queued.messageId, deduplicated: true });
    expect(adapter.sent).toHaveLength(2);

    adapter.remoteStatus = 'delivered';
    now = 8_000;
    await service.drainNow();
    expect(service.messageStatus(queued.messageId, 'alpha')).toMatchObject({
      status: 'delivered',
      deliveredAt: 8_000,
    });
  });

  it('queues to a previously discovered peer while it is offline, then delivers after it returns', async () => {
    const peer = route('beta@fleet-b', 'instance-b');
    adapter.routes = [peer];
    await service.listPeers();
    adapter.routes = [];
    adapter.sendError = new FederationError('peer_unavailable', 'offline', true);

    const queued = await service.sendToPeer('alpha', 'beta@fleet-b', 'survive restart');
    expect(queued.status).toBe('queued');
    expect(adapter.sent).toHaveLength(1);

    adapter.routes = [peer];
    adapter.sendError = undefined;
    now = 5_000;
    await service.drainNow();

    expect(adapter.sent).toHaveLength(2);
    expect(adapter.sent[1]?.messageId).toBe(queued.messageId);
    expect(service.messageStatus(queued.messageId, 'alpha')?.status).toBe('received');
  });

  it('derives the inbound sender fleet from the authenticated registry principal and never starts the target', async () => {
    const receipt = await service.acceptInbound(
      { ...sourceRecord(), fleet: 'verified-fleet' },
      wire({ sourceSession: 'reviewer', destinationSession: 'alpha', message: 'peer note' }),
    );
    expect(receipt).toMatchObject({ status: 'received', deduplicated: false });
    expect(states.get('alpha')?.running).toBe(false);
    expect(store.getPendingMessages('alpha')[0]).toMatchObject({
      sender: 'reviewer@verified-fleet',
      recipient: 'alpha',
      content: 'peer note',
    });

    const repeated = await service.acceptInbound(
      { ...sourceRecord(), fleet: 'verified-fleet' },
      wire({ sourceSession: 'reviewer', destinationSession: 'alpha', message: 'peer note' }),
    );
    expect(repeated).toMatchObject({ deduplicated: true });
    expect(store.getPendingMessages('alpha')).toHaveLength(1);
    sessions.delete('alpha');
    await expect(
      service.acceptInbound(
        { ...sourceRecord(), fleet: 'verified-fleet' },
        wire({ sourceSession: 'reviewer', destinationSession: 'alpha', message: 'peer note' }),
      ),
    ).resolves.toMatchObject({ status: 'received', deduplicated: true });
    await expect(
      service.acceptInbound(
        { ...sourceRecord(), fleet: 'verified-fleet' },
        wire({ sourceSession: 'reviewer', destinationSession: 'alpha', message: 'changed' }),
      ),
    ).rejects.toMatchObject({ code: 'message_invalid' });

    now = 11_000;
    expect(service.inboundStatus({ ...sourceRecord(), fleet: 'verified-fleet' }, 'reviewer', wire().messageId)).toBe(
      'expired',
    );
    expect(store.getPendingMessages('alpha')).toHaveLength(0);
  });

  it('keys inbound retries and status to the stable source instance across a friendly fleet rename', async () => {
    const source = sourceRecord();
    const message = wire({ sourceSession: 'reviewer', message: 'survive rename' });
    await expect(service.acceptInbound({ ...source, fleet: 'fleet-old' }, message)).resolves.toMatchObject({
      deduplicated: false,
    });
    await expect(service.acceptInbound({ ...source, fleet: 'fleet-new' }, message)).resolves.toMatchObject({
      deduplicated: true,
      status: 'received',
    });
    expect(service.inboundStatus({ ...source, fleet: 'fleet-new' }, 'reviewer', message.messageId)).toBe('received');
    expect(() => service.inboundStatus({ ...source, fleet: 'fleet-new' }, 'other', message.messageId)).toThrow(
      /was not found/,
    );
    expect(store.getFederationInbox(message.messageId)).toMatchObject({
      source_instance_id: source.instanceId,
      source_address: 'reviewer@fleet-old',
    });
  });

  it('renders collisions but refuses to choose between distinct instances', async () => {
    adapter.routes = [route('beta@fleet-b', 'instance-b1'), route('beta@fleet-b', 'instance-b2')];
    expect((await service.listPeers()).every((peer) => peer.ambiguous === true)).toBe(true);
    await expect(service.sendToPeer('alpha', 'beta@fleet-b', 'hello')).rejects.toThrow(
      /advertised by multiple instances/,
    );
  });
});

function session(codename: string): SessionConfig {
  return { codename, repo: `/tmp/${codename}`, runtime: 'claude-code', additionalDirs: [], schedules: [] };
}

function route(address: string, instanceId: string): FederationPeerRoute {
  const [codename = '', fleet = ''] = address.split('@');
  return {
    instanceId,
    fleet,
    codename,
    address,
    presence: 'stopped',
    capabilities: ['messages'],
    transport: 'local',
  };
}

function sourceRecord(): FederationPrincipal {
  return {
    instanceId: '22222222-2222-4222-8222-222222222222',
    fleet: 'fleet-b',
  };
}

function wire(overrides: Partial<FederatedWireMessage> = {}): FederatedWireMessage {
  return {
    version: 1,
    messageId: '11111111-1111-4111-8111-111111111111',
    sourceSession: 'beta',
    destinationSession: 'alpha',
    message: 'hello',
    createdAt: 1_000,
    expiresAt: 10_000,
    ...overrides,
  };
}

class FakeFederationAdapter implements FederationAdapter {
  readonly id = 'local' as const;
  routes: FederationPeerRoute[] = [];
  sent: FederatedWireMessage[] = [];
  sendError: Error | undefined;
  remoteStatus: 'received' | 'delivered' | 'expired' | 'failed' = 'received';
  publicDescription: string | undefined;

  start(): Promise<void> {
    return Promise.resolve();
  }
  stop(): Promise<void> {
    return Promise.resolve();
  }
  updatePublicDescription(description: string | undefined): void {
    this.publicDescription = description;
  }
  directory(): Promise<FederationPeerRoute[]> {
    return Promise.resolve(this.routes);
  }
  send(_route: FederationPeerRoute, message: FederatedWireMessage): Promise<FederationHopReceipt> {
    this.sent.push(message);
    if (this.sendError !== undefined) return Promise.reject(this.sendError);
    return Promise.resolve({ messageId: message.messageId, status: 'received', deduplicated: false });
  }
  status(): Promise<'received' | 'delivered' | 'expired' | 'failed'> {
    return Promise.resolve(this.remoteStatus);
  }
  health(): FederationAdapterHealth {
    return { lastContactAt: null, lastErrorCode: null };
  }
}
