import { CODENAME_PATTERN, FEDERATION_NAME_PATTERN } from '../config/schema.js';
import { InvalidRequestError } from '../core/errors.js';
import { isMessageReceipt } from '../core/messaging.js';
import type { ConductorOperations, OperationActor } from '../core/operations.js';
import { FEDERATION_PROTOCOL_VERSION, type FederationPeerRecord, type FederationRegistry } from './registry.js';
import type { FederationListing } from './types.js';

export type { FederationListing } from './types.js';

export interface FederationRequest {
  protocol: number;
  operation: string;
  arguments: Record<string, unknown>;
  originFleet: string;
  originSession: string;
  /**
   * Additive; absent means 'session'. An operator origin carries the operator's
   * mechanical signature across a room fan-out. It grants no extra authority:
   * peer callers reach only routable operations and stay exposure-filtered.
   */
  originKind?: 'session' | 'operator';
}

interface FederationResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
  invalid?: boolean;
}

export class FederationRouter {
  constructor(
    readonly localFleet: string,
    private readonly registry: FederationRegistry,
    private readonly operations: ConductorOperations,
  ) {}

  async listFederation(): Promise<FederationListing> {
    const peers = await this.registry.list();
    return {
      localFleet: this.localFleet,
      fleets: peers.map((peer) => ({ name: peer.name, sessions: [...peer.sessions].sort() })),
    };
  }

  /** Re-read the rendezvous directory so a room fan-out targets the live peer set. */
  async refresh(): Promise<void> {
    await this.registry.list();
  }

  /** Room membership peers publish about themselves, excluding this fleet. */
  peerRooms(): { fleet: string; room: string; members: string[] }[] {
    return this.registry
      .snapshot()
      .filter((peer) => peer.name !== this.localFleet)
      .flatMap((peer) => peer.rooms.map((room) => ({ fleet: peer.name, room: room.name, members: [...room.members] })));
  }

  /**
   * Call one already-identified peer. Used by room fan-out, which has resolved
   * its destinations from published membership rather than a `fleet` argument.
   */
  async invokeOnPeer(
    fleet: string,
    operationName: string,
    args: Record<string, unknown>,
    origin: { session: string; kind: 'session' | 'operator' },
  ): Promise<unknown> {
    const definition = this.operations.definition(operationName);
    if (!definition?.audiences.includes('session')) {
      throw new InvalidRequestError(`Unknown session operation: ${operationName}`);
    }
    if (definition.federation !== 'routable') {
      throw new InvalidRequestError(`${operationName} is local-only and cannot be routed to fleet '${fleet}'.`);
    }
    const peer = await this.registry.peer(fleet);
    if (peer === undefined) throw new InvalidRequestError(`Unknown or unavailable federation fleet: ${fleet}`);
    return this.callPeer(peer, {
      protocol: FEDERATION_PROTOCOL_VERSION,
      operation: operationName,
      arguments: args,
      originFleet: this.localFleet,
      originSession: origin.session,
      ...(origin.kind === 'operator' ? { originKind: 'operator' as const } : {}),
    });
  }

  async invokeFromSession(operationName: string, args: Record<string, unknown>, caller: string): Promise<unknown> {
    const definition = this.operations.definition(operationName);
    if (!definition?.audiences.includes('session')) {
      throw new InvalidRequestError(`Unknown session operation: ${operationName}`);
    }
    const routedArgs = { ...args };
    const target = routedArgs.codename;
    if (typeof target === 'string' && target.includes('@')) {
      throw new InvalidRequestError(
        "Do not qualify 'codename' with '@fleet'; pass the local codename and the separate 'fleet' argument.",
      );
    }
    const fleetValue = routedArgs.fleet;
    delete routedArgs.fleet;
    if (fleetValue !== undefined && (typeof fleetValue !== 'string' || fleetValue.trim().length === 0)) {
      throw new InvalidRequestError("'fleet' must be a non-empty string");
    }
    const fleet = typeof fleetValue === 'string' ? fleetValue : undefined;
    if (fleet !== undefined && !FEDERATION_NAME_PATTERN.test(fleet)) {
      throw new InvalidRequestError("'fleet' must be a valid federation name");
    }
    if (fleet === undefined || fleet === this.localFleet) {
      return this.operations.invoke(operationName, routedArgs, { audience: 'session', codename: caller });
    }
    if (definition.federation !== 'routable') {
      throw new InvalidRequestError(`${operationName} is local-only and cannot be routed to fleet '${fleet}'.`);
    }
    const peer = await this.registry.peer(fleet);
    if (peer === undefined) throw new InvalidRequestError(`Unknown or unavailable federation fleet: ${fleet}`);
    const result = await this.callPeer(peer, {
      protocol: FEDERATION_PROTOCOL_VERSION,
      operation: operationName,
      arguments: routedArgs,
      originFleet: this.localFleet,
      originSession: caller,
    });
    return isMessageReceipt(result) ? { ...result, fleet } : result;
  }

  async invokeFromPeer(body: unknown): Promise<unknown> {
    const request = this.parseRequest(body);
    if (request.protocol !== FEDERATION_PROTOCOL_VERSION) {
      throw new InvalidRequestError(
        `Incompatible federation protocol ${String(request.protocol)}; expected ${String(FEDERATION_PROTOCOL_VERSION)}.`,
      );
    }
    if (!CODENAME_PATTERN.test(request.originSession) || request.originSession.includes('@')) {
      throw new InvalidRequestError('Invalid federation origin session.');
    }
    if (!FEDERATION_NAME_PATTERN.test(request.originFleet)) {
      throw new InvalidRequestError('Invalid federation origin fleet.');
    }
    const originKind = request.originKind ?? 'session';
    if (originKind !== 'session' && originKind !== 'operator') {
      throw new InvalidRequestError('Invalid federation origin kind.');
    }
    // Keep the signature unambiguous: an operator origin is spelled exactly one
    // way, so `operator@fleet` can never be confused with a session codename.
    if (originKind === 'operator' && request.originSession !== 'operator') {
      throw new InvalidRequestError("A federation operator origin must use originSession 'operator'.");
    }
    if (request.originFleet === this.localFleet) {
      throw new InvalidRequestError('Federation origin fleet cannot equal the destination fleet.');
    }
    const peer = await this.registry.peer(request.originFleet);
    if (peer === undefined) {
      throw new InvalidRequestError(`Unknown or unavailable federation origin fleet: ${request.originFleet}`);
    }
    const definition = this.operations.definition(request.operation);
    if (definition === undefined || !definition.audiences.includes('session') || definition.federation !== 'routable') {
      throw new InvalidRequestError(`Operation '${request.operation}' is not routable through federation.`);
    }
    // A peer is always authorized as a peer session, whatever role it holds at
    // home: routable operations only, and always exposure-filtered.
    const actor: OperationActor = {
      audience: 'session',
      codename: `${request.originSession}@${request.originFleet}`,
      origin: { fleet: request.originFleet, session: request.originSession, kind: originKind },
    };
    return this.operations.invoke(request.operation, request.arguments, actor);
  }

  private parseRequest(body: unknown): FederationRequest {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new InvalidRequestError('Invalid federation request body.');
    }
    const candidate = body as Partial<FederationRequest>;
    if (
      typeof candidate.protocol !== 'number' ||
      !Number.isInteger(candidate.protocol) ||
      typeof candidate.operation !== 'string' ||
      typeof candidate.originFleet !== 'string' ||
      typeof candidate.originSession !== 'string' ||
      typeof candidate.arguments !== 'object' ||
      candidate.arguments === null ||
      Array.isArray(candidate.arguments)
    ) {
      throw new InvalidRequestError('Invalid federation request body.');
    }
    return candidate as FederationRequest;
  }

  private async callPeer(peer: FederationPeerRecord, request: FederationRequest): Promise<unknown> {
    let response: Response;
    try {
      const host = peer.host.includes(':') ? `[${peer.host}]` : peer.host;
      // Routed lifecycle operations can legitimately wait for a runtime to
      // launch; the configured MCP caller timeout remains the outer bound.
      response = await fetch(`http://${host}:${String(peer.port)}/federation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
    } catch {
      throw new InvalidRequestError(`Federation fleet '${peer.name}' is unavailable.`);
    }
    let payload: FederationResponse;
    try {
      payload = (await response.json()) as FederationResponse;
    } catch {
      throw new Error(`Federation fleet '${peer.name}' returned an invalid response.`);
    }
    if (!response.ok || payload.ok !== true) {
      const message = payload.error ?? `Federation fleet '${peer.name}' rejected the operation.`;
      if (payload.invalid === true) throw new InvalidRequestError(message);
      throw new Error(message);
    }
    return payload.result;
  }
}
