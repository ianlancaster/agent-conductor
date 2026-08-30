#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const mode = process.argv[2];
if (mode !== 'default' && mode !== 'zero') {
  process.stderr.write('usage: node test/manual/continuity-provider-probe.mjs <default|zero>\n');
  process.exit(2);
}

const binary = process.env.CONTINUITY_CODEX_BINARY ?? 'codex';
const model = process.env.CONTINUITY_CODEX_MODEL ?? 'gpt-5.6-luna';
const root = await mkdtemp(join(tmpdir(), `conductor-continuity-${mode}-`));
const repo = join(root, 'repo');
const home = join(root, 'codex-home');
const sessionName = `continuity-${mode}-${randomUUID().slice(0, 8)}`;
await mkdir(repo, { recursive: true });
await mkdir(home, { recursive: true });

const sharedHome = process.env.CODEX_HOME ?? join(process.env.HOME ?? '', '.codex');
await symlink(join(sharedHome, 'auth.json'), join(home, 'auth.json'));
try {
  await copyFile(join(sharedHome, 'config.toml'), join(home, 'config.toml'));
} catch {
  await writeFile(join(home, 'config.toml'), '');
}
const configPath = join(home, 'config.toml');
const configText = await readFile(configPath, 'utf8');
const trustedRepo = repo.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
await writeFile(configPath, `${configText}\n[projects."${trustedRepo}"]\ntrust_level = "trusted"\n`);
await writeFile(
  join(home, 'AGENTS.override.md'),
  '# Disposable continuity provider probe\n\nFollow the user request and do not inspect the filesystem.\n',
);

const payloadClass = process.env.CONTINUITY_PAYLOAD_CLASS ?? 'controls';
const prefix = `CONTINUITY_${mode.toUpperCase()}_BEGIN|`;
const suffix = `|CONTINUITY_${mode.toUpperCase()}_END`;
const bodyBytes = 5_120 - Buffer.byteLength(prefix + suffix, 'utf8');
let denseBody;
if (payloadClass === 'controls') {
  denseBody = Array.from({ length: bodyBytes }, (_, index) => String.fromCharCode((index % 31) + 1)).join('');
} else if (payloadClass === 'base64url') {
  denseBody = '';
  for (let index = 0; denseBody.length < bodyBytes; index += 1) {
    denseBody += createHash('sha256').update(`continuity-provider-probe-${index}`).digest('base64url');
  }
} else {
  throw new Error(`unknown CONTINUITY_PAYLOAD_CLASS ${payloadClass}`);
}
const payload = prefix + denseBody.slice(0, bodyBytes) + suffix;
if (Buffer.byteLength(payload, 'utf8') !== 5_120) throw new Error('probe payload is not exactly 5,120 bytes');

const hookOutput = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: payload,
  },
});
const hookPath = join(home, `compact-${mode}.mjs`);
await writeFile(hookPath, `process.stdout.write(${JSON.stringify(hookOutput)});\n`, { mode: 0o700 });
const handler = {
  type: 'command',
  command: `${JSON.stringify(process.execPath)} ${JSON.stringify(hookPath)}`,
  timeout: 5,
  ...(mode === 'zero' ? { additionalContextLimit: 0 } : {}),
};
await writeFile(
  join(home, 'hooks.json'),
  `${JSON.stringify(
    {
      description: 'Disposable Agent Conductor continuity provider probe.',
      hooks: { SessionStart: [{ matcher: '^compact$', hooks: [handler] }] },
    },
    null,
    2,
  )}\n`,
);

const git = spawnSync('git', ['init', '--quiet', repo], { encoding: 'utf8' });
if (git.status !== 0) throw new Error(git.stderr || 'git init failed');

const tmuxCommand = [
  `export CODEX_HOME=${shellQuote(home)}`,
  `${shellQuote(binary)} --no-alt-screen --dangerously-bypass-hook-trust --dangerously-bypass-approvals-and-sandbox -m ${shellQuote(model)} -C ${shellQuote(repo)} -- ${shellQuote('Reply with READY only.')}`,
].join(' && ');
const tmux = spawnSync('tmux', ['new-session', '-d', '-x', '160', '-y', '48', '-s', sessionName, tmuxCommand], {
  encoding: 'utf8',
});
if (tmux.status !== 0) throw new Error(tmux.stderr || 'tmux launch failed');

try {
  await waitForPane(sessionName, /• READY/u, 180_000);
  await sendKeys(sessionName, '/compact');
  await waitForRollout(home, '"type":"compacted"', 180_000);
  await sendKeys(sessionName, 'Reply with DONE only.');
  await waitForRollout(home, prefix, 180_000);
  await waitForPane(sessionName, /• DONE/u, 180_000);
} finally {
  spawnSync('tmux', ['kill-session', '-t', sessionName]);
}

const rolloutPath = await newestRollout(home);
const records = (await readFile(rolloutPath, 'utf8'))
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));
const strings = records.flatMap((record) => collectStrings(record));
const exact = strings.filter((value) => value === payload).length;
const hasPrefix = strings.some((value) => value.includes(prefix));
const hasSuffix = strings.some((value) => value.includes(suffix));
const spillReference = strings.some((value) => value.includes('/hook_outputs/') || value.includes('hook_outputs'));
process.stdout.write(
  JSON.stringify(
    {
      mode,
      runtimeVersion: commandOutput(binary, ['--version']),
      model,
      payloadClass,
      payloadBytes: Buffer.byteLength(payload, 'utf8'),
      payloadCharacters: payload.length,
      exactDeveloperCopies: exact,
      prefixObserved: hasPrefix,
      suffixObserved: hasSuffix,
      spillReferenceObserved: spillReference,
      result: exact === 1 ? 'exact' : spillReference || (hasPrefix && hasSuffix) ? 'not-exact' : 'missing',
    },
    null,
    2,
  ) + '\n',
);
await rm(root, { recursive: true, force: true });

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandOutput(command, args) {
  return spawnSync(command, args, { encoding: 'utf8' }).stdout.trim();
}

async function sendKeys(target, value) {
  const result = spawnSync('tmux', ['send-keys', '-t', target, '-l', value], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `tmux send failed for ${value}`);
  await delay(350);
  spawnSync('tmux', ['send-keys', '-t', target, 'Enter']);
}

async function waitForPane(target, pattern, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const capture = spawnSync('tmux', ['capture-pane', '-p', '-t', target, '-S', '-200'], { encoding: 'utf8' });
    if (capture.status === 0 && pattern.test(capture.stdout)) return;
    await delay(500);
  }
  throw new Error(`timed out waiting for ${String(pattern)}`);
}

async function waitForRollout(codexHome, needle, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const path = await newestRollout(codexHome);
      if ((await readFile(path, 'utf8')).includes(needle)) return;
    } catch {
      // The rollout directory is created after the first model request.
    }
    await delay(500);
  }
  throw new Error(`timed out waiting for rollout marker ${needle}`);
}

async function newestRollout(codexHome) {
  const sessions = join(codexHome, 'sessions');
  const entries = await readdir(sessions, { recursive: true });
  const rollouts = entries.filter((entry) => basename(entry).startsWith('rollout-') && entry.endsWith('.jsonl')).sort();
  const newest = rollouts.at(-1);
  if (newest === undefined) throw new Error('no rollout found');
  return join(sessions, newest);
}

function collectStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item));
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap((item) => collectStrings(item));
  return [];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
