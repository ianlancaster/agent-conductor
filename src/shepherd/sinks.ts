import type { CoordinatorReceipt, CoordinatorReconciliation, CoordinatorSink, OutboxItem } from './types.js';
import { PermanentDeliveryError } from './types.js';

interface JsonRpcResponse {
  result?: {
    structuredContent?: unknown;
    content?: { type?: unknown; text?: unknown }[];
  };
  error?: { code?: unknown; message?: unknown };
}

function receipt(value: unknown, expectedRecipient: string): CoordinatorReceipt | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.messageId !== 'number' ||
    !Number.isSafeInteger(record.messageId) ||
    record.messageId <= 0 ||
    record.recipient !== expectedRecipient ||
    (record.status !== 'delivered' && record.status !== 'queued' && record.status !== 'uncertain') ||
    typeof record.deduplicated !== 'boolean'
  )
    return undefined;
  const reconciliation = parseReconciliation(record.reconciliation, record.messageId);
  if (record.reconciliation !== undefined && reconciliation === undefined) return undefined;
  return {
    messageId: record.messageId,
    recipient: record.recipient,
    status: record.status,
    deduplicated: record.deduplicated,
    ...(reconciliation === undefined ? {} : { reconciliation }),
  };
}

function parseReconciliation(value: unknown, messageId: number): CoordinatorReconciliation | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.messageId !== messageId ||
    (record.outcome !== 'manually-submitted' && record.outcome !== 'abandoned') ||
    typeof record.actor !== 'string' ||
    typeof record.evidence !== 'string' ||
    typeof record.reconciledAt !== 'string'
  ) {
    return undefined;
  }
  return {
    messageId,
    outcome: record.outcome,
    actor: record.actor,
    evidence: record.evidence,
    reconciledAt: record.reconciledAt,
  };
}

export class StdoutCoordinatorSink implements CoordinatorSink {
  async send(item: OutboxItem): Promise<undefined> {
    process.stdout.write(`${item.message}\n`);
    return undefined;
  }
}

export class ConductorCoordinatorSink implements CoordinatorSink {
  private requestId = 0;

  constructor(
    private readonly endpoint: string,
    private readonly sender = 'pr-shepherd',
    private readonly timeoutMs = 10_000,
  ) {}

  async send(item: OutboxItem): Promise<CoordinatorReceipt> {
    const payload = await this.call('send_to_session', {
      codename: item.recipient,
      message: item.message,
      idempotencyKey: item.idempotencyKey,
    });
    if (payload.error !== undefined) {
      const message = typeof payload.error.message === 'string' ? payload.error.message : 'Conductor JSON-RPC error';
      if (payload.error.code === -32602) throw new PermanentDeliveryError(message);
      throw new Error(message);
    }
    const structured = receipt(payload.result?.structuredContent, item.recipient);
    if (structured !== undefined) return structured;
    const text = payload.result?.content?.find((entry) => entry.type === 'text')?.text;
    if (typeof text === 'string') {
      try {
        const parsed = receipt(JSON.parse(text) as unknown, item.recipient);
        if (parsed !== undefined) return parsed;
      } catch {
        // Fall through to the contract error below.
      }
    }
    throw new Error('Conductor returned no valid persisted-message receipt.');
  }

  async getReceipt(messageId: number, expectedRecipient: string): Promise<CoordinatorReceipt | undefined> {
    const payload = await this.call('get_message_status', { messageId });
    if (payload.error !== undefined) throw new Error('Conductor could not inspect the parked message receipt.');
    const text = payload.result?.content?.find((entry) => entry.type === 'text')?.text;
    if (typeof text !== 'string') return undefined;
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
    if (typeof value !== 'object' || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (record.id !== messageId || record.recipient !== expectedRecipient || record.status !== 'uncertain') {
      return undefined;
    }
    const reconciliation = parseReconciliation(record.reconciliation, messageId);
    return {
      messageId,
      recipient: expectedRecipient,
      status: 'uncertain',
      deduplicated: true,
      ...(reconciliation === undefined ? {} : { reconciliation }),
    };
  }

  private async call(name: string, args: Record<string, unknown>): Promise<JsonRpcResponse> {
    this.requestId += 1;
    const base = this.endpoint.replace(/\/$/, '');
    const response = await fetch(`${base}/mcp/${encodeURIComponent(this.sender)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: this.requestId,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    if (!response.ok) throw new Error(`Conductor HTTP ${String(response.status)} ${response.statusText}`);
    return (await response.json()) as JsonRpcResponse;
  }
}
