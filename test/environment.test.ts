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
  mkdirSync(join(baseDir, '.conductor', 'config'), { recursive: true });
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('resolveFleetEnvironment', () => {
  it('loads a fleet .conductor/.env without mutating the inherited object', () => {
    writeFileSync(join(baseDir, '.conductor', '.env'), 'CONDUCTOR_TELEGRAM_TOKEN=file-token\nEXTRA=file-only\n');
    const inherited = { PATH: '/bin' };

    const resolved = resolveFleetEnvironment(baseDir, inherited);

    expect(resolved).toEqual({ CONDUCTOR_TELEGRAM_TOKEN: 'file-token', EXTRA: 'file-only', PATH: '/bin' });
    expect(resolved).not.toBe(inherited);
    expect(inherited).toEqual({ PATH: '/bin' });
  });

  it('lets .conductor/.env override stale inherited shell, CI, or service values', () => {
    writeFileSync(join(baseDir, '.conductor', '.env'), 'VALUE=from-file\nFILE_ONLY=yes\n');
    expect(resolveFleetEnvironment(baseDir, { VALUE: 'from-parent' })).toMatchObject({
      VALUE: 'from-file',
      FILE_ONLY: 'yes',
    });
  });

  it('accepts a missing .env and still returns a new object', () => {
    const inherited = { VALUE: 'present' };
    const resolved = resolveFleetEnvironment(baseDir, inherited);
    expect(resolved).toEqual(inherited);
    expect(resolved).not.toBe(inherited);
  });

  it('keeps reading a root .env for a legacy root-level config', () => {
    rmSync(join(baseDir, '.conductor'), { recursive: true });
    mkdirSync(join(baseDir, 'config', 'sessions'), { recursive: true });
    writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), '');
    writeFileSync(join(baseDir, '.env'), 'LEGACY=yes\n');

    expect(resolveFleetEnvironment(baseDir, {})).toMatchObject({ LEGACY: 'yes' });
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
      }).channels,
    ).toEqual([]);
  });

  it('constructs Telegram only when explicitly enabled with both credentials', () => {
    writeFileSync(
      join(baseDir, '.conductor', 'config', 'supervisor.yaml'),
      'channels:\n  telegram:\n    enabled: true\n',
    );
    const config = loadSupervisorConfig(baseDir, {});
    const resolution = buildConfiguredChannels(config, {
      CONDUCTOR_TELEGRAM_TOKEN: 'token',
      CONDUCTOR_TELEGRAM_CHAT_ID: '123',
    });
    expect(resolution.channels.map((channel) => channel.name)).toEqual(['telegram']);
    expect(resolution.unavailable).toEqual([]);
  });

  it('constructs Slack only when explicitly enabled with all three credentials', () => {
    writeFileSync(join(baseDir, '.conductor', 'config', 'supervisor.yaml'), 'channels:\n  slack:\n    enabled: true\n');
    const config = loadSupervisorConfig(baseDir, {});
    const resolution = buildConfiguredChannels(config, {
      CONDUCTOR_SLACK_APP_TOKEN: 'xapp-test',
      CONDUCTOR_SLACK_BOT_TOKEN: 'xoxb-test',
      CONDUCTOR_SLACK_OPERATOR_USER_ID: 'U123',
    });
    expect(resolution.channels.map((channel) => channel.name)).toEqual(['slack']);
    expect(resolution.unavailable).toEqual([]);
  });

  it('composes enabled adapters and degrades missing channel credentials independently', () => {
    writeFileSync(
      join(baseDir, '.conductor', 'config', 'supervisor.yaml'),
      'channels:\n  telegram:\n    enabled: true\n  slack:\n    enabled: true\n',
    );
    const config = loadSupervisorConfig(baseDir, {});
    const unavailable = buildConfiguredChannels(config, {}).unavailable;
    expect(unavailable).toEqual([
      {
        name: 'telegram',
        reason: 'missing or blank: CONDUCTOR_TELEGRAM_TOKEN, CONDUCTOR_TELEGRAM_CHAT_ID',
      },
      {
        name: 'slack',
        reason:
          'missing or blank: CONDUCTOR_SLACK_BOT_TOKEN, CONDUCTOR_SLACK_APP_TOKEN, CONDUCTOR_SLACK_OPERATOR_USER_ID',
      },
    ]);
    expect(
      buildConfiguredChannels(config, {
        CONDUCTOR_TELEGRAM_TOKEN: 'telegram-secret',
        CONDUCTOR_TELEGRAM_CHAT_ID: '123',
        CONDUCTOR_SLACK_APP_TOKEN: 'xapp-secret',
        CONDUCTOR_SLACK_BOT_TOKEN: 'xoxb-secret',
        CONDUCTOR_SLACK_OPERATOR_USER_ID: 'U123',
      }).channels.map((channel) => channel.name),
    ).toEqual(['telegram', 'slack']);
  });

  it('reports missing or blank enabled credentials without reflecting values', () => {
    writeFileSync(
      join(baseDir, '.conductor', 'config', 'supervisor.yaml'),
      'channels:\n  telegram:\n    enabled: true\n',
    );
    const config = loadSupervisorConfig(baseDir, {});

    expect(
      buildConfiguredChannels(config, {
        CONDUCTOR_TELEGRAM_TOKEN: 'super-secret',
        CONDUCTOR_TELEGRAM_CHAT_ID: '   ',
      }).unavailable,
    ).toEqual([{ name: 'telegram', reason: 'missing or blank: CONDUCTOR_TELEGRAM_CHAT_ID' }]);
    expect(JSON.stringify(buildConfiguredChannels(config, { CONDUCTOR_TELEGRAM_TOKEN: 'super-secret' }))).not.toContain(
      'super-secret',
    );
  });
});
