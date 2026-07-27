import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ConductorEventBus } from '../events/bus.js';
import type {
  ConductorIntegration,
  ConductorIntegrationContext,
  IntegrationHealthUpdate,
  IntegrationStatus,
} from '../integrations/types.js';
import { INTEGRATION_NAME_PATTERN } from '../integrations/types.js';
import { log } from '../logger.js';
import type { MessageReceipt } from './messaging.js';

const DEFAULT_LIFECYCLE_TIMEOUT_MS = 5_000;
const MAX_STATUS_DETAIL_LENGTH = 240;
const RESERVED_INTEGRATION_NAMES = new Set(['conductor', 'operator', 'pr-shepherd']);

interface IntegrationRecord {
  readonly integration: ConductorIntegration;
  readonly name: string;
  readonly sender: `integration:${string}`;
  status: IntegrationStatus;
  controller?: AbortController;
  unsubscribe?: () => void;
  startInvoked: boolean;
  stopInvoked: boolean;
  startFailed: boolean;
}

export interface IntegrationManagerOptions {
  readonly integrations?: readonly ConductorIntegration[];
  readonly dataDir: string;
  readonly events: ConductorEventBus;
  readonly sendToSession: (
    integrationName: string,
    codename: string,
    message: string,
    idempotencyKey: string,
  ) => Promise<MessageReceipt>;
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly now?: () => Date;
}

/** Owns injected integration lifecycle without granting the canonical control plane. */
export class IntegrationManager {
  private readonly records: IntegrationRecord[];
  private readonly startTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly now: () => Date;
  private started = false;
  private stopped = false;

  constructor(private readonly options: IntegrationManagerOptions) {
    this.startTimeoutMs = positiveTimeout(options.startTimeoutMs, DEFAULT_LIFECYCLE_TIMEOUT_MS);
    this.stopTimeoutMs = positiveTimeout(options.stopTimeoutMs, DEFAULT_LIFECYCLE_TIMEOUT_MS);
    this.now = options.now ?? (() => new Date());

    const names = new Set<string>();
    this.records = (options.integrations ?? []).map((integration) => {
      if (integration === null || typeof integration !== 'object') {
        throw new Error('Integrations must be objects.');
      }
      const name = integration.name;
      if (typeof name !== 'string' || !INTEGRATION_NAME_PATTERN.test(name)) {
        throw new Error(
          `Integration name '${String(name)}' must be lowercase alphanumeric with internal dashes and no surrounding whitespace.`,
        );
      }
      if (RESERVED_INTEGRATION_NAMES.has(name)) {
        throw new Error(`Integration name '${name}' is reserved.`);
      }
      if (names.has(name)) throw new Error(`Duplicate integration name '${name}'.`);
      if (typeof integration.start !== 'function' || typeof integration.stop !== 'function') {
        throw new Error(`Integration '${name}' must define start(context) and stop().`);
      }
      if (integration.onEvent !== undefined && typeof integration.onEvent !== 'function') {
        throw new Error(`Integration '${name}' onEvent must be a function when provided.`);
      }
      names.add(name);
      const sender = `integration:${name}` as const;
      return {
        integration,
        name,
        sender,
        status: {
          name,
          sender,
          state: 'stopped',
          updatedAt: this.now().toISOString(),
        },
        startInvoked: false,
        stopInvoked: false,
        startFailed: false,
      };
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    await Promise.all(this.records.map((record) => this.startOne(record)));
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    // Revoke capabilities and queued hints before any integration cleanup can
    // race Conductor's delivery and persistence teardown.
    for (const record of this.records) {
      record.controller?.abort();
      record.unsubscribe?.();
      record.unsubscribe = undefined;
    }
    await Promise.all(this.records.map((record) => this.stopOne(record)));
  }

  status(): readonly IntegrationStatus[] {
    return Object.freeze(this.records.map((record) => Object.freeze({ ...record.status })));
  }

  private async startOne(record: IntegrationRecord): Promise<void> {
    this.setStatus(record, 'starting');
    const controller = new AbortController();
    record.controller = controller;

    let stateDir: string;
    try {
      stateDir = this.ensureStateDir(record.name);
    } catch (error) {
      record.startFailed = true;
      controller.abort();
      this.setFailure(record, 'Integration state directory could not be prepared.', 'state directory', error);
      return;
    }

    const context = Object.freeze<ConductorIntegrationContext>({
      signal: controller.signal,
      stateDir,
      sendToSession: async (codename, message, deliveryOptions) => {
        if (
          record.controller !== controller ||
          controller.signal.aborted ||
          record.status.state === 'failed' ||
          record.status.state === 'stopped'
        ) {
          throw new Error(`Integration '${record.name}' is not active; protected delivery is unavailable.`);
        }
        const key = deliveryOptions?.idempotencyKey;
        if (typeof key !== 'string' || key.trim().length === 0 || key.length > 128) {
          throw new Error('Integration idempotencyKey must be non-blank and at most 128 characters.');
        }
        return this.options.sendToSession(record.name, codename, message, key);
      },
      reportHealth: (update) => {
        if (record.controller !== controller || controller.signal.aborted) return;
        this.reportHealth(record, update);
      },
    });

    record.startInvoked = true;
    try {
      await withTimeout(
        Promise.resolve(record.integration.start(context)),
        this.startTimeoutMs,
        `Integration '${record.name}' start timed out.`,
      );
      if (controller.signal.aborted) return;
      if (record.integration.onEvent !== undefined) {
        record.unsubscribe = this.options.events.subscribe({
          name: record.sender,
          onEvent: (event) => record.integration.onEvent?.(event),
        });
      }
    } catch (error) {
      record.startFailed = true;
      controller.abort();
      record.unsubscribe?.();
      record.unsubscribe = undefined;
      this.setFailure(record, 'Integration failed to start.', 'start', error);
      await this.cleanupFailedStart(record);
    }
  }

  private async cleanupFailedStart(record: IntegrationRecord): Promise<void> {
    if (!record.startInvoked || record.stopInvoked) return;
    record.stopInvoked = true;
    try {
      await withTimeout(
        Promise.resolve(record.integration.stop()),
        this.stopTimeoutMs,
        `Integration '${record.name}' cleanup timed out.`,
      );
    } catch (error) {
      log().warn('integrations', `${record.name}: cleanup after failed start rejected: ${boundedError(error)}`);
    }
  }

  private async stopOne(record: IntegrationRecord): Promise<void> {
    if (!record.startInvoked || record.stopInvoked) return;
    record.stopInvoked = true;
    try {
      await withTimeout(
        Promise.resolve(record.integration.stop()),
        this.stopTimeoutMs,
        `Integration '${record.name}' stop timed out.`,
      );
      if (!record.startFailed) this.setStatus(record, 'stopped');
    } catch (error) {
      this.setFailure(record, 'Integration failed to stop cleanly.', 'stop', error);
    }
  }

  private reportHealth(record: IntegrationRecord, update: IntegrationHealthUpdate): void {
    if (update.state !== 'healthy' && update.state !== 'degraded' && update.state !== 'failed') {
      throw new Error(`Integration '${record.name}' reported an invalid health state.`);
    }
    this.setStatus(record, update.state, normalizeDetail(update.detail));
  }

  private setStatus(record: IntegrationRecord, state: IntegrationStatus['state'], detail?: string): void {
    record.status = {
      name: record.name,
      sender: record.sender,
      state,
      updatedAt: this.now().toISOString(),
      ...(detail === undefined ? {} : { detail }),
    };
  }

  private setFailure(record: IntegrationRecord, detail: string, operation: string, error: unknown): void {
    this.setStatus(record, 'failed', detail);
    log().warn('integrations', `${record.name}: ${operation} failed: ${boundedError(error)}`);
  }

  private ensureStateDir(name: string): string {
    const stateDir = join(this.options.dataDir, 'integrations', name);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(stateDir, 0o700);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EINVAL', 'ENOSYS', 'ENOTSUP'].includes(code ?? '')) throw error;
    }
    return stateDir;
  }
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error('Integration lifecycle timeouts must be positive.');
  return value;
}

function normalizeDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const withoutControls = [...detail]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || (codePoint >= 127 && codePoint <= 159) ? ' ' : character;
    })
    .join('');
  const normalized = withoutControls.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return undefined;
  return normalized.length <= MAX_STATUS_DETAIL_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_STATUS_DETAIL_LENGTH - 1)}…`;
}

function boundedError(error: unknown): string {
  return normalizeDetail(error instanceof Error ? error.message : String(error)) ?? 'unknown error';
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
