import { existsSync, mkdirSync, realpathSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { supervisorConfigSchema } from '../src/config/schema.js';
import { validateConfig } from '../src/config/loader.js';
import { runPreflight } from '../src/cli/doctor.js';
import { loadConfiguredRuntimeAdapters, resolveConfiguredRuntimeAdapters } from '../src/runtimes/configured.js';
import { Supervisor } from '../src/core/supervisor.js';
import type { ConductorOperations } from '../src/core/operations.js';
import { buildMcpTools } from '../src/mcp/tools.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';

let dir: string;
let supervisor: Supervisor | undefined;
const body = `(input) => ({name: input.name, input,
 capabilities: {lifecycleEvents:false,contextProbe:false,styledCapture:false},
 async prepare(){}, buildLaunchCommand(session, identity, options){return 'fake '+session.model+' '+options.effort},
 parseInputState(){return null}, stripChrome(s){return s}, parseEvent(){return null}
})`;
const source = `export const runtimeAdapterApiVersion=1; export default ${body};`;
const host = () => ({
  conductorVersion: '0.1.0',
  protocolPath: join(dir, 'protocol.md'),
  sessionDataDir: join(dir, 'data', 'sessions'),
});
const entry = (module = './adapter.mjs', name = 'external') => ({ name, module, options: {} });
function file(text = source, name = 'adapter.mjs') {
  const path = join(dir, name);
  writeFileSync(path, text);
  return path;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conductor-runtime-config-'));
  mkdirSync(join(dir, 'config', 'sessions'), { recursive: true });
  writeFileSync(join(dir, 'config', 'supervisor.yaml'), '');
});
afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('configured runtime adapters', () => {
  it('is optional, strict, and preserves reserved built-ins', () => {
    expect(supervisorConfigSchema.parse({}).runtimeAdapters).toEqual([]);
    for (const name of ['codex', 'claude-code', 'cc', ' bad', 'a/b'])
      expect(() => supervisorConfigSchema.parse({ runtimeAdapters: [entry('./x', name)] })).toThrow();
    expect(() => supervisorConfigSchema.parse({ runtimeAdapters: [entry(), entry()] })).toThrow(/duplicate/);
    expect(() =>
      supervisorConfigSchema.parse({ runtimeAdapters: [{ ...entry(), env: { TOKEN: 'synthetic' } }] }),
    ).toThrow();
  });
  it('validate and doctor inspect files without executing imports or factories', async () => {
    const marker = join(dir, 'executed');
    file(`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'bad');throw Error('bad')`);
    writeFileSync(
      join(dir, 'config', 'supervisor.yaml'),
      'runtimeAdapters:\n  - name: external\n    module: ./adapter.mjs\n',
    );
    expect(validateConfig(dir)).toEqual([]);
    const results = await runPreflight(dir, {
      nodeVersion: '24.1.0',
      platform: 'linux',
      executablePath: '/opt/conductor',
      command: () => ({ ok: true, stdout: 'tmux 3.4' }),
      writable: () => true,
      portState: async () => 'available',
    });
    expect(results).toContainEqual(expect.objectContaining({ label: 'Configured runtime adapters', level: 'pass' }));
    expect(existsSync(marker)).toBe(false);
  });
  it.each(['package-name', 'https://example.invalid/x.mjs', 'file:///tmp/x.mjs', '../outside.mjs', './missing'])(
    'rejects unsupported or missing path %s',
    (module) => {
      expect(() => resolveConfiguredRuntimeAdapters(dir, [entry(module)])).toThrow();
    },
  );
  it('rejects relative symlink escape, permits explicit absolute files', () => {
    const outside = mkdtempSync(join(tmpdir(), 'conductor-external-runtime-'));
    try {
      const target = join(outside, 'adapter.mjs');
      writeFileSync(target, source);
      symlinkSync(target, join(dir, 'adapter.mjs'));
      expect(() => resolveConfiguredRuntimeAdapters(dir, [entry()])).toThrow(/escapes/);
      expect(resolveConfiguredRuntimeAdapters(dir, [entry(target)])[0]?.modulePath).toBe(realpathSync(target));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
  it('preflights all files before any import and rejects direct duplicate registration', async () => {
    const marker = join(dir, 'executed');
    file(`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'bad');${source}`);
    await expect(loadConfiguredRuntimeAdapters(dir, [entry(), entry('./missing', 'second')], host())).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
    expect(() => resolveConfiguredRuntimeAdapters(dir, [entry(), entry()])).toThrow(/duplicate/);
  });
  it.each([
    ['version', source.replace('ApiVersion=1', 'ApiVersion=2')],
    ['export', 'export const runtimeAdapterApiVersion=1; export default {};'],
    ['name', source.replace('name: input.name', "name: 'codex'")],
    ['method', source.replace('async prepare(){}', 'prepare:3')],
    ['capability', source.replace('styledCapture:false', 'styledCapture:3')],
    ['throw', "export const runtimeAdapterApiVersion=1; export default ()=>{throw Error('SECRET_OPTIONS')};"],
    ['import', "throw Error('SECRET_OPTIONS');"],
    ['async', "export const runtimeAdapterApiVersion=1; export default async()=>{throw Error('SECRET_OPTIONS')};"],
  ])('fails closed on %s without copying arbitrary error text', async (_name, text) => {
    file(text);
    const error = await loadConfiguredRuntimeAdapters(dir, [entry()], host()).catch((e) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : '').not.toContain('SECRET_OPTIONS');
  });
  it('passes versioned resolved context and preserves named-instance data paths', async () => {
    file();
    const context = { ...host(), sessionDataDir: join(dir, '.conductor', 'instances', 'test', 'data', 'sessions') };
    const [runtime] = await loadConfiguredRuntimeAdapters(
      dir,
      [{ ...entry(), options: { profile: './profile.json' } }],
      context,
    );
    expect((runtime as unknown as { input: unknown }).input).toEqual({
      ...context,
      apiVersion: 1,
      name: 'external',
      fleetDir: dir,
      options: { profile: './profile.json' },
    });
  });
  it('loads an external runtime into the real registry and routes MCP spawning without replacing built-ins', async () => {
    file();
    writeFileSync(join(dir, 'config', 'sessions', 'parent.yaml'), `codename: parent\nrepo: ${dir}\nruntime: codex\n`);
    const runtimes = await loadConfiguredRuntimeAdapters(dir, [entry()], host());
    const terminal = new FakeTerminalBackend();
    supervisor = new Supervisor(dir, {
      runtimes,
      terminalBackend: terminal,
      includeConfiguredChannels: false,
      env: {},
    });
    const operations = (supervisor as unknown as { operations: ConductorOperations }).operations;
    const spawn = buildMcpTools(operations).find((t) => t.name === 'spawn_session')!;
    expect(spawn.inputSchema).toMatchObject({
      properties: { runtime: { enum: ['claude-code', 'cc', 'codex', 'external'] } },
    });
    await spawn.handler(
      { codename: 'worker', path: join(dir, 'worker'), runtime: 'external', model: 'provider/model', effort: 'low' },
      'parent',
    );
    expect([...terminal.panes.values()].flatMap((p) => p.launched).join('\n')).toContain('fake provider/model low');
    expect(await supervisor.command('/help')).toContain('cc|claude-code|codex|external');
  });
});
