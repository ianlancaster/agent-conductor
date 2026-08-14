import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionConfigSchema } from '../src/config/schema.js';
import { CodexRuntime, type CodexRuntimeSettings } from '../src/runtimes/codex/index.js';
import { resolveExecutable } from '../src/runtimes/executable.js';
import { SpartanRuntime } from '../src/runtimes/spartan/index.js';
import type { IdentityEndpoints } from '../src/runtimes/types.js';

const CODEX_SETTINGS: CodexRuntimeSettings = {
  binary: 'codex-custom',
  toolTimeoutSec: 600,
  bareUi: true,
  bypassHookTrust: true,
};

describe('SpartanRuntime', () => {
  let root: string;
  let repo: string;
  let configDir: string;
  let executablePath: string;
  let previousCodexHome: string | undefined;

  const identity = (): IdentityEndpoints => ({
    mcpUrl: 'http://127.0.0.1:3456/mcp/sample',
    eventsUrl: 'http://127.0.0.1:3456/events/sample',
    configDir,
  });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'spartan-runtime-'));
    repo = path.join(root, 'repo with spaces');
    configDir = path.join(root, 'config with spaces');
    const binDir = path.join(root, 'bin with spaces');
    executablePath = path.join(binDir, 'codex-custom');
    await mkdir(repo, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(executablePath, '#!/bin/sh\nexit 0\n');
    await chmod(executablePath, 0o755);
    const sharedHome = path.join(root, 'shared-codex');
    await mkdir(sharedHome);
    previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = sharedHome;
  });

  afterEach(async () => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(root, { recursive: true, force: true });
  });

  it('preserves the complete Codex command while changing only launcher and managed exports', async () => {
    const launcher = path.join(root, 'Spartan CLI', 'spartan');
    const runtime = new SpartanRuntime({
      config: { binary: launcher },
      codexConfig: CODEX_SETTINGS,
      baseDir: root,
      env: { PATH: path.dirname(executablePath) },
    });
    const session = sessionConfigSchema.parse({
      codename: 'sample',
      repo,
      runtime: 'spartan',
      model: 'gpt-test',
      effort: 'xhigh',
      additionalDirs: ['shared dir'],
    });
    await runtime.prepare(session, identity());

    const opts = { continueSession: true, bypassPermissions: true, prompt: "fix o'brien", effort: 'ultra' };
    const command = runtime.buildLaunchCommand(session, identity(), opts);
    const native = new CodexRuntime({ config: CODEX_SETTINGS, baseDir: root }).buildLaunchCommand(
      session,
      identity(),
      opts,
    );
    const expected = native.replace(
      "&& 'codex-custom' ",
      `&& export SPARTAN_CODEX_BINARY='${executablePath}' && export SPARTAN_CODEX_HOME_ISOLATED='1' && '${launcher}' `,
    );

    expect(runtime.name).toBe('spartan');
    expect(command).toBe(expected);
    expect(command).toContain("'" + launcher + "' resume --last");
    expect(command).toContain("--model 'gpt-test'");
    expect(command).toContain("--add-dir '" + path.join(root, 'shared dir') + "'");
    expect(command.endsWith("-- 'fix o'\\''brien'")).toBe(true);
    expect(command).not.toContain('mcp_servers.spartan');
  });

  it('inherits Codex ready, busy, and composer detection through the wrapper layer', () => {
    const runtime = new SpartanRuntime({
      config: { binary: 'spartan' },
      codexConfig: CODEX_SETTINGS,
      baseDir: root,
      env: { PATH: path.dirname(executablePath) },
    });
    expect(runtime.parseInputState("› What's on your mind?\n  100% context left", 'sample')).toBe('clear');
    expect(runtime.parseActivityState('• Working (2s • esc to interrupt)')).toBe('working');
    expect(runtime.parseActivityState('› typed draft\n  100% context left')).toBe('idle');
  });

  it('fails prepare with a distinct underlying-Codex diagnosis', async () => {
    const runtime = new SpartanRuntime({
      config: { binary: 'spartan' },
      codexConfig: { ...CODEX_SETTINGS, binary: 'missing-codex' },
      baseDir: root,
      env: { PATH: path.dirname(executablePath) },
    });
    const session = sessionConfigSchema.parse({ codename: 'sample', repo, runtime: 'spartan' });
    await expect(runtime.prepare(session, identity())).rejects.toThrow(
      "SPARTAN requires the configured Codex CLI 'missing-codex'",
    );
  });
});

describe('resolveExecutable', () => {
  it('resolves a bare executable against the supplied pane environment PATH', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'conductor-executable-'));
    try {
      const bin = path.join(root, 'bin with spaces');
      const executable = path.join(bin, 'codex');
      await mkdir(bin);
      await writeFile(executable, '#!/bin/sh\n');
      await chmod(executable, 0o755);
      await expect(resolveExecutable('codex', { cwd: root, env: { PATH: bin } })).resolves.toBe(executable);
      await expect(resolveExecutable('missing', { cwd: root, env: { PATH: bin } })).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
