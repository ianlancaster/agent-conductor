import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfiguredIntegration } from '../src/config/schema.js';
import { validateConfig } from '../src/config/loader.js';
import { IntegrationManager } from '../src/core/integration-manager.js';
import { ConductorEventBus } from '../src/events/bus.js';
import { loadConfiguredIntegrations, resolveConfiguredIntegrations } from '../src/integrations/configured.js';

let fleetDir: string;

beforeEach(() => {
  fleetDir = mkdtempSync(join(tmpdir(), 'conductor-configured-integration-'));
  mkdirSync(join(fleetDir, 'config', 'sessions'), { recursive: true });
  writeFileSync(join(fleetDir, 'config', 'supervisor.yaml'), '');
});

afterEach(() => {
  rmSync(fleetDir, { recursive: true, force: true });
});

function moduleFile(name: string, source: string): string {
  const path = join(fleetDir, 'integrations', name);
  mkdirSync(join(fleetDir, 'integrations'), { recursive: true });
  writeFileSync(path, source);
  return path;
}

function entry(module: string, options: Record<string, unknown> = {}): ConfiguredIntegration {
  return { module, options };
}

describe('configured integration file resolution', () => {
  it('resolves explicit fleet-relative and absolute regular files without executing them', () => {
    const relativePath = moduleFile('relative.mjs', 'throw new Error("must not execute");\n');
    const absolutePath = moduleFile('absolute.mjs', 'throw new Error("must not execute");\n');

    const resolved = resolveConfiguredIntegrations(fleetDir, [
      entry('./integrations/relative.mjs'),
      entry(absolutePath),
    ]);

    expect(resolved.map((item) => item.modulePath)).toEqual([relativePath, absolutePath]);
    expect(resolved.every((item) => item.moduleUrl.startsWith('file:'))).toBe(true);
  });

  it.each([
    ['water-cooler', 'bare module specifiers'],
    ['https://example.test/integration.mjs', 'URLs and file: specifiers'],
    ['file:///tmp/integration.mjs', 'URLs and file: specifiers'],
    ['../outside.mjs', 'escapes the fleet root'],
  ])('rejects unsupported module path %s', (configuredModule, expected) => {
    expect(() => resolveConfiguredIntegrations(fleetDir, [entry(configuredModule)])).toThrow(expected);
  });

  it('reports configured and resolved paths for missing files and directories', () => {
    mkdirSync(join(fleetDir, 'integrations'));
    expect(() => resolveConfiguredIntegrations(fleetDir, [entry('./integrations/missing.mjs')])).toThrow(
      /'.\/integrations\/missing\.mjs' resolved to '.*missing\.mjs': file does not exist/u,
    );
    expect(() => resolveConfiguredIntegrations(fleetDir, [entry('./integrations')])).toThrow(
      /path is not a regular file/u,
    );
  });
});

describe('configured integration factory loading', () => {
  it('passes a shallow-frozen copy of fleetDir and opaque options to one synchronous default factory', async () => {
    moduleFile(
      'capture.mjs',
      `export default (input) => ({\n` +
        `  name: 'capture',\n` +
        `  observed: { fleetDir: input.fleetDir, options: input.options, inputFrozen: Object.isFrozen(input), optionsFrozen: Object.isFrozen(input.options) },\n` +
        `  start() {},\n` +
        `  stop() {},\n` +
        `});\n`,
    );
    const originalOptions = { targetSession: 'assistant', nested: { retained: true } };

    const [loaded] = await loadConfiguredIntegrations(fleetDir, [entry('./integrations/capture.mjs', originalOptions)]);
    const observed = (
      loaded as unknown as {
        observed: {
          fleetDir: string;
          options: Record<string, unknown>;
          inputFrozen: boolean;
          optionsFrozen: boolean;
        };
      }
    ).observed;

    expect(observed).toEqual({
      fleetDir,
      options: originalOptions,
      inputFrozen: true,
      optionsFrozen: true,
    });
    expect(observed.options).not.toBe(originalOptions);
  });

  it('invokes the same cached module once per entry in configuration order and leaves duplicate names to Manager', async () => {
    moduleFile(
      'repeated.mjs',
      `let call = 0;\n` +
        `export default (input) => ({ name: 'duplicate', call: ++call, marker: input.options.marker, start() {}, stop() {} });\n`,
    );

    const loaded = await loadConfiguredIntegrations(fleetDir, [
      entry('./integrations/repeated.mjs', { marker: 'first' }),
      entry('./integrations/repeated.mjs', { marker: 'second' }),
    ]);

    expect(
      loaded.map((item) => {
        const value = item as unknown as { call: number; marker: string };
        return [value.call, value.marker];
      }),
    ).toEqual([
      [1, 'first'],
      [2, 'second'],
    ]);
    expect(
      () =>
        new IntegrationManager({
          integrations: loaded,
          dataDir: join(fleetDir, 'data'),
          events: new ConductorEventBus('configured-test'),
          sendToSession: async () => ({
            messageId: 1,
            recipient: 'assistant',
            status: 'delivered',
            deduplicated: false,
          }),
        }),
    ).toThrow("Duplicate integration name 'duplicate'");
  });

  it.each([
    ['missing-default.mjs', 'export const value = 1;\n', 'must default-export'],
    ['non-function.mjs', 'export default {};\n', 'must default-export'],
    ['throws.mjs', `export default () => { throw new Error('bad options'); };\n`, 'factory threw: bad options'],
    ['promise.mjs', `export default () => Promise.resolve({});\n`, 'returned a thenable'],
    ['custom-thenable.mjs', `export default () => ({ then() {} });\n`, 'returned a thenable'],
    ['null.mjs', `export default () => null;\n`, 'must return one ConductorIntegration object'],
    ['array.mjs', `export default () => [];\n`, 'must return one ConductorIntegration object'],
  ])('fails before Supervisor readiness for %s', async (name, source, expected) => {
    moduleFile(name, source);
    await expect(loadConfiguredIntegrations(fleetDir, [entry(`./integrations/${name}`)])).rejects.toThrow(expected);
  });

  it('keeps validate non-executing while checking every configured module file', async () => {
    const marker = join(fleetDir, 'imported.marker');
    moduleFile(
      'side-effect.mjs',
      `import { writeFileSync } from 'node:fs';\n` +
        `writeFileSync(${JSON.stringify(marker)}, 'imported');\n` +
        `export default () => ({ name: 'side-effect', start() {}, stop() {} });\n`,
    );
    writeFileSync(
      join(fleetDir, 'config', 'supervisor.yaml'),
      `integrations:\n  - module: ./integrations/side-effect.mjs\n`,
    );

    expect(validateConfig(fleetDir)).toEqual([]);
    expect(() => resolveConfiguredIntegrations(fleetDir, [entry('./integrations/side-effect.mjs')])).not.toThrow();
    expect(existsSync(marker)).toBe(false);

    await loadConfiguredIntegrations(fleetDir, [entry('./integrations/side-effect.mjs')]);
    expect(existsSync(marker)).toBe(true);
  });

  it('reports integration file failures even when session validation also fails', () => {
    writeFileSync(
      join(fleetDir, 'config', 'supervisor.yaml'),
      'integrations:\n  - module: ./integrations/missing.mjs\n',
    );
    writeFileSync(join(fleetDir, 'config', 'sessions', 'broken.yaml'), 'codename: broken\nrepo: []\n');

    const problems = validateConfig(fleetDir);
    expect(problems.some((problem) => problem.includes('integrations[0].module'))).toBe(true);
    expect(problems.some((problem) => problem.includes('Invalid session config'))).toBe(true);
  });
});
