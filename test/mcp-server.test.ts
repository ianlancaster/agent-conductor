import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConductorMcpServer, type McpToolDefinition } from '../src/mcp/server.js';

const PORT = 43_217;
const BASE = `http://127.0.0.1:${PORT}`;

let server: ConductorMcpServer;
let events: { agent: string; body: unknown }[];
let commands: string[];

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
    name: 'sentinel_secret',
    description: 'sentinel only',
    sentinelOnly: true,
    inputSchema: { type: 'object', properties: {} },
    handler: () => Promise.resolve('the queue'),
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
    isSentinel: (caller) => caller === 'watch',
    onEvent: (agent, body) => events.push({ agent, body }),
    onCommand: (line) => {
      commands.push(line);
      return Promise.resolve(`ran: ${line}`);
    },
  });
  await server.start();
});

afterEach(async () => {
  await server.stop();
});

describe('identity routing', () => {
  it('extracts the caller from the URL path', async () => {
    const result = await rpc('/mcp/alpha', 'tools/call', { name: 'echo_caller', arguments: {} });
    const content = (result.result as { content: { text: string }[] }).content;
    expect(content[0]?.text).toBe('caller=alpha');
  });

  it('URL-decodes the caller segment', async () => {
    const result = await rpc('/mcp/agent%2Dx', 'tools/call', { name: 'echo_caller', arguments: {} });
    const content = (result.result as { content: { text: string }[] }).content;
    expect(content[0]?.text).toBe('caller=agent-x');
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
    const payload = result.result as { protocolVersion: string; serverInfo: { name: string } };
    expect(payload.protocolVersion).toBe('2025-06-18');
    expect(payload.serverInfo.name).toBe('agent-conductor');
  });

  it('hides sentinel-only tools from regular agents but shows them to the sentinel', async () => {
    const regular = await rpc('/mcp/alpha', 'tools/list');
    const regularNames = (regular.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(regularNames).toContain('echo_caller');
    expect(regularNames).not.toContain('sentinel_secret');

    const sentinel = await rpc('/mcp/watch', 'tools/list');
    const sentinelNames = (sentinel.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(sentinelNames).toContain('sentinel_secret');
  });

  it('rejects sentinel-only tool calls from non-sentinel callers', async () => {
    const result = await rpc('/mcp/alpha', 'tools/call', { name: 'sentinel_secret', arguments: {} });
    expect((result.error as { message: string }).message).toContain('Unknown tool');
  });

  it('allows sentinel-only tool calls from the sentinel', async () => {
    const result = await rpc('/mcp/watch', 'tools/call', { name: 'sentinel_secret', arguments: {} });
    const content = (result.result as { content: { text: string }[] }).content;
    expect(content[0]?.text).toBe('the queue');
  });

  it('maps handler errors to isError results, not transport failures', async () => {
    const result = await rpc('/mcp/alpha', 'tools/call', { name: 'boom', arguments: {} });
    const payload = result.result as { isError: boolean; content: { text: string }[] };
    expect(payload.isError).toBe(true);
    expect(payload.content[0]?.text).toContain('kapow');
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
  it('routes hook payloads with the agent from the path', async () => {
    const response = await fetch(`${BASE}/events/alpha`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'Stop' }),
    });
    expect(response.status).toBe(204);
    expect(events).toEqual([{ agent: 'alpha', body: { hook_event_name: 'Stop' } }]);
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
    expect(commands).toEqual(['/status']);
  });

  it('reports health with the tool list', async () => {
    const response = await fetch(`${BASE}/health`);
    const payload = (await response.json()) as { status: string; tools: string[] };
    expect(payload.status).toBe('ok');
    expect(payload.tools).toContain('echo_caller');
  });
});
