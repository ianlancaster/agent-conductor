import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { log } from '../logger.js';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Tool is visible/callable only by the designated stall sentinel. */
  sentinelOnly?: boolean;
  handler(args: Record<string, unknown>, caller: string): Promise<string>;
}

export interface McpServerOptions {
  port: number;
  host: string;
  keepAliveTimeoutMs: number;
  tools: McpToolDefinition[];
  /** Whether this caller is the designated sentinel (gates sentinelOnly tools). */
  isSentinel(caller: string): boolean;
  /** Lifecycle event pushed by an agent's runtime hooks. */
  onEvent(agent: string, body: unknown): void;
  /** CLI command line (from the interactive client via POST /cmd). */
  onCommand?(line: string): Promise<string>;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

const PROTOCOL_VERSION = '2024-11-05';

/**
 * Plain-HTTP MCP server (streamable-HTTP compatible JSON responses).
 *
 * Identity is mechanical: agents are configured with /mcp/<codename> URLs, and
 * the codename is extracted from the path — never from request contents.
 */
export class ConductorMcpServer {
  private readonly server: Server;
  private readonly tools = new Map<string, McpToolDefinition>();

  constructor(private readonly opts: McpServerOptions) {
    for (const tool of opts.tools) this.tools.set(tool.name, tool);
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        log().error('mcp', `Unhandled request error: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) this.respondJson(res, 500, { error: 'internal error' });
      });
    });
    // Long-running tool calls (consults, human input) must not be killed by timeouts.
    this.server.headersTimeout = 0;
    this.server.requestTimeout = 0;
    this.server.timeout = 0;
    this.server.keepAliveTimeout = opts.keepAliveTimeoutMs;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.port, this.opts.host, () => {
        this.server.removeListener('error', reject);
        log().info('mcp', `MCP server listening on ${this.opts.host}:${this.opts.port}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => {
        resolve();
      });
      this.server.closeAllConnections();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    const [path] = url.split('?');
    if (path === undefined) {
      this.respondJson(res, 404, { error: 'not found' });
      return;
    }

    if (req.method === 'GET' && path === '/health') {
      this.respondJson(res, 200, { status: 'ok', tools: [...this.tools.keys()] });
      return;
    }

    if (req.method !== 'POST') {
      this.respondJson(res, 405, { error: 'method not allowed' });
      return;
    }

    // Anti-CSRF: the legitimate clients (Claude Code / Codex MCP, the CLI) are
    // Node HTTP clients and never send Origin/Referer. A browser always does on
    // a cross-origin fetch, so their presence means a drive-by page is trying to
    // reach the localhost surface — reject it. (Full per-agent auth is deferred
    // to the relay phase; this closes the browser vector cheaply.)
    if (req.headers.origin !== undefined || req.headers.referer !== undefined) {
      log().warn('mcp', `Rejected request with Origin/Referer header (possible CSRF) to ${path}`);
      this.respondJson(res, 403, { error: 'cross-origin requests are not allowed' });
      return;
    }

    const body = await this.readBody(req);

    if (path.startsWith('/events/')) {
      const agent = decodeURIComponent(path.slice('/events/'.length));
      if (agent.length === 0) {
        this.respondJson(res, 400, { error: 'missing agent' });
        return;
      }
      this.opts.onEvent(agent, body);
      res.writeHead(204).end();
      return;
    }

    if (path === '/cmd') {
      if (this.opts.onCommand === undefined) {
        this.respondJson(res, 404, { error: 'no command handler' });
        return;
      }
      const line =
        typeof (body as { command?: unknown } | null)?.command === 'string'
          ? (body as { command: string }).command
          : '';
      const reply = await this.opts.onCommand(line);
      this.respondJson(res, 200, { reply });
      return;
    }

    if (path === '/mcp' || path.startsWith('/mcp/')) {
      const caller = path.startsWith('/mcp/') ? decodeURIComponent(path.slice('/mcp/'.length)) : 'unknown';
      await this.handleJsonRpc(body, caller.length > 0 ? caller : 'unknown', res);
      return;
    }

    this.respondJson(res, 404, { error: 'not found' });
  }

  private async handleJsonRpc(body: unknown, caller: string, res: ServerResponse): Promise<void> {
    const request = (typeof body === 'object' && body !== null ? body : {}) as JsonRpcRequest;
    const { id, method, params } = request;

    // Notifications (no id) are acknowledged without a body.
    if (id === undefined || id === null) {
      res.writeHead(202).end();
      return;
    }

    switch (method) {
      case 'initialize': {
        const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
        this.respondRpc(res, id, {
          protocolVersion: requested,
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-conductor', version: '0.1.0' },
        });
        return;
      }
      case 'ping': {
        this.respondRpc(res, id, {});
        return;
      }
      case 'tools/list': {
        const sentinel = this.opts.isSentinel(caller);
        const tools = [...this.tools.values()]
          .filter((tool) => sentinel || tool.sentinelOnly !== true)
          .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
        this.respondRpc(res, id, { tools });
        return;
      }
      case 'tools/call': {
        const name = typeof params?.name === 'string' ? params.name : '';
        const args =
          typeof params?.arguments === 'object' && params.arguments !== null
            ? (params.arguments as Record<string, unknown>)
            : {};
        const tool = this.tools.get(name);
        if (tool === undefined || (tool.sentinelOnly === true && !this.opts.isSentinel(caller))) {
          this.respondRpcError(res, id, -32602, `Unknown tool: ${name}`);
          return;
        }
        try {
          const result = await tool.handler(args, caller);
          this.respondRpc(res, id, { content: [{ type: 'text', text: result }] });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log().warn('mcp', `Tool ${name} failed for ${caller}: ${message}`);
          this.respondRpc(res, id, { content: [{ type: 'text', text: `Error: ${message}` }], isError: true });
        }
        return;
      }
      default:
        this.respondRpcError(res, id, -32601, `Method not found: ${method ?? '(none)'}`);
    }
  }

  private readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw.length === 0) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve(null);
        }
      });
      req.on('error', () => {
        resolve(null);
      });
    });
  }

  private respondJson(res: ServerResponse, status: number, payload: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  private respondRpc(res: ServerResponse, id: number | string, result: unknown): void {
    this.respondJson(res, 200, { jsonrpc: '2.0', id, result });
  }

  private respondRpcError(res: ServerResponse, id: number | string, code: number, message: string): void {
    this.respondJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  }
}
