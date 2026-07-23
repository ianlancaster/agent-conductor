import { randomUUID } from 'node:crypto';
import type { SessionConfig } from '../config/schema.js';
import type { Messaging } from '../core/messaging.js';
import type { SessionStateManager } from '../core/state.js';
import { log } from '../logger.js';
import type { FederationOutboxRow, Store } from '../store/index.js';
import { parseFederationAddress, qualifyFederationAddress, validateFederatedMessage } from './address.js';
import {
  DEFAULT_FEDERATION_TTL_MS,
  FEDERATION_CAPABILITIES,
  FEDERATION_PROTOCOL_VERSION,
  FederationError,
  type FederatedWireMessage,
  type FederationAdapter,
  type FederationMessageReceipt,
  type FederationMessageStatus,
  type FederationPeerRoute,
  type FederationPrincipal,
  type PeerDirectoryEntry,
} from './types.js';

const INSTANCE_ID_WORKSPACE_KEY = 'federation.instanceId';
const DRAIN_LIMIT = 20;
const DRAIN_WALL_BUDGET_MS = 12_000;
const STATUS_POLL_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const FEDERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface FederationServiceConfig {
  fleet: string;
  description?: string;
  exposedSessions: readonly string[];
  sessionDescriptions: Record<string, string>;
}

export type FederationPolicy = Omit<FederationServiceConfig, 'fleet'>;

export interface FederationServiceDeps {
  store: Store;
  messaging: Messaging;
  states: SessionStateManager;
  sessions(): Map<string, SessionConfig>;
  adapter: FederationAdapter;
  config: FederationServiceConfig;
  now?: () => number;
  random?: () => number;
}

export interface FederationHealth {
  adapter: FederationAdapter['id'];
  running: boolean;
  lastContactAt: number | null;
  queued: number;
  received: number;
  oldestPendingAgeMs: number | null;
  lastErrorCode: string | null;
}

export function federationInstanceId(store: Store): string {
  const existing = store.getWorkspaceValue<string>(INSTANCE_ID_WORKSPACE_KEY);
  if (existing !== undefined) {
    if (!UUID_PATTERN.test(existing)) {
      throw new Error(
        'Stored federation instance identity is invalid; repair the fleet database before enabling federation.',
      );
    }
    return existing;
  }
  const created = randomUUID();
  store.setWorkspaceValue(INSTANCE_ID_WORKSPACE_KEY, created);
  return created;
}

export function renderFederationReceipt(receipt: FederationMessageReceipt): string {
  const duplicate = receipt.deduplicated ? ' (deduplicated)' : '';
  return `${capitalize(receipt.status)} peer message ${receipt.messageId} for ${receipt.recipient}${duplicate}.`;
}

/** Transport-independent local federation policy, persistence, and retry ownership. */
export class FederationService {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly lastKnownRouteByAddress = new Map<string, FederationPeerRoute>();
  private drainTimer: NodeJS.Timeout | undefined;
  private draining: Promise<void> | undefined;
  private running = false;
  private lastContactAt: number | null = null;
  private lastErrorCode: string | null = null;
  private nextCleanupAt = 0;

  constructor(private readonly deps: FederationServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
  }

  async start(): Promise<void> {
    await this.deps.adapter.start();
    this.running = true;
    this.drainTimer = setInterval(() => {
      void this.drainNow().catch((error: unknown) => {
        this.lastErrorCode = errorCode(error);
        log().error('federation', `Scheduled federation drain failed (${errorCode(error)}).`);
      });
    }, STATUS_POLL_MS);
    this.drainTimer.unref();
    await this.drainNow();
  }

  async stop(): Promise<void> {
    if (this.drainTimer !== undefined) clearInterval(this.drainTimer);
    this.drainTimer = undefined;
    try {
      // Quiesce inbound transport before delivery/store shutdown. In-flight
      // outbound work remains durable and will retry after the next start.
      await this.deps.adapter.stop();
      try {
        await this.draining;
      } catch (error) {
        this.lastErrorCode = errorCode(error);
        log().error('federation', `Federation drain failed during shutdown (${errorCode(error)}).`);
      }
    } finally {
      this.running = false;
    }
  }

  exposedDirectory(instanceId: string): PeerDirectoryEntry[] {
    const exposed = this.exposedSet();
    return [...exposed].sort().flatMap((codename) => {
      if (!this.deps.sessions().has(codename)) return [];
      return [
        {
          instanceId,
          fleet: this.deps.config.fleet,
          codename,
          address: qualifyFederationAddress(codename, this.deps.config.fleet),
          ...(this.deps.config.sessionDescriptions[codename] !== undefined
            ? { description: this.deps.config.sessionDescriptions[codename] }
            : {}),
          presence: this.deps.states.get(codename)?.running === true ? 'running' : 'stopped',
          capabilities: [...FEDERATION_CAPABILITIES],
          transport: 'local',
        },
      ];
    });
  }

  updatePolicy(policy: FederationPolicy): void {
    this.deps.adapter.updatePublicDescription(policy.description);
    this.deps.config.description = policy.description;
    this.deps.config.exposedSessions = policy.exposedSessions;
    this.deps.config.sessionDescriptions = policy.sessionDescriptions;
  }

  async listPeers(): Promise<PeerDirectoryEntry[]> {
    const routes = await this.directory();
    this.rememberRoutes(routes);
    const byAddress = new Map<string, FederationPeerRoute[]>();
    for (const route of routes) {
      const group = byAddress.get(route.address) ?? [];
      group.push(route);
      byAddress.set(route.address, group);
    }
    return [...byAddress.values()]
      .flatMap((group) => {
        const instances = new Set(group.map((entry) => entry.instanceId));
        return instances.size > 1 ? group.map((entry) => ({ ...entry, ambiguous: true as const })) : group;
      })
      .sort(
        (left, right) => left.address.localeCompare(right.address) || left.instanceId.localeCompare(right.instanceId),
      );
  }

  async sendToPeer(
    sourceSession: string,
    destination: string,
    message: string,
    idempotencyKey?: string,
  ): Promise<FederationMessageReceipt> {
    this.requireExposed(sourceSession);
    validateFederatedMessage(message);
    const address = parseFederationAddress(destination);
    if (address.fleet === this.deps.config.fleet) {
      throw new FederationError(
        'address_invalid',
        `Peer address '${address.qualified}' belongs to this fleet; use send_to_session for local delivery.`,
      );
    }
    if (idempotencyKey !== undefined) {
      const existing = this.deps.store.getFederationOutboxByIdempotencyKey(sourceSession, idempotencyKey);
      if (existing !== undefined) return this.receipt(existing, true);
    }
    const route = await this.resolveRoute(address.qualified);
    const now = this.now();
    const inserted = this.deps.store.insertFederationOutbox({
      messageId: randomUUID(),
      senderSession: sourceSession,
      destinationAddress: address.qualified,
      destinationInstanceId: route.instanceId,
      content: message,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      now,
      expiresAt: now + DEFAULT_FEDERATION_TTL_MS,
    });
    if (inserted.deduplicated) return this.receipt(inserted.row, true);
    await this.processQueued(inserted.row, new Map([[route.instanceId, route]]));
    const current = this.deps.store.getFederationOutbox(inserted.row.message_id);
    if (current === undefined) throw new Error(`Federated message ${inserted.row.message_id} disappeared.`);
    return this.receipt(current, false);
  }

  messageStatus(messageId: string, requester?: string): FederationMessageStatus | undefined {
    const row = this.deps.store.getFederationOutbox(messageId);
    if (row === undefined || (requester !== undefined && row.sender_session !== requester)) return undefined;
    return {
      messageId: row.message_id,
      sender: qualifyFederationAddress(row.sender_session, this.deps.config.fleet),
      recipient: row.destination_address,
      status: row.state,
      attempts: row.attempt_count,
      lastError: row.last_error_code,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      receivedAt: row.received_at,
      deliveredAt: row.delivered_at,
    };
  }

  health(): FederationHealth {
    const outbox = this.deps.store.getFederationOutboxHealth();
    const adapter = this.deps.adapter.health();
    const now = this.now();
    return {
      adapter: this.deps.adapter.id,
      running: this.running,
      lastContactAt: mostRecent(this.lastContactAt, adapter.lastContactAt),
      queued: outbox.queued,
      received: outbox.received,
      oldestPendingAgeMs: outbox.oldestPendingAt === null ? null : Math.max(0, now - outbox.oldestPendingAt),
      lastErrorCode: adapter.lastErrorCode ?? this.lastErrorCode,
    };
  }

  async acceptInbound(
    source: FederationPrincipal,
    message: FederatedWireMessage,
  ): Promise<{
    messageId: string;
    status: 'received' | 'delivered';
    deduplicated: boolean;
  }> {
    validateWireMessage(message, this.now());
    const sourceAddress = qualifyFederationAddress(message.sourceSession, source.fleet);
    const existing = this.deps.store.getFederationInbox(message.messageId);
    const existingMessage = this.deps.store.getFederationInboxMessage(message.messageId);
    if (
      existing !== undefined &&
      (existingMessage === undefined ||
        existing.source_instance_id !== source.instanceId ||
        parseFederationAddress(existing.source_address).codename !== message.sourceSession ||
        existing.recipient_session !== message.destinationSession ||
        existing.expires_at !== message.expiresAt ||
        existingMessage.content !== message.message)
    ) {
      throw new FederationError(
        'message_invalid',
        `Federated message '${message.messageId}' conflicts with an existing immutable message.`,
      );
    }
    if (existing !== undefined && existingMessage !== undefined) {
      this.noteContact();
      return {
        messageId: message.messageId,
        status: existingMessage.status === 'delivered' ? 'delivered' : 'received',
        deduplicated: true,
      };
    }
    this.requireExposed(message.destinationSession, true);
    const receipt = await this.deps.messaging.acceptInboundFederated({
      messageId: message.messageId,
      sourceInstanceId: source.instanceId,
      sourceAddress,
      recipient: message.destinationSession,
      message: message.message,
      receivedAt: this.now(),
      expiresAt: message.expiresAt,
    });
    this.noteContact();
    return receipt;
  }

  inboundStatus(
    source: FederationPrincipal,
    sourceSession: string,
    messageId: string,
  ): 'received' | 'delivered' | 'expired' | 'failed' {
    const inbox = this.deps.store.getFederationInbox(messageId);
    const local = this.deps.store.getFederationInboxMessage(messageId);
    if (
      inbox === undefined ||
      local === undefined ||
      inbox.source_instance_id !== source.instanceId ||
      parseFederationAddress(inbox.source_address).codename !== sourceSession
    ) {
      throw new FederationError('message_invalid', `Federated message '${messageId}' was not found.`);
    }
    this.noteContact();
    if (local.status === 'delivered') return 'delivered';
    if (local.status === 'cancelled') return inbox.expires_at <= this.now() ? 'expired' : 'failed';
    if (inbox.expires_at <= this.now()) {
      this.deps.store.markMessageCancelled(local.id);
      return 'expired';
    }
    return 'received';
  }

  drainNow(): Promise<void> {
    if (this.draining !== undefined) return this.draining;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
    });
    return this.draining;
  }

  private async drain(): Promise<void> {
    const now = this.now();
    if (now >= this.nextCleanupAt) {
      this.deps.store.cleanupFederationHistory(now - FEDERATION_RETENTION_MS);
      this.nextCleanupAt = now + CLEANUP_INTERVAL_MS;
    }
    const wallDeadline = Date.now() + DRAIN_WALL_BUDGET_MS;
    const due = this.deps.store.getDueFederationOutbox(now, DRAIN_LIMIT);
    if (due.length === 0) return;
    let routes: FederationPeerRoute[] = [];
    try {
      routes = await this.directory();
    } catch (error) {
      this.lastErrorCode = errorCode(error);
      log().warn('federation', `Directory refresh failed (${errorCode(error)}).`);
    }
    const byInstance = new Map(routes.map((route) => [route.instanceId, route]));
    for (const row of due) {
      if (Date.now() >= wallDeadline) break;
      if (row.expires_at <= now) {
        if (row.state === 'received') {
          await this.processReceived(row, byInstance);
          if (this.deps.store.getFederationOutbox(row.message_id)?.state === 'delivered') continue;
        }
        this.deps.store.markFederationOutboxTerminal(row.message_id, 'expired', now, 'message_expired');
        continue;
      }
      if (row.state === 'queued') await this.processQueued(row, byInstance);
      else await this.processReceived(row, byInstance);
    }
  }

  private async processQueued(row: FederationOutboxRow, routes: Map<string, FederationPeerRoute>): Promise<void> {
    const route = routes.get(row.destination_instance_id) ?? this.persistedRoute(row);
    const address = parseFederationAddress(row.destination_address);
    try {
      const receipt = await this.deps.adapter.send(route, {
        version: FEDERATION_PROTOCOL_VERSION,
        messageId: row.message_id,
        sourceSession: row.sender_session,
        destinationSession: address.codename,
        message: row.content,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      });
      if (receipt.messageId !== row.message_id) {
        throw new FederationError('message_invalid', 'Peer receipt message id did not match the sent message.');
      }
      this.noteContact();
      const now = this.now();
      if (receipt.status === 'delivered') {
        this.deps.store.markFederationOutboxTerminal(row.message_id, 'delivered', now);
      } else {
        this.deps.store.markFederationOutboxReceived(row.message_id, now, now + STATUS_POLL_MS);
      }
    } catch (error) {
      this.handleAttemptError(row, error);
    }
  }

  private async processReceived(row: FederationOutboxRow, routes: Map<string, FederationPeerRoute>): Promise<void> {
    const route = routes.get(row.destination_instance_id) ?? this.persistedRoute(row);
    try {
      const status = await this.deps.adapter.status(route, row.message_id, row.sender_session);
      this.noteContact();
      if (status === 'delivered') {
        this.deps.store.markFederationOutboxTerminal(row.message_id, 'delivered', this.now());
      } else if (status === 'expired' || status === 'failed') {
        this.deps.store.markFederationOutboxTerminal(row.message_id, status, this.now(), status);
      } else {
        const now = this.now();
        this.deps.store.scheduleFederationStatusCheck(row.message_id, now + STATUS_POLL_MS, now);
      }
    } catch (error) {
      this.handleAttemptError(row, error);
    }
  }

  private handleAttemptError(row: FederationOutboxRow, error: unknown): void {
    if (error instanceof FederationError && !error.retryable) {
      this.lastErrorCode = error.code;
      this.deps.store.markFederationOutboxTerminal(row.message_id, 'failed', this.now(), error.code);
      this.deps.store.logHealthEvent(row.sender_session, 'federation-failed', error.code);
      return;
    }
    this.defer(row, errorCode(error));
  }

  private defer(row: FederationOutboxRow, code: string): void {
    this.lastErrorCode = code;
    const base = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(row.attempt_count, 6));
    const jittered = Math.round(base * (0.75 + this.random() * 0.5));
    const now = this.now();
    this.deps.store.recordFederationOutboxAttempt(row.message_id, now + jittered, now, code);
  }

  private async resolveRoute(address: string): Promise<FederationPeerRoute> {
    const routes = await this.directory();
    this.rememberRoutes(routes);
    const matches = routes.filter((route) => route.address === address);
    const instanceIds = new Set(matches.map((route) => route.instanceId));
    if (instanceIds.size > 1) {
      throw new FederationError(
        'instance_collision',
        `Peer address '${address}' is advertised by multiple instances; run list_peers and rename one fleet.`,
      );
    }
    const route = matches[0];
    if (route !== undefined) return route;
    const parsed = parseFederationAddress(address);
    if (routes.some((candidate) => candidate.fleet === parsed.fleet)) {
      throw new FederationError('recipient_hidden', `Peer session '${address}' is not exposed by its fleet.`);
    }
    const known = this.lastKnownRouteByAddress.get(address);
    if (known !== undefined) return known;
    throw new FederationError('unknown_fleet', `Peer fleet '${parsed.fleet}' is not currently discoverable.`);
  }

  private rememberRoutes(routes: readonly FederationPeerRoute[]): void {
    const byAddress = new Map<string, FederationPeerRoute[]>();
    for (const route of routes) {
      const group = byAddress.get(route.address) ?? [];
      group.push(route);
      byAddress.set(route.address, group);
    }
    for (const [address, group] of byAddress) {
      const instanceIds = new Set(group.map((route) => route.instanceId));
      if (instanceIds.size === 1 && group[0] !== undefined) {
        this.lastKnownRouteByAddress.set(address, group[0]);
      } else {
        this.lastKnownRouteByAddress.delete(address);
      }
    }
  }

  private async directory(): Promise<FederationPeerRoute[]> {
    try {
      const routes = await this.deps.adapter.directory();
      return routes;
    } catch (error) {
      this.lastErrorCode = errorCode(error);
      throw error;
    }
  }

  private noteContact(): void {
    this.lastContactAt = this.now();
    this.lastErrorCode = null;
  }

  private exposedSet(): Set<string> {
    return new Set(
      this.deps.config.exposedSessions.includes('*') ? this.deps.sessions().keys() : this.deps.config.exposedSessions,
    );
  }

  private requireExposed(codename: string, inbound = false): void {
    if (!this.deps.sessions().has(codename) || !this.exposedSet().has(codename)) {
      throw new FederationError(
        'recipient_hidden',
        `Session '${codename}' is not in federation.sessions.expose and cannot ${inbound ? 'receive' : 'send'} peer messages.`,
      );
    }
  }

  private receipt(row: FederationOutboxRow, deduplicated: boolean): FederationMessageReceipt {
    return {
      messageId: row.message_id,
      recipient: row.destination_address,
      status: row.state,
      deduplicated,
    };
  }

  /**
   * The local adapter resolves the current endpoint by stable instance id.
   * Keeping this route skeleton lets accepted work survive roster revocation
   * and lets queued work learn the peer's typed hidden-recipient result.
   */
  private persistedRoute(row: FederationOutboxRow): FederationPeerRoute {
    const address = parseFederationAddress(row.destination_address);
    return {
      instanceId: row.destination_instance_id,
      fleet: address.fleet,
      codename: address.codename,
      address: address.qualified,
      presence: 'stopped',
      capabilities: [...FEDERATION_CAPABILITIES],
      transport: 'local',
    };
  }
}

function validateWireMessage(message: FederatedWireMessage, now: number): void {
  if (message.version !== FEDERATION_PROTOCOL_VERSION) {
    throw new FederationError('version_unsupported', 'Federation protocol version is not supported.');
  }
  if (!UUID_PATTERN.test(message.messageId)) {
    throw new FederationError('message_invalid', 'Federated message id must be a UUID.');
  }
  validateFederatedMessage(message.message);
  if (
    message.createdAt > now + 60_000 ||
    message.expiresAt <= message.createdAt ||
    message.expiresAt - message.createdAt > DEFAULT_FEDERATION_TTL_MS
  ) {
    throw new FederationError('message_invalid', 'Federated message timestamps are invalid.');
  }
  if (message.expiresAt <= now) throw new FederationError('message_expired', 'Federated message has expired.');
}

function errorCode(error: unknown): string {
  return error instanceof FederationError ? error.code : 'peer_unavailable';
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
}

function mostRecent(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}
