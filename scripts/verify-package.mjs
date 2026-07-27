import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 60_000,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${String(result.status)}):\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return result.stdout ?? '';
}

const scratch = mkdtempSync(join(tmpdir(), 'agent-conductor-package-'));
try {
  let tarball = process.argv[2] === undefined ? undefined : resolve(process.argv[2]);
  if (tarball === undefined) {
    const packDir = join(scratch, 'pack');
    mkdirSync(packDir);
    const packOutput = run('npm', ['pack', '--json', '--pack-destination', packDir]);
    const jsonStart = Math.max(packOutput.lastIndexOf('\n[') + 1, packOutput.indexOf('['));
    const packed = JSON.parse(packOutput.slice(jsonStart));
    const filename = packed[0]?.filename;
    if (typeof filename !== 'string') throw new Error('npm pack did not report a tarball filename');
    tarball = join(packDir, filename);
  }
  if (!existsSync(tarball)) throw new Error(`Tarball does not exist: ${tarball}`);

  const entries = run('tar', ['-tzf', tarball]).split('\n').filter(Boolean);
  const required = [
    'package/package.json',
    'package/LICENSE',
    'package/dist/index.js',
    'package/dist/index.d.ts',
    'package/dist/cli/index.js',
    'package/dist/shepherd/cli.js',
    'package/docs/agent-guide.md',
    'package/runbooks/agent-conductor/engineering-management/runbook.yaml',
    'package/runbooks/agent-conductor/engineering-management/README.md',
    'package/runbooks/agent-conductor/engineering-management/topics/tier-1.md',
    'package/runbooks/agent-conductor/engineering-management/topics/cognitive-agent-bootstrap.md',
    'package/guides/external-adapters.md',
    'package/guides/event-subscribers.md',
    'package/guides/runbooks.md',
    'package/prompts/conductor-protocol.md',
    'package/prompts/sentinel.md',
    'package/examples/supervisor.yaml',
    'package/examples/pr-shepherd.scaffold.yaml',
    'package/env.template',
    'package/scripts/prepare.mjs',
  ];
  for (const entry of required) {
    if (!entries.includes(entry)) throw new Error(`Packed artifact is missing ${entry}`);
  }
  const forbidden = entries.filter(
    (entry) =>
      /(^|\/)\.env$/u.test(entry) ||
      /(^|\/)\.conductor(\/|$)/u.test(entry) ||
      /(^|\/)data(\/|$)/u.test(entry) ||
      /\.log$/u.test(entry) ||
      entry.startsWith('package/src/') ||
      entry.startsWith('package/test/') ||
      entry.startsWith('package/.changeset/'),
  );
  if (forbidden.length > 0) throw new Error(`Forbidden packed entries:\n${forbidden.join('\n')}`);

  const prefix = join(scratch, 'global');
  run('npm', ['install', '--global', '--prefix', prefix, tarball]);
  const conductor = join(prefix, 'bin', 'conductor');
  const shepherd = join(prefix, 'bin', 'pr-shepherd');
  const packageVersion = JSON.parse(readFileSync('package.json', 'utf8')).version;
  if (run(conductor, ['--version']).trim() !== packageVersion) throw new Error('conductor version mismatch');
  if (run(shepherd, ['--version']).trim() !== packageVersion) throw new Error('pr-shepherd version mismatch');
  run(conductor, ['--help']);

  const pnpmPrefix = join(scratch, 'pnpm-global');
  const pnpmBin = join(pnpmPrefix, 'bin');
  mkdirSync(pnpmBin, { recursive: true });
  run('pnpm', ['add', '--global', '--global-dir', join(pnpmPrefix, 'packages'), '--global-bin-dir', pnpmBin, tarball], {
    env: { ...process.env, PNPM_HOME: pnpmBin, PATH: `${pnpmBin}:${process.env.PATH ?? ''}` },
  });
  if (run(join(pnpmBin, 'conductor'), ['--version']).trim() !== packageVersion) {
    throw new Error('pnpm global installation version mismatch');
  }

  const yarnPrefix = join(scratch, 'yarn-global');
  mkdirSync(join(yarnPrefix, 'bin'), { recursive: true });
  run('corepack', ['yarn@1.22.22', 'global', 'add', `file:${tarball}`, '--prefix', yarnPrefix], {
    cwd: scratch,
    env: {
      ...process.env,
      YARN_CACHE_FOLDER: join(scratch, 'yarn-cache'),
      YARN_GLOBAL_FOLDER: join(scratch, 'yarn-packages'),
    },
  });
  if (run(join(yarnPrefix, 'bin', 'conductor'), ['--version']).trim() !== packageVersion) {
    throw new Error('Yarn Classic global installation version mismatch');
  }

  const fakeBin = join(scratch, 'bin');
  mkdirSync(fakeBin);
  for (const binary of ['claude', 'codex']) {
    const path = join(fakeBin, binary);
    writeFileSync(path, `#!/bin/sh\necho "${binary} package-test"\n`);
    chmodSync(path, 0o755);
  }
  const fleet = join(scratch, 'fleet');
  mkdirSync(fleet);
  const fleetEnv = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}`, TMUX: 'package-test' };
  run(conductor, ['-C', fleet, 'doctor'], { env: fleetEnv });
  const startOutput = run(conductor, ['-C', fleet, 'start'], { env: fleetEnv, input: '' });
  if (!startOutput.includes('Initialized missing fleet files:')) throw new Error('fresh start omitted scaffold output');
  if (startOutput.includes('First-session onboarding') || startOutput.includes('iTerm automation')) {
    throw new Error('fresh start included documentation-owned onboarding or permission guidance');
  }
  if (!existsSync(join(fleet, '.conductor', 'config', 'supervisor.yaml'))) {
    throw new Error('fresh start did not create the fleet scaffold');
  }
  const runbookList = run(conductor, ['-C', fleet, 'runbook', 'list'], { env: fleetEnv });
  if (!runbookList.includes('agent-conductor/engineering-management@1.0.0')) {
    throw new Error('packed CLI did not discover the built-in runbook');
  }
  const builtInRunbook = join(
    prefix,
    'lib',
    'node_modules',
    'agent-conductor',
    'runbooks',
    'agent-conductor',
    'engineering-management',
  );
  if (!run(conductor, ['runbook', 'validate', builtInRunbook]).includes('Runbook OK.')) {
    throw new Error('packed CLI did not validate the built-in runbook');
  }
  const authoredRunbook = join(scratch, 'sample-runbook');
  run(conductor, ['runbook', 'init', authoredRunbook]);
  if (!run(conductor, ['runbook', 'validate', authoredRunbook]).includes('Runbook OK.')) {
    throw new Error('packed CLI did not validate an initialized external runbook');
  }
  run(conductor, ['-C', fleet, 'events', 'export', '--format', 'jsonl'], { env: fleetEnv });

  const shepherdFleet = join(scratch, 'shepherd-fleet');
  mkdirSync(shepherdFleet);
  run(shepherd, ['-C', shepherdFleet, 'init']);
  if (!existsSync(join(shepherdFleet, '.conductor', 'config', 'pr-shepherd.yaml'))) {
    throw new Error('pr-shepherd init did not create its profile');
  }

  const consumer = join(scratch, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), '{"name":"packed-consumer","private":true,"type":"module"}\n');
  run('npm', ['install', '--prefix', consumer, tarball]);
  writeFileSync(
    join(consumer, 'index.ts'),
    `import { Supervisor, type ChannelAdapter, type ConductorEventSubscriber, type RunbookManifest, type SessionRuntime, type TerminalBackend } from 'agent-conductor';\n` +
      `declare const channel: ChannelAdapter; declare const subscriber: ConductorEventSubscriber; declare const runbook: RunbookManifest; declare const runtime: SessionRuntime; declare const terminal: TerminalBackend; void runbook;\n` +
      `new Supervisor('.', { channels: [channel], eventSubscribers: [subscriber], runtimes: [runtime], terminalBackend: terminal });\n`,
  );
  run(process.execPath, [
    resolve('node_modules/typescript/bin/tsc'),
    '--noEmit',
    '--target',
    'ES2022',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--typeRoots',
    resolve('node_modules/@types'),
    join(consumer, 'index.ts'),
  ]);
  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const api = await import('agent-conductor'); if (typeof api.Supervisor !== 'function') process.exit(1);`,
    ],
    { cwd: consumer },
  );

  process.stdout.write(`Packed artifact verified: ${basename(tarball)} (${String(entries.length)} entries)\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
