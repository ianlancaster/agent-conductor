#!/usr/bin/env node
import process from 'node:process';
import { createInterface } from 'node:readline';

const tools = [
  {
    name: 'fixture_ping',
    description: 'Harmless disposable schema-initialization fixture.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (line.trim().length === 0) continue;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }
  if (request.id === undefined) continue;
  let result;
  switch (request.method) {
    case 'initialize':
      result = {
        protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-conductor-disposable-fixture', version: '1.0.0' },
      };
      break;
    case 'tools/list':
      result = { tools };
      break;
    case 'tools/call':
      result = { content: [{ type: 'text', text: 'ok' }] };
      break;
    case 'resources/list':
      result = { resources: [] };
      break;
    case 'resources/templates/list':
      result = { resourceTemplates: [] };
      break;
    case 'prompts/list':
      result = { prompts: [] };
      break;
    case 'ping':
      result = {};
      break;
    default:
      process.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -32601, message: 'not found' } })}\n`);
      continue;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
}
