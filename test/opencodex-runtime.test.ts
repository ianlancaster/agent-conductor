import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionConfigSchema, supervisorConfigSchema } from '../src/config/schema.js';
import { Supervisor } from '../src/core/supervisor.js';
import { ClaudeCodeRuntime } from '../src/runtimes/claude-code/index.js';
import { CodexRuntime } from '../src/runtimes/codex/index.js';
import { OpenCodexClaudeRuntime, OpenCodexRuntime } from '../src/runtimes/opencodex/index.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';

const execFileAsync = promisify(execFile);
let dir: string;
let server: Server | undefined;
let supervisor: Supervisor | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conductor-opencodex-'));
});

afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function config(enabled = true, claudeCodeEnabled = false, proxyOrigin = 'http://127.0.0.1:10100') {
  return supervisorConfigSchema.parse({ runtimes: { openCodex: { enabled, claudeCodeEnabled, proxyOrigin } } });
}

function session(runtime: string, model?: string) {
  return sessionConfigSchema.parse({ codename: 'worker', repo: dir, runtime, model });
}

function identity() {
  return {
    configDir: join(dir, 'data', 'sessions', 'worker'),
    mcpUrl: 'http://127.0.0.1:3456/mcp/worker',
    eventsUrl: 'http://127.0.0.1:3456/events/worker',
  };
}

async function healthyProxy(): Promise<string> {
  server = createServer((request, response) => {
    response.writeHead(request.url === '/healthz' ? 200 : 404);
    response.end();
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No proxy test address');
  return `http://127.0.0.1:${String(address.port)}`;
}

describe('built-in OpenCodex profiles', () => {
  it('defaults off, validates a credential-free loopback URL, and supports external adapter migration', () => {
    expect(supervisorConfigSchema.parse({}).runtimes.openCodex).toEqual({
      enabled: false,
      proxyOrigin: null,
      claudeCodeEnabled: false,
    });
    expect(() => supervisorConfigSchema.parse({ runtimes: { openCodex: { enabled: true } } })).toThrow();
    expect(() => supervisorConfigSchema.parse({ runtimes: { openCodex: { claudeCodeEnabled: true } } })).toThrow();
    for (const proxyOrigin of [
      'https://127.0.0.1:10100',
      'http://0.0.0.0:10100',
      'http://example.com:10100',
      'http://user:secret@127.0.0.1:10100',
      'http://127.0.0.1:10100/v1',
    ]) {
      expect(() => config(true, false, proxyOrigin)).toThrow();
    }
    const adapter = { name: 'opencodex', module: './runtime.mjs' };
    expect(supervisorConfigSchema.parse({ runtimeAdapters: [adapter] }).runtimeAdapters[0]?.name).toBe('opencodex');
    expect(() =>
      supervisorConfigSchema.parse({
        runtimeAdapters: [adapter],
        runtimes: {
          openCodex: {
            enabled: true,
            proxyOrigin: 'http://127.0.0.1:10100',
          },
        },
      }),
    ).toThrow(/conflicts with the enabled built-in runtime/u);
  });

  it('routes only the new Codex runtime through launch-scoped provider overrides', () => {
    const settings = config().runtimes.codex;
    const native = new CodexRuntime({ config: settings, baseDir: dir });
    const proxy = new OpenCodexRuntime({ config: settings, baseDir: dir }, 'http://127.0.0.1:10100');
    const nativeCommand = native.buildLaunchCommand(session('codex', 'native-model'), identity(), {});
    const proxyCommand = proxy.buildLaunchCommand(session('opencodex', 'provider/model-id'), identity(), {});

    expect(nativeCommand).not.toContain('model_provider=');
    expect(nativeCommand).not.toContain('/healthz');
    expect(proxyCommand).toContain('model_provider="opencodex"');
    expect(proxyCommand).toContain('model_providers.opencodex.base_url=');
    expect(proxyCommand).toContain('http://127.0.0.1:10100/v1');
    expect(proxyCommand).toContain('model_providers.opencodex.requires_openai_auth=false');
    expect(proxyCommand).toContain("--model 'provider/model-id'");
    expect(proxyCommand).toContain('/healthz');
    expect(() => proxy.buildLaunchCommand(session('opencodex'), identity(), {})).toThrow(/explicit model/u);
    expect(
      proxy.buildLaunchCommand(session('opencodex', 'provider/model-id'), identity(), {
        continueSession: true,
      }),
    ).toContain("'codex' resume --last");
  });

  it('clears inherited native Claude routing and fails before launch while the proxy is down', async () => {
    const origin = await healthyProxy();
    const marker = join(dir, 'launched.txt');
    const binary = join(dir, 'fake-claude');
    writeFileSync(
      binary,
      '#!/bin/sh\nprintf "%s\\n" "${ANTHROPIC_BASE_URL:-}" "${ANTHROPIC_AUTH_TOKEN:-}" "${ANTHROPIC_API_KEY:-unset}" "${ANTHROPIC_MODEL:-unset}" "$@" > ' +
        `'${marker}'\n`,
      { mode: 0o700 },
    );
    const settings = { ...config().runtimes.claudeCode, binary, env: { ANTHROPIC_API_KEY: 'CONFIG_SECRET' } };
    const native = new ClaudeCodeRuntime({ config: settings, claudeJsonPath: join(dir, 'claude.json') });
    const proxy = new OpenCodexClaudeRuntime({ config: settings, claudeJsonPath: join(dir, 'claude.json') }, origin);
    const nativeCommand = native.buildLaunchCommand(session('claude-code', 'native-model'), identity(), {});
    const proxyCommand = proxy.buildLaunchCommand(session('opencodex-claude', 'provider/model-id'), identity(), {});

    expect(nativeCommand).toContain('CONFIG_SECRET');
    expect(proxyCommand).not.toContain('CONFIG_SECRET');
    expect(proxyCommand).not.toContain('ocx claude');
    expect(proxyCommand).toContain('unset ANTHROPIC_API_KEY');
    expect(proxyCommand).toContain('CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY');
    expect(() => proxy.buildLaunchCommand(session('opencodex-claude'), identity(), {})).toThrow(/explicit model/u);

    await execFileAsync('sh', ['-c', proxyCommand], {
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: 'INHERITED_SECRET',
        ANTHROPIC_AUTH_TOKEN: 'INHERITED_TOKEN',
        ANTHROPIC_MODEL: 'native-model',
      },
    });
    const launched = readFileSync(marker, 'utf8');
    expect(launched).toContain(origin);
    expect(launched).toContain('opencodex-proxy');
    expect(launched).toContain('unset\nunset\n');
    expect(launched).toContain('--model\nprovider/model-id');
    expect(launched).not.toContain('INHERITED_SECRET');
    expect(launched).not.toContain('INHERITED_TOKEN');

    rmSync(marker);
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await expect(execFileAsync('sh', ['-c', proxyCommand])).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
  });

  it('registers optional names only after a supervisor restart and injects the enabled notice', async () => {
    const configDir = join(dir, 'config');
    mkdirSync(join(configDir, 'sessions'), { recursive: true });
    writeFileSync(join(configDir, 'sessions', 'native.yaml'), `codename: native\nrepo: ${dir}\nruntime: claude-code\n`);
    const configFile = join(configDir, 'supervisor.yaml');
    writeFileSync(configFile, 'terminal:\n  backend: tmux\n');
    const options = {
      terminalBackend: new FakeTerminalBackend(),
      includeConfiguredChannels: false,
      claudeJsonPath: join(dir, 'claude.json'),
      env: {},
    };

    supervisor = new Supervisor(dir, options);
    expect(await supervisor.command('/help')).not.toContain('opencodex');
    await supervisor.command('/start native');
    const snapshot = join(dir, 'data', 'sessions', 'native', 'conductor-protocol.md');
    expect(readFileSync(snapshot, 'utf8')).not.toContain('OpenCodex');
    await supervisor.stop();
    supervisor = undefined;

    writeFileSync(
      configFile,
      'terminal:\n  backend: tmux\nruntimes:\n  openCodex:\n    enabled: true\n    proxyOrigin: http://127.0.0.1:10100\n',
    );
    supervisor = new Supervisor(dir, options);
    expect(await supervisor.command('/help')).toContain('opencodex');
    expect(await supervisor.command('/help')).not.toContain('opencodex-claude');
    await supervisor.command('/start native');
    expect(readFileSync(snapshot, 'utf8')).toContain('OpenCodex proxy harness is configured');
    expect(readFileSync(snapshot, 'utf8')).toContain('load the opencodex topic');
    await supervisor.stop();
    supervisor = undefined;

    writeFileSync(
      configFile,
      'terminal:\n  backend: tmux\nruntimes:\n  openCodex:\n    enabled: true\n    proxyOrigin: http://127.0.0.1:10100\n    claudeCodeEnabled: true\n',
    );
    supervisor = new Supervisor(dir, options);
    expect(await supervisor.command('/help')).toContain('opencodex-claude');
  });
});
