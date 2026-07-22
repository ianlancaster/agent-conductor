import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { createSlackClientFactory, type SlackSdkLoaders } from '../src/channels/slack/sdk.js';

const missing = (name: string): Promise<never> =>
  Promise.reject(Object.assign(new Error(`Cannot find package ${name}`), { code: 'ERR_MODULE_NOT_FOUND' }));

function loaders(): SlackSdkLoaders {
  class Socket {
    on(): this {
      return this;
    }
    off(): this {
      return this;
    }
    async start(): Promise<void> {
      return undefined;
    }
    async disconnect(): Promise<void> {
      return undefined;
    }
  }
  class Web {
    auth = { test: async () => ({}) };
    conversations = { open: async () => ({}) };
    chat = { postMessage: async () => ({}) };
  }
  return {
    socketMode: async () => ({ LogLevel: { ERROR: 4 }, SocketModeClient: Socket }),
    webApi: async () => ({ WebClient: Web }),
    undici: async () => ({}),
  };
}

describe('Slack optional SDK loading', () => {
  it('keeps the public root import and a Slack-disabled Supervisor free of Slack runtime modules', () => {
    expect(() =>
      execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          [
            "import { mkdtempSync, rmSync } from 'node:fs'",
            "import { tmpdir } from 'node:os'",
            "import { join } from 'node:path'",
            "import { createRequire } from 'node:module'",
            "const { Supervisor } = await import('./src/index.ts')",
            "const dir = mkdtempSync(join(tmpdir(), 'conductor-slack-purity-'))",
            'const supervisor = new Supervisor(dir, { env: {} })',
            'await supervisor.stop()',
            "const loaded = Object.keys(createRequire(import.meta.url).cache).filter((path) => path.includes('@slack') || path.includes('/undici/'))",
            "if (loaded.length) throw new Error('Slack runtime leaked through public import: ' + loaded.join(','))",
            'rmSync(dir, { recursive: true, force: true })',
          ].join(';'),
        ],
        { cwd: process.cwd(), stdio: 'pipe' },
      ),
    ).not.toThrow();
  });

  it.each(['socketMode', 'webApi', 'undici'] as const)(
    'names every required package when %s is absent',
    async (key) => {
      const configured = loaders();
      configured[key] = () => missing(key);
      await expect(createSlackClientFactory(configured).create({ appToken: 'xapp', botToken: 'xoxb' })).rejects.toThrow(
        /@slack\/socket-mode.*@slack\/web-api.*undici.*--omit=optional/,
      );
    },
  );
});
