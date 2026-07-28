import type { MessageReceipt } from '../core/messaging.js';
import type { ConductorEvent } from '../events/types.js';

export const INTEGRATION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export type IntegrationHealthState = 'healthy' | 'degraded' | 'failed';
export type IntegrationState = 'starting' | IntegrationHealthState | 'stopped';

export interface IntegrationHealthUpdate {
  readonly state: IntegrationHealthState;
  /**
   * Short, operator-safe status text. Never include credentials, message
   * contents, private paths, or other sensitive data.
   */
  readonly detail?: string;
}

export interface IntegrationStatus {
  readonly name: string;
  readonly sender: `integration:${string}`;
  readonly state: IntegrationState;
  readonly updatedAt: string;
  readonly detail?: string;
}

export interface IntegrationDeliveryOptions {
  /**
   * Stable, integration-scoped identity for this logical delivery.
   * Immutable remote change identifiers make retries safely deduplicated.
   */
  readonly idempotencyKey: string;
}

export interface ConductorIntegrationContext {
  /** Aborted before Conductor tears down protected delivery or persistence. */
  readonly signal: AbortSignal;
  /** Durable, private namespace owned by this integration. */
  readonly stateDir: string;
  /** Protected session delivery with a mechanically assigned integration identity. */
  sendToSession(codename: string, message: string, options: IntegrationDeliveryOptions): Promise<MessageReceipt>;
  /** Publish bounded, operator-safe health without exposing Conductor internals. */
  reportHealth(update: IntegrationHealthUpdate): void;
}

/**
 * Trusted, in-process deterministic background coordination.
 *
 * Integrations own their timers, overlap policy, reconciliation, and durable
 * schema. The context deliberately does not expose operator authority, raw
 * terminals, ConductorOperations, the fleet store, secrets, or event emission.
 */
export interface ConductorIntegration {
  readonly name: string;
  /**
   * Initialize resources and register background work, then return. Long-lived
   * loops must honor context.signal rather than keeping this promise pending.
   */
  start(context: ConductorIntegrationContext): void | Promise<void>;
  /** Release integration-owned resources. Must be safe to call after partial startup. */
  stop(): void | Promise<void>;
  /**
   * Optional best-effort, metadata-only hints. Reconciliation and durable
   * integration state remain authoritative.
   */
  onEvent?(event: ConductorEvent): void | Promise<void>;
}

export interface ConductorIntegrationFactoryInput {
  /** Resolved fleet root. Use this to resolve plugin-owned relative option paths. */
  readonly fleetDir: string;
  /** Shallow-frozen copy of the opaque mapping from supervisor.yaml. */
  readonly options: Readonly<Record<string, unknown>>;
}

/**
 * Synchronous, construction-only entry point for one configured integration.
 *
 * Factories must not open resources, start timers, or perform I/O. Conductor
 * invokes every configured factory before Supervisor exists, so a later
 * factory failure cannot trigger stop() on objects returned earlier.
 */
export type ConductorIntegrationFactory = (input: ConductorIntegrationFactoryInput) => ConductorIntegration;
