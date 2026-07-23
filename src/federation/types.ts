import type { FederationMessageState } from '../store/index.js';

export const FEDERATION_PROTOCOL_VERSION = 1;
export const FEDERATION_CAPABILITIES = ['messages'] as const;
export const MAX_FEDERATED_MESSAGE_BYTES = 64 * 1024;
export const MAX_FEDERATION_BODY_BYTES = 70 * 1024;
export const MAX_FEDERATION_DIRECTORY_ENTRIES = 100;
export const MAX_FEDERATION_DIRECTORY_BYTES = 256 * 1024;
export const DEFAULT_FEDERATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type FederationCapability = (typeof FEDERATION_CAPABILITIES)[number];

export interface FederationAddress {
  codename: string;
  fleet: string;
  qualified: string;
}

export interface PeerDirectoryEntry {
  instanceId: string;
  fleet: string;
  fleetDescription?: string;
  codename: string;
  address: string;
  description?: string;
  presence: 'running' | 'stopped';
  capabilities: FederationCapability[];
  transport: string;
  ambiguous?: boolean;
}

/** Authenticated by a transport before it reaches federation policy. */
export interface FederationPrincipal {
  instanceId: string;
  fleet: string;
}

/** Transport-neutral route identity. Adapters resolve their own connection details. */
export type FederationPeerRoute = PeerDirectoryEntry;

export interface FederationAdapterHealth {
  lastContactAt: number | null;
  lastErrorCode: string | null;
}

export interface FederatedWireMessage {
  version: typeof FEDERATION_PROTOCOL_VERSION;
  messageId: string;
  sourceSession: string;
  destinationSession: string;
  message: string;
  createdAt: number;
  expiresAt: number;
}

export interface FederationHopReceipt {
  messageId: string;
  status: 'received' | 'delivered';
  deduplicated: boolean;
}

export interface FederationMessageReceipt {
  messageId: string;
  recipient: string;
  status: FederationMessageState;
  deduplicated: boolean;
}

export interface FederationMessageStatus {
  messageId: string;
  sender: string;
  recipient: string;
  status: FederationMessageState;
  attempts: number;
  lastError: string | null;
  createdAt: number;
  expiresAt: number;
  receivedAt: number | null;
  deliveredAt: number | null;
}

export type FederationErrorCode =
  | 'address_invalid'
  | 'auth_invalid'
  | 'instance_collision'
  | 'message_expired'
  | 'message_invalid'
  | 'peer_unavailable'
  | 'recipient_hidden'
  | 'unknown_fleet'
  | 'version_unsupported'
  | 'internal_error';

const FEDERATION_ERROR_CODES = new Set<FederationErrorCode>([
  'address_invalid',
  'auth_invalid',
  'instance_collision',
  'message_expired',
  'message_invalid',
  'peer_unavailable',
  'recipient_hidden',
  'unknown_fleet',
  'version_unsupported',
  'internal_error',
]);

export function isFederationErrorCode(value: unknown): value is FederationErrorCode {
  return typeof value === 'string' && FEDERATION_ERROR_CODES.has(value as FederationErrorCode);
}

export class FederationError extends Error {
  constructor(
    readonly code: FederationErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'FederationError';
  }
}

export interface FederationAdapter {
  readonly id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  updatePublicDescription(description: string | undefined): void;
  directory(): Promise<FederationPeerRoute[]>;
  send(route: FederationPeerRoute, message: FederatedWireMessage): Promise<FederationHopReceipt>;
  status(
    route: FederationPeerRoute,
    messageId: string,
    sourceSession: string,
  ): Promise<'received' | 'delivered' | 'expired' | 'failed'>;
  health(): FederationAdapterHealth;
}
