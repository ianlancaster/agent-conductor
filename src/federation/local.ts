import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { log } from '../logger.js';
import { hasControlCharacters } from '../text.js';
import { LocalFederationRegistry, type LocalRegistryRecord } from './registry.js';
import { parseFederationAddress } from './address.js';
import {
  FEDERATION_PROTOCOL_VERSION,
  FederationError,
  isFederationErrorCode,
  MAX_FEDERATION_BODY_BYTES,
  MAX_FEDERATION_DIRECTORY_BYTES,
  MAX_FEDERATION_DIRECTORY_ENTRIES,
  type FederatedWireMessage,
  type FederationAdapter,
  type FederationAdapterHealth,
  type FederationHopReceipt,
  type FederationPeerRoute,
  type FederationPrincipal,
  type PeerDirectoryEntry,
} from './types.js';

const REQUEST_TIMEOUT_MS = 5_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface LocalFederationAdapterOptions {
  registryDir: string;
  instanceId: string;
  fleet: string;
  description?: string;
  heartbeatMs: number;
  staleAfterMs: number;
  exposedDirectory(): PeerDirectoryEntry[];
  accept(source: FederationPrincipal, message: FederatedWireMessage): Promise<FederationHopReceipt>;
  status(
    source: FederationPrincipal,
    sourceSession: string,
    messageId: string,
  ): Promise<'received' | 'delivered' | 'expired' | 'failed'>;
  now?: () => number;
  pid?: number;
  pidAlive?: (pid: number) => boolean;
}

/** Loopback HTTP transport plus same-UID registry discovery. */
export class LocalFederationAdapter implements FederationAdapter {
  readonly id = 'local' as const;
  private server: Server | undefined;
  private registry: LocalFederationRegistry | undefined;
  private readonly activeRequests = new Set<Promise<void>>();
  private accepting = false;
  private lastContactAt: number | null = null;
  private lastErrorCode: string | null = null;

  constructor(private readonly options: LocalFederationAdapterOptions) {}

  async start(): Promise<void> {
    if (this.server !== undefined) throw new Error('Local federation adapter already started.');
    const server = createServer((request, response) => {
      const handling = this.handle(request, response).catch((error: unknown) => {
        log().error('federation', `Unhandled local peer request: ${safeErrorCode(error)}`);
        if (!response.headersSent)
          this.respondError(response, new FederationError('internal_error', 'Internal error.', true));
      });
      this.activeRequests.add(handling);
      void handling.finally(() => {
        this.activeRequests.delete(handling);
      });
    });
    server.headersTimeout = REQUEST_TIMEOUT_MS;
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    await listenLoopback(server);
    const address = server.address();
    if (address === null || typeof address === 'string') {
      await closeServer(server);
      throw new Error('Local federation server did not receive a TCP port.');
    }
    this.server = server;
    this.registry = new LocalFederationRegistry({
      registryDir: this.options.registryDir,
      instanceId: this.options.instanceId,
      fleet: this.options.fleet,
      ...(this.options.description !== undefined ? { description: this.options.description } : {}),
      endpoint: `http://127.0.0.1:${String(address.port)}/federation/v1`,
      heartbeatMs: this.options.heartbeatMs,
      staleAfterMs: this.options.staleAfterMs,
      ...(this.options.now !== undefined ? { now: this.options.now } : {}),
      ...(this.options.pid !== undefined ? { pid: this.options.pid } : {}),
      ...(this.options.pidAlive !== undefined ? { pidAlive: this.options.pidAlive } : {}),
    });
    try {
      this.registry.start();
    } catch (error) {
      this.registry = undefined;
      this.server = undefined;
      await closeServer(server);
      throw error;
    }
    this.accepting = true;
    log().info('federation', `Local federation '${this.options.fleet}' listening on loopback.`);
  }

  async stop(): Promise<void> {
    this.accepting = false;
    try {
      this.registry?.stop();
    } catch (error) {
      this.lastErrorCode = 'registry_io';
      log().warn('federation', `Local registry cleanup failed (${safeErrorCode(error)}).`);
    }
    this.registry = undefined;
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) await closeServer(server);
    await Promise.allSettled([...this.activeRequests]);
  }

  async directory(): Promise<FederationPeerRoute[]> {
    const registry = this.requireRegistry();
    const peers = registry.records().filter((record) => record.instanceId !== this.options.instanceId);
    const results = await Promise.allSettled(
      peers.map(async (peer) => {
        const result = parseDirectoryResponse(await this.request(peer, '/directory', { method: 'GET' }));
        return result.map((entry) => {
          const address = parseFederationAddress(entry.address);
          if (
            entry.instanceId !== peer.instanceId ||
            entry.fleet !== peer.fleet ||
            entry.codename !== address.codename ||
            address.fleet !== peer.fleet
          ) {
            throw new FederationError(
              'message_invalid',
              `Local peer ${peer.instanceId} returned a forged directory entry.`,
            );
          }
          return {
            ...entry,
            ...(peer.description !== undefined ? { fleetDescription: peer.description } : {}),
          };
        });
      }),
    );
    const routes: FederationPeerRoute[] = [];
    let failureCode: string | undefined;
    for (const result of results) {
      if (result.status === 'fulfilled') routes.push(...result.value);
      else {
        failureCode ??= safeErrorCode(result.reason);
        log().debug('federation', `Local peer directory refresh failed (${safeErrorCode(result.reason)}).`);
      }
    }
    if (failureCode !== undefined) this.lastErrorCode = failureCode;
    else if (peers.length > 0) this.lastErrorCode = null;
    return routes;
  }

  async send(route: FederationPeerRoute, message: FederatedWireMessage): Promise<FederationHopReceipt> {
    const result = await this.request({ instanceId: route.instanceId }, '/messages', {
      method: 'POST',
      body: message,
    });
    return parseHopReceipt(result, message.messageId);
  }

  async status(
    route: FederationPeerRoute,
    messageId: string,
    sourceSession: string,
  ): Promise<'received' | 'delivered' | 'expired' | 'failed'> {
    const result = await this.request(
      { instanceId: route.instanceId },
      `/messages/${encodeURIComponent(messageId)}?sourceSession=${encodeURIComponent(sourceSession)}`,
      { method: 'GET' },
    );
    return parseStatusResponse(result);
  }

  health(): FederationAdapterHealth {
    const registry = this.registry?.health();
    return {
      lastContactAt: this.lastContactAt,
      lastErrorCode: registry?.lastErrorCode ?? this.lastErrorCode,
    };
  }

  updatePublicDescription(description: string | undefined): void {
    this.registry?.updateDescription(description);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.accepting) {
      this.respondError(response, new FederationError('peer_unavailable', 'Local federation is stopping.', true));
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    if (!path.startsWith('/federation/v1/')) {
      this.respondError(response, new FederationError('message_invalid', 'Not found.'), 404);
      return;
    }
    const source = this.authenticate(request);
    if (source === undefined) {
      this.respondError(
        response,
        new FederationError('auth_invalid', 'Local peer credential was not recognized.', true),
        401,
      );
      return;
    }
    try {
      if (request.method === 'GET' && path === '/federation/v1/directory') {
        this.respondJson(response, 200, {
          ok: true,
          version: FEDERATION_PROTOCOL_VERSION,
          entries: this.options.exposedDirectory(),
        });
        return;
      }
      if (request.method === 'POST' && path === '/federation/v1/messages') {
        const body = await readJsonBody(request);
        const receipt = await this.options.accept(source, parseWireMessage(body));
        this.respondJson(response, 200, { ok: true, version: FEDERATION_PROTOCOL_VERSION, receipt });
        return;
      }
      if (request.method === 'GET' && path.startsWith('/federation/v1/messages/')) {
        const messageId = decodeURIComponent(path.slice('/federation/v1/messages/'.length));
        if (messageId.length === 0) throw new FederationError('message_invalid', 'Message id is required.');
        const sourceSession = url.searchParams.get('sourceSession');
        if (sourceSession === null) {
          throw new FederationError('message_invalid', 'Source session is required.');
        }
        parseFederationAddress(`${sourceSession}@${source.fleet}`);
        const status = await this.options.status(source, sourceSession, messageId);
        this.respondJson(response, 200, { ok: true, version: FEDERATION_PROTOCOL_VERSION, status });
        return;
      }
      this.respondError(response, new FederationError('message_invalid', 'Not found.'), 404);
    } catch (error) {
      const federationError =
        error instanceof FederationError
          ? error
          : new FederationError('internal_error', 'Local federation request failed.', true);
      this.respondError(response, federationError);
    }
  }

  private authenticate(request: IncomingMessage): FederationPrincipal | undefined {
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return undefined;
    const presented = authorization.slice('Bearer '.length);
    for (const record of this.requireRegistry().records()) {
      if (safeEqual(record.credential, presented)) return { instanceId: record.instanceId, fleet: record.fleet };
    }
    // records() is authoritative and rereads disk on every call, so a miss
    // naturally invalidates any prior view after peer restart/key rotation.
    return undefined;
  }

  private async request(
    peer: Pick<LocalRegistryRecord, 'instanceId'>,
    path: string,
    options: { method: 'GET' | 'POST'; body?: unknown },
  ): Promise<Record<string, unknown>> {
    const registry = this.requireRegistry();
    const current = registry.records().find((record) => record.instanceId === peer.instanceId);
    if (current === undefined) {
      throw new FederationError('peer_unavailable', `Local peer ${peer.instanceId} is unavailable.`, true);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${current.endpoint}${path}`, {
        method: options.method,
        headers: {
          authorization: `Bearer ${registry.ownRecord().credential}`,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });
      const body = await readResponseJson(
        response,
        path === '/directory' ? MAX_FEDERATION_DIRECTORY_BYTES : MAX_FEDERATION_BODY_BYTES,
      );
      if (!response.ok) throw parsePeerError(body, response.status);
      if (!isObject(body) || body.ok !== true || body.version !== FEDERATION_PROTOCOL_VERSION) {
        throw new FederationError('version_unsupported', 'Local peer returned an incompatible response.');
      }
      this.lastContactAt = this.options.now?.() ?? Date.now();
      this.lastErrorCode = null;
      return body;
    } catch (error) {
      const wrapped =
        error instanceof FederationError
          ? error
          : new FederationError('peer_unavailable', `Local peer ${peer.instanceId} is unavailable.`, true);
      this.lastErrorCode = wrapped.code;
      throw wrapped;
    } finally {
      clearTimeout(timeout);
    }
  }

  private requireRegistry(): LocalFederationRegistry {
    if (this.registry === undefined)
      throw new FederationError('peer_unavailable', 'Local federation is not running.', true);
    return this.registry;
  }

  private respondError(response: ServerResponse, error: FederationError, status = httpStatus(error)): void {
    this.respondJson(response, status, {
      ok: false,
      version: FEDERATION_PROTOCOL_VERSION,
      error: { code: error.code, message: error.message, retryable: error.retryable },
    });
  }

  private respondJson(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  }
}

function parseWireMessage(value: unknown): FederatedWireMessage {
  if (!isObject(value)) throw new FederationError('message_invalid', 'Federated message body must be an object.');
  if (value.version !== FEDERATION_PROTOCOL_VERSION) {
    throw new FederationError('version_unsupported', 'Federation protocol version is not supported.');
  }
  for (const field of ['messageId', 'sourceSession', 'destinationSession', 'message'] as const) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      throw new FederationError('message_invalid', `Federated message '${field}' is required.`);
    }
  }
  for (const field of ['createdAt', 'expiresAt'] as const) {
    if (typeof value[field] !== 'number' || !Number.isFinite(value[field])) {
      throw new FederationError('message_invalid', `Federated message '${field}' is required.`);
    }
  }
  return value as unknown as FederatedWireMessage;
}

function parseDirectoryResponse(value: Record<string, unknown>): PeerDirectoryEntry[] {
  if (!Array.isArray(value.entries) || value.entries.length > MAX_FEDERATION_DIRECTORY_ENTRIES) {
    throw new FederationError('message_invalid', 'Local peer returned an invalid directory.');
  }
  return value.entries.map((candidate) => {
    if (!isObject(candidate))
      throw new FederationError('message_invalid', 'Local peer returned an invalid directory entry.');
    const address = typeof candidate.address === 'string' ? parseFederationAddress(candidate.address) : undefined;
    if (
      typeof candidate.instanceId !== 'string' ||
      !UUID_PATTERN.test(candidate.instanceId) ||
      typeof candidate.fleet !== 'string' ||
      typeof candidate.codename !== 'string' ||
      address?.fleet !== candidate.fleet ||
      address.codename !== candidate.codename ||
      (candidate.fleetDescription !== undefined &&
        (typeof candidate.fleetDescription !== 'string' ||
          candidate.fleetDescription.length > 200 ||
          hasControlCharacters(candidate.fleetDescription))) ||
      (candidate.description !== undefined &&
        (typeof candidate.description !== 'string' ||
          candidate.description.length > 200 ||
          hasControlCharacters(candidate.description))) ||
      (candidate.presence !== 'running' && candidate.presence !== 'stopped') ||
      !Array.isArray(candidate.capabilities) ||
      candidate.capabilities.length !== 1 ||
      candidate.capabilities[0] !== 'messages' ||
      candidate.transport !== 'local'
    ) {
      throw new FederationError('message_invalid', 'Local peer returned an invalid directory entry.');
    }
    return {
      instanceId: candidate.instanceId,
      fleet: candidate.fleet,
      codename: candidate.codename,
      address: address.qualified,
      ...(candidate.description !== undefined ? { description: candidate.description } : {}),
      presence: candidate.presence,
      capabilities: ['messages'],
      transport: 'local' as const,
    };
  });
}

function parseHopReceipt(value: Record<string, unknown>, expectedMessageId: string): FederationHopReceipt {
  const receipt = value.receipt;
  if (
    !isObject(receipt) ||
    receipt.messageId !== expectedMessageId ||
    (receipt.status !== 'received' && receipt.status !== 'delivered') ||
    typeof receipt.deduplicated !== 'boolean'
  ) {
    throw new FederationError('message_invalid', 'Local peer returned an invalid message receipt.');
  }
  return receipt as unknown as FederationHopReceipt;
}

function parseStatusResponse(value: Record<string, unknown>): 'received' | 'delivered' | 'expired' | 'failed' {
  if (
    value.status !== 'received' &&
    value.status !== 'delivered' &&
    value.status !== 'expired' &&
    value.status !== 'failed'
  ) {
    throw new FederationError('message_invalid', 'Local peer returned an invalid message status.');
  }
  return value.status;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_FEDERATION_BODY_BYTES) {
      throw new FederationError('message_invalid', 'Federation request body is too large.');
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new FederationError('message_invalid', 'Federation request body is not valid JSON.');
  }
}

function parsePeerError(value: unknown, status: number): FederationError {
  if (isObject(value) && isObject(value.error) && isFederationErrorCode(value.error.code)) {
    const code = value.error.code;
    const message =
      typeof value.error.message === 'string' ? value.error.message : `Local peer error ${String(status)}.`;
    const retryable =
      status >= 500 || code === 'internal_error' || code === 'peer_unavailable' || value.error.retryable === true;
    return new FederationError(code, message, retryable);
  }
  return new FederationError(
    status >= 500 ? 'peer_unavailable' : 'message_invalid',
    `Local peer request failed with HTTP ${String(status)}.`,
    status >= 500,
  );
}

async function readResponseJson(response: Response, maxBytes: number): Promise<unknown> {
  if (response.body === null) throw new FederationError('message_invalid', 'Local peer returned invalid JSON.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    const chunk = result.value as unknown as Uint8Array;
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new FederationError('message_invalid', 'Local peer response body is too large.');
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new FederationError('message_invalid', 'Local peer returned invalid JSON.');
  }
}

function httpStatus(error: FederationError): number {
  if (error.code === 'auth_invalid') return 401;
  if (error.code === 'recipient_hidden' || error.code === 'unknown_fleet') return 404;
  if (error.code === 'internal_error' || error.code === 'peer_unavailable') return 503;
  return 400;
}

function listenLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeErrorCode(error: unknown): string {
  return error instanceof FederationError ? error.code : error instanceof Error ? error.name : 'unknown_error';
}
