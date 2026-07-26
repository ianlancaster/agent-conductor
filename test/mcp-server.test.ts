import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { get } from 'node:http';
import { ConductorMcpServer, type McpToolDefinition } from '../src/mcp/server.js';
import { InvalidRequestError } from '../src/core/errors.js';
import { PACKAGE_VERSION } from '../src/version.js';

const PORT = 43_217;
const BASE = `http://127.0.0.1:${PORT}`;

let server: ConductorMcpServer;
let events: { session: string; body: unknown }[];
let commands: { line: string; interactionId: string }[];

const tools: McpToolDefinition[] = [
  {
    name: 'echo_caller',
    description: 'echoes the mechanical caller identity',
    inputSchema: { type: 'object', properties: {} },
    handler: (_args, caller) => Promise.resolve(`caller=${caller}`),
  },
  {
    name: 'boom',
    description: 'always throws',
    inputSchema: { type: 'object', properties: {} },
    handler: () => Promise.reject(new Error('kapow')),
  },
  {
    name: 'receipt',
    description: 'returns structured data',
    inputSchema: { type: 'object', properties: {} },
    handler: () => Promise.resolve({ messageId: 4, recipient: 'beta', status: 'queued', deduplicated: false }),
  },
  {
    name: 'invalid',
    description: 'rejects caller input',
    inputSchema: { type: 'object', properties: {} },
    handler: () => Promise.reject(new InvalidRequestError('bad input')),
  },
];

async function rpc(path: string, method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await response.json()) as Record<string, unknown>;
}

beforeEach(async () => {
  events = [];
  commands = [];
  server = new ConductorMcpServer({
    port: PORT,
    host: '127.0.0.1',
    keepAliveTimeoutMs: 1000,
    tools,
    onEvent: (session, body) => events.push({ session, body }),
    onCommand: (line, commandInteractionId) => {
      commands.push({ line, interactionId: commandInteractionId });
      return Promise.resolve(`ran: ${line}`);
    },
    feedHeartbeatMs: 10,
  });
  await server.start();
});

afterEach(async () => {
  await server.stop();
});

describe('operator feed', () => {
  it('reports no delivery when no console is attached', () => {
    expect(server.feedClientCount()).toBe(0);
    expect(server.pushToFeed({ text: 'hello?' })).toBe(false);
  });

  it('streams pushed messages to an attached console and tracks disconnect', async () => {
    const abort = new AbortController();
    const response = await fetch(`${BASE}/feed`, { signal: abort.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(server.feedClientCount()).toBe(1);

    expect(
      server.pushToFeed({
        text: '*alpha:* build is green\nsecond line',
        actions: [{ label: 'Ship', command: '/respond 7 1' }],
      }),
    ).toBe(true);

    const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
    if (reader === undefined) throw new Error('no stream body');
    const decoder = new TextDecoder();
    let buffer = '';
    while (!buffer.includes('\n\n') || !buffer.includes('data: ')) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    const dataLine = buffer.split('\n').find((line) => line.startsWith('data: '));
    expect(dataLine).toBeDefined();
    expect(JSON.parse((dataLine ?? '').slice('data: '.length))).toEqual({
      text: '*alpha:* build is green\nsecond line',
      actions: [{ label: 'Ship', command: '/respond 7 1' }],
    });

    abort.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.feedClientCount()).toBe(0);
    expect(server.pushToFeed({ text: 'anyone?' })).toBe(false);
  });

  it('keeps an idle feed alive with SSE heartbeat comments', async () => {
    const buffer = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const request = get(`${BASE}/feed`, (response) => {
        response.setEncoding('utf8');
        let received = '';
        response.on('data', (chunk: string) => {
          received += chunk;
          if (!received.includes(': heartbeat\n\n')) return;
          settled = true;
          response.destroy();
          resolve(received);
        });
      });
      request.on('error', (error) => {
        if (!settled) reject(error);
      });
    });
    expect(buffer).toContain(': heartbeat\n\n');
  });

  it('rejects cross-origin feed subscriptions', async () => {
    // Retry once: the aborted SSE stream in the prior test can leave undici's
    // pooled keep-alive socket half-closed, failing the first follow-up fetch.
    const attempt = (): Promise<Response> => fetch(`${BASE}/feed`, { headers: { Origin: 'http://evil.example' } });
    const response = await attempt().catch(attempt);
    expect(response.status).toBe(403);
  });
});

describe('identity routing', () => {
  it('extracts the caller from the URL path', async () => {
    const result = await rpc('/mcp/alpha', 'tools/call', { name: 'echo_caller', arguments: {} });
    const content = (result.result as { content: { text: string }[] }).content;
    expect(content[0]?.text).toBe('caller=alpha');
  });

  it('URL-decodes the caller segment', async () => {
    const result = await rpc('/mcp/session%2Dx', 'tools/call', { name: 'echo_caller', arguments: {} });
    const content = (result.result as { content: { text: string }[] }).content;
    expect(content[0]?.text).toBe('caller=session-x');
  });

  it('defaults to unknown on the bare /mcp route', async () => {
    const result = await rpc('/mcp', 'tools/call', { name: 'echo_caller', arguments: {} });
    const content = (result.result as { content: { text: string }[] }).content;
    expect(content[0]?.text).toBe('caller=unknown');
  });
});

describe('JSON-RPC surface', () => {
  it('answers initialize with server info', async () => {
    const result = await rpc('/mcp/alpha', 'initialize', { protocolVersion: '2025-06-18' });
    const payload = result.result as { protocolVersion: string; serverInfo: { name: string; version: string } };
    expect(payload.protocolVersion).toBe('2025-06-18');
    expect(payload.serverInfo.name).toBe('agent-conductor');
    expect(payload.serverInfo.version).toBe(PACKAGE_VERSION);
  });

  it('exposes the same tool surface to every session — no per-caller gating', async () => {
    const regular = await rpc('/mcp/alpha', 'tools/list');
    const regularNames = (regular.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    const sentinel = await rpc('/mcp/watch', 'tools/list');
    const sentinelNames = (sentinel.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(sentinelNames).toEqual(regularNames);
  });

  it('distinguishes invalid params from internal tool failures', async () => {
    const result = await rpc('/mcp/alpha', 'tools/call', { name: 'boom', arguments: {} });
    const payload = result.error as { code: number; message: string };
    expect(payload.code).toBe(-32603);
    expect(payload.message).toContain('kapow');

    const invalid = await rpc('/mcp/alpha', 'tools/call', { name: 'invalid', arguments: {} });
    expect(invalid.error).toEqual({ code: -32602, message: 'bad input' });
  });

  it('returns object operation results as MCP structured content and JSON text', async () => {
    const response = await rpc('/mcp/alpha', 'tools/call', { name: 'receipt', arguments: {} });
    const result = response.result as { structuredContent: unknown; content: { text: string }[] };
    expect(result.structuredContent).toEqual({
      messageId: 4,
      recipient: 'beta',
      status: 'queued',
      deduplicated: false,
    });
    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.structuredContent);
  });

  it('acknowledges notifications without a body', async () => {
    const response = await fetch(`${BASE}/mcp/alpha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(response.status).toBe(202);
  });
});

describe('events endpoint', () => {
  it('routes hook payloads with the session from the path', async () => {
    const response = await fetch(`${BASE}/events/alpha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'Stop' }),
    });
    expect(response.status).toBe(204);
    expect(events).toEqual([{ session: 'alpha', body: { hook_event_name: 'Stop' } }]);
  });
});

describe('anti-CSRF guard', () => {
  it('rejects a POST carrying an Origin header (drive-by browser request)', async () => {
    const response = await fetch(`${BASE}/cmd`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'Origin': 'https://evil.example' },
      body: JSON.stringify({ command: '/stop all' }),
    });
    expect(response.status).toBe(403);
    expect(commands).toEqual([]); // never reached the handler
  });

  it('rejects a POST carrying a Referer header', async () => {
    const response = await fetch(`${BASE}/mcp/alpha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Referer': 'https://evil.example/x' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(403);
  });

  it('allows requests with no Origin/Referer (the Node clients we ship)', async () => {
    const result = await rpc('/mcp/alpha', 'tools/list');
    expect(result.result).toBeDefined();
  });
});

describe('cmd and health endpoints', () => {
  it('routes CLI commands', async () => {
    const response = await fetch(`${BASE}/cmd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: '/status' }),
    });
    const payload = (await response.json()) as { reply: string };
    expect(payload.reply).toBe('ran: /status');
    expect(commands).toEqual([{ line: '/status', interactionId: 'cli' }]);
  });

  it('reports health with the tool list', async () => {
    const response = await fetch(`${BASE}/health`);
    const payload = (await response.json()) as { status: string; tools: string[] };
    expect(payload.status).toBe('ok');
    expect(payload.tools).toContain('echo_caller');
  });
});

describe('port conflicts', () => {
  it('fails with an actionable message when the port is taken by another conductor', async () => {
    // `server` (from beforeEach) already holds PORT.
    const second = new ConductorMcpServer({
      port: PORT,
      host: '127.0.0.1',
      keepAliveTimeoutMs: 1000,
      tools: [],
      onEvent: () => undefined,
    });
    await expect(second.start()).rejects.toThrow(
      new RegExp(`Port ${PORT} is already in use.*mcp: port:.*supervisor\\.yaml`),
    );
  });
});
