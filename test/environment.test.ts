import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildConfiguredChannels } from '../src/channels/configured.js';
import { resolveFleetEnvironment } from '../src/config/environment.js';
import { loadSupervisorConfig } from '../src/config/loader.js';

let baseDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'conductor-environment-'));
  mkdirSync(join(baseDir, 'config'), { recursive: true });
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('resolveFleetEnvironment', () => {
  it('loads a fleet .env without mutating the inherited object', () => {
    writeFileSync(join(baseDir, '.env'), 'CONDUCTOR_TELEGRAM_TOKEN=file-token\nEXTRA=file-only\n');
    const inherited = { PATH: '/bin' };

    const resolved = resolveFleetEnvironment(baseDir, inherited);

    expect(resolved).toEqual({ CONDUCTOR_TELEGRAM_TOKEN: 'file-token', EXTRA: 'file-only', PATH: '/bin' });
    expect(resolved).not.toBe(inherited);
    expect(inherited).toEqual({ PATH: '/bin' });
  });

  it('lets inherited shell, CI, or service values override .env', () => {
    writeFileSync(join(baseDir, '.env'), 'VALUE=from-file\nFILE_ONLY=yes\n');
    expect(resolveFleetEnvironment(baseDir, { VALUE: 'from-parent' })).toMatchObject({
      VALUE: 'from-parent',
      FILE_ONLY: 'yes',
    });
  });

  it('accepts a missing .env and still returns a new object', () => {
    const inherited = { VALUE: 'present' };
    const resolved = resolveFleetEnvironment(baseDir, inherited);
    expect(resolved).toEqual(inherited);
    expect(resolved).not.toBe(inherited);
  });
});

describe('buildConfiguredChannels', () => {
  it('keeps Telegram disabled by default even when credentials are present', () => {
    const config = loadSupervisorConfig(baseDir, {});
    expect(config.channels.telegram.enabled).toBe(false);
    expect(
      buildConfiguredChannels(config, {
        CONDUCTOR_TELEGRAM_TOKEN: 'token',
        CONDUCTOR_TELEGRAM_CHAT_ID: '123',
      }),
    ).toEqual([]);
  });

  it('constructs Telegram only when explicitly enabled with both credentials', () => {
    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'channels:\n  telegram:\n    enabled: true\n');
    const config = loadSupervisorConfig(baseDir, {});
    const channels = buildConfiguredChannels(config, {
      CONDUCTOR_TELEGRAM_TOKEN: 'token',
      CONDUCTOR_TELEGRAM_CHAT_ID: '123',
    });
    expect(channels.map((channel) => channel.name)).toEqual(['telegram']);
  });

  it('rejects missing or blank enabled credentials without reflecting values', () => {
    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), 'channels:\n  telegram:\n    enabled: true\n');
    const config = loadSupervisorConfig(baseDir, {});

    expect(() =>
      buildConfiguredChannels(config, {
        CONDUCTOR_TELEGRAM_TOKEN: 'super-secret',
        CONDUCTOR_TELEGRAM_CHAT_ID: '   ',
      }),
    ).toThrow(/CONDUCTOR_TELEGRAM_CHAT_ID.*missing or blank/);
    try {
      buildConfiguredChannels(config, { CONDUCTOR_TELEGRAM_TOKEN: 'super-secret' });
    } catch (error) {
      expect(String(error)).not.toContain('super-secret');
    }
  });
});
