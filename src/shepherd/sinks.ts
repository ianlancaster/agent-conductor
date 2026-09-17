import type { CoordinatorReceipt, CoordinatorSink, OutboxItem } from './types.js';
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
    (record.status !== 'delivered' && record.status !== 'queued') ||
    typeof record.deduplicated !== 'boolean'
  )
    return undefined;
  return {
    messageId: record.messageId,
    recipient: record.recipient,
    status: record.status,
    deduplicated: record.deduplicated,
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
        params: {
          name: 'send_to_session',
          arguments: {
            codename: item.recipient,
            message: item.message,
            idempotencyKey: item.idempotencyKey,
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`Conductor HTTP ${String(response.status)} ${response.statusText}`);
    const payload = (await response.json()) as JsonRpcResponse;
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
}
