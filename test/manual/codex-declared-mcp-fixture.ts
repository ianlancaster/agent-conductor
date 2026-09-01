import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { sessionConfigSchema, type SupervisorConfig } from '../../src/config/schema.js';
import { CodexRuntime } from '../../src/runtimes/codex/index.js';

type Settings = NonNullable<SupervisorConfig['runtimes']['codex']['declaredMcp']>;

async function main(): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'conductor-codex-mcp-fixture-'));
  const repo = path.join(root, 'repo');
  const configDir = path.join(root, 'session');
  const sharedHome = path.join(root, 'shared-codex');
  const declarationDir = path.join(repo, '.conductor');
  const fixtureServer = path.resolve('test/fixtures/fake-mcp-server.mjs');
  await Promise.all([
    mkdir(declarationDir, { recursive: true }),
    mkdir(configDir, { recursive: true }),
    mkdir(sharedHome, { recursive: true }),
  ]);
  await writeFile(path.join(sharedHome, 'config.toml'), 'model = "fixture-model"\n');
  await writeFile(
    path.join(declarationDir, 'mcp.yaml'),
    [
      'version: 1',
      'id: disposable-fixture',
      'servers:',
      '  - id: disposable',
      '    transport: stdio',
      '    command: node',
      `    args: [${JSON.stringify(fixtureServer)}]`,
      '    required: true',
      '    tools: [fixture_ping]',
      'profiles:',
      '  worker:',
      '    servers: [disposable]',
      '',
    ].join('\n'),
  );
  const settings: Settings = {
    defaultProfile: 'worker',
    profiles: {
      worker: { sources: [{ scope: 'repo', file: '.conductor/mcp.yaml', profile: 'worker' }] },
    },
  };
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = sharedHome;
  try {
    const runtime = new CodexRuntime({
      config: { binary: 'codex', toolTimeoutSec: 30, declaredMcp: settings },
      baseDir: root,
      env: { PATH: process.env.PATH },
    });
    const session = sessionConfigSchema.parse({ codename: 'fixture', repo, runtime: 'codex' });
    await runtime.prepare(session, {
      mcpUrl: 'http://127.0.0.1:1/mcp/fixture',
      eventsUrl: 'http://127.0.0.1:1/events/fixture',
      configDir,
    });

    const codexHome = path.join(configDir, 'codex-home');
    const child = spawn('codex', ['app-server', '--strict-config', '--stdio'], {
      cwd: repo,
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const pending = new Map<number, (message: unknown) => void>();
    void (async () => {
      for await (const line of lines) {
        const message = JSON.parse(line) as { id?: number };
        if (message.id !== undefined) pending.get(message.id)?.(message);
      }
    })();
    let requestId = 0;
    const request = (method: string, params: unknown): Promise<Record<string, unknown>> => {
      requestId += 1;
      const id = requestId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 15_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(message as Record<string, unknown>);
        });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    };

    const initialized = await request('initialize', { clientInfo: { name: 'conductor-fixture', version: '1' } });
    if ('error' in initialized) throw new Error('Codex app-server initialization failed');
    const status = await request('mcpServerStatus/list', { detail: 'full' });
    const result = status.result as { data?: { name: string; tools: Record<string, unknown> }[] } | undefined;
    const disposable = result?.data?.find((server) => server.name === 'disposable');
    if (disposable?.tools.fixture_ping === undefined) {
      throw new Error(`Codex did not initialize the disposable MCP schema. ${stderr.trim()}`);
    }
    const readiness = await readFile(path.join(configDir, 'codex-mcp-readiness.json'), 'utf8');
    if (!readiness.includes('pending-runtime-initialization') || readiness.includes('fixture-secret-value')) {
      throw new Error('Generated readiness did not preserve its name-only pre-launch contract');
    }
    child.kill('SIGTERM');
    process.stdout.write(
      'Disposable Codex MCP fixture initialized 1 server and 1 tool schema; no credential value was used.\n',
    );
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
}

await main();
