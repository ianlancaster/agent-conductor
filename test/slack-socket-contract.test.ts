import { once } from 'node:events';

import { SocketModeClient, LogLevel } from '@slack/socket-mode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

const openServers: WebSocketServer[] = [];
const openClients: SocketModeClient[] = [];

afterEach(async () => {
  await Promise.allSettled(openClients.splice(0).map((client) => client.disconnect()));
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const socket of server.clients) socket.terminate();
          server.close(() => resolve());
        }),
    ),
  );
});

describe('Slack Socket Mode heartbeat contract', () => {
  it('reconnects through the real SDK after client pongs stop without duplicating listeners', async () => {
    const server = await socketServer(false);
    const client = socketClient(server, { clientPingTimeout: 60, serverPingTimeout: 2_000 });
    const events = vi.fn();
    client.on('slack_event', events);
    let connections = 0;
    server.on('connection', (socket) => {
      connections += 1;
      hello(socket);
      if (connections === 2) event(socket, 'event-after-reconnect');
    });

    await client.start();
    await until(() => connections >= 2 && events.mock.calls.length === 1, 4_000);
    expect(events).toHaveBeenCalledTimes(1);
  });

  it('reconnects through the real SDK after server pings go silent', async () => {
    const server = await socketServer(true);
    const client = socketClient(server, { clientPingTimeout: 300, serverPingTimeout: 80 });
    let connections = 0;
    server.on('connection', (socket) => {
      connections += 1;
      hello(socket);
      // One ping arms the SDK's server-ping deadline; silence after that must
      // recycle the connection even though the server still answers client pings.
      setTimeout(() => socket.ping('server-heartbeat'), 10).unref();
    });

    await client.start();
    await until(() => connections >= 2, 4_000);
    expect(connections).toBeGreaterThanOrEqual(2);
  });
});

async function socketServer(autoPong: boolean): Promise<WebSocketServer> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', autoPong });
  openServers.push(server);
  await once(server, 'listening');
  return server;
}

function socketClient(
  server: WebSocketServer,
  timeouts: { clientPingTimeout: number; serverPingTimeout: number },
): SocketModeClient {
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('test WebSocket server has no TCP address');
  const url = `ws://127.0.0.1:${String(address.port)}`;
  const client = new SocketModeClient({
    appToken: 'xapp-contract-test',
    autoReconnectEnabled: true,
    logLevel: LogLevel.ERROR,
    ...timeouts,
    clientOptions: {
      retryConfig: { retries: 0 },
      fetch: async () =>
        new Response(JSON.stringify({ ok: true, url }), { headers: { 'content-type': 'application/json' } }),
    },
  });
  openClients.push(client);
  return client;
}

function hello(socket: WebSocket): void {
  socket.send(JSON.stringify({ type: 'hello', num_connections: 1, connection_info: { app_id: 'A1' } }));
}

function event(socket: WebSocket, eventId: string): void {
  socket.send(
    JSON.stringify({
      envelope_id: `env-${eventId}`,
      type: 'events_api',
      accepts_response_payload: false,
      payload: {
        team_id: 'T1',
        event_id: eventId,
        event: { type: 'message', user: 'U1', channel: 'D1', channel_type: 'im', text: 'hello' },
      },
    }),
  );
}

async function until(condition: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
