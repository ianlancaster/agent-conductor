import { spawnSync } from 'node:child_process';
import { constants, existsSync, accessSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { loadConfig, loadSupervisorConfig, validateConfig } from '../config/loader.js';
import { resolveConductorInstance, resolveFleetDataDir } from '../config/paths.js';
import { assertShepherdProfileReady } from '../shepherd/config.js';
import { eventJournalDegradedPath } from '../events/journal.js';
import { resolveConfiguredIntegrations } from '../integrations/configured.js';
import { STORE_SCHEMA_VERSION } from '../store/schema-version.js';
import { readDatabaseSchemaVersion } from '../store/sqlite.js';

export type PreflightLevel = 'pass' | 'warn' | 'fail';

export interface PreflightResult {
  level: PreflightLevel;
  label: string;
  detail: string;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
}

export interface PreflightDependencies {
  nodeVersion: string;
  platform: NodeJS.Platform;
  executablePath: string;
  command(name: string, args?: string[]): CommandResult;
  writable(path: string): boolean;
  portState(host: string, port: number): Promise<'available' | 'healthy' | 'occupied'>;
}

function defaultCommand(name: string, args: string[] = []): CommandResult {
  const result = spawnSync(name, args, { encoding: 'utf8', timeout: 5_000 });
  return { ok: result.status === 0, stdout: (result.stdout ?? '').trim() };
}

function nearestExisting(path: string): string {
  let candidate = resolve(path);
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return candidate;
}

function defaultWritable(path: string): boolean {
  try {
    accessSync(nearestExisting(path), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function healthHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}

async function defaultPortState(host: string, port: number): Promise<'available' | 'healthy' | 'occupied'> {
  try {
    const response = await fetch(`http://${healthHost(host)}:${String(port)}/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (response.ok) return 'healthy';
  } catch {
    // Nothing healthy answered; distinguish a free port from another listener below.
  }

  return await new Promise((resolveState) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolveState('occupied'));
    server.listen(port, host, () => server.close(() => resolveState('available')));
  });
}

const DEFAULT_DEPS: PreflightDependencies = {
  nodeVersion: process.versions.node,
  platform: process.platform,
  executablePath: process.argv[1] ?? '',
  command: defaultCommand,
  writable: defaultWritable,
  portState: defaultPortState,
};

function result(level: PreflightLevel, label: string, detail: string): PreflightResult {
  return { level, label, detail };
}

export function supportedNode(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10));
  return (major === 22 && minor >= 13) || (major === 23 && minor >= 4) || major > 23;
}

export function stableConductorExecutable(executablePath: string): boolean {
  return executablePath.length > 0 && !executablePath.includes('/src/') && !executablePath.includes('/.pnpm/');
}

function tmuxUsable(version: string): boolean {
  const match = /tmux\s+(\d+)(?:\.(\d+))?/iu.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 3 || (major === 3 && minor >= 2);
}

/** Run reusable, non-secret fleet startup diagnostics. */
export async function runPreflight(
  baseDir: string,
  overrides: Partial<PreflightDependencies> = {},
  instance?: string,
): Promise<PreflightResult[]> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const results: PreflightResult[] = [];

  results.push(
    supportedNode(deps.nodeVersion)
      ? result('pass', 'Node.js', `${deps.nodeVersion} is supported`)
      : result('fail', 'Node.js', `${deps.nodeVersion} is unsupported; install Node 22.13+ (or 23.4+)`),
  );

  let resolvedInstance: ReturnType<typeof resolveConductorInstance>;
  try {
    resolvedInstance = resolveConductorInstance(baseDir, instance);
  } catch (error) {
    results.push(result('fail', 'Fleet config', error instanceof Error ? error.message : String(error)));
    return results;
  }

  // Classify executable-module filesystem failures separately from ordinary
  // YAML errors. Resolution/stat is deliberately non-executing.
  try {
    const supervisor = loadSupervisorConfig(resolvedInstance);
    try {
      resolveConfiguredIntegrations(baseDir, supervisor.integrations);
      if (supervisor.integrations.length > 0) {
        results.push(
          result(
            'pass',
            'Configured integrations',
            `${String(supervisor.integrations.length)} trusted local module(s) available`,
          ),
        );
      }
    } catch (error) {
      results.push(result('fail', 'Configured integrations', error instanceof Error ? error.message : String(error)));
    }
  } catch {
    // validateConfig below owns supervisor YAML/schema diagnostics.
  }

  const problems = validateConfig(baseDir, { configuredIntegrations: false, instance });
  if (problems.length > 0) {
    results.push(result('fail', 'Fleet config', problems.join('; ')));
  }

  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig(baseDir, { instance });
  } catch {
    // Schema/session errors already have a Fleet config diagnostic and prevent
    // reliable checks that depend on the loaded fleet.
    return results;
  }
  const paths = resolvedInstance.paths;
  if (problems.length === 0) {
    results.push(result('pass', 'Fleet config', `${loaded.sessions.size} session(s); ${paths.supervisorFile}`));
  }

  const dataDir = resolveFleetDataDir(baseDir, loaded.supervisor.paths.dataDir);
  for (const [label, path] of [
    ['Config directory', paths.configDir],
    ['Data directory', dataDir],
  ] as const) {
    results.push(
      deps.writable(path)
        ? result('pass', label, path)
        : result('fail', label, `${path} is not writable; correct its ownership or permissions`),
    );
  }

  const databasePath = resolve(dataDir, 'conductor.db');
  try {
    const databaseVersion = readDatabaseSchemaVersion(databasePath);
    results.push(
      databaseVersion === null
        ? result(
            'pass',
            'Database schema',
            `not created yet; start will initialize version ${String(STORE_SCHEMA_VERSION)}`,
          )
        : databaseVersion > STORE_SCHEMA_VERSION
          ? result(
              'fail',
              'Database schema',
              `version ${String(databaseVersion)} is newer than this Conductor's supported version ${String(STORE_SCHEMA_VERSION)}; run conductor update`,
            )
          : databaseVersion < STORE_SCHEMA_VERSION
            ? result(
                'warn',
                'Database schema',
                `version ${String(databaseVersion)} will migrate forward to ${String(STORE_SCHEMA_VERSION)} on start or update`,
              )
            : result('pass', 'Database schema', `version ${String(databaseVersion)} is current`),
    );
  } catch (error) {
    results.push(result('fail', 'Database schema', error instanceof Error ? error.message : String(error)));
  }

  if (!loaded.supervisor.events.journal.enabled) {
    results.push(result('pass', 'Event journal', 'disabled by fleet configuration'));
  } else if (existsSync(eventJournalDegradedPath(dataDir))) {
    const markerPath = eventJournalDegradedPath(dataDir);
    results.push(
      result(
        'warn',
        'Event journal',
        `degraded — exported event history is incomplete; inspect conductor.log, record the gap, then remove ${markerPath} to acknowledge it`,
      ),
    );
  } else {
    results.push(result('pass', 'Event journal', 'enabled; no recorded write failures'));
  }

  const selectedRuntimes = new Set([
    loaded.supervisor.defaults.runtime,
    ...[...loaded.sessions.values()].map((s) => s.runtime),
  ]);
  const runtimeBins = [
    { runtime: 'claude-code', binary: loaded.supervisor.runtimes.claudeCode.binary, args: ['--version'] },
    { runtime: 'codex', binary: loaded.supervisor.runtimes.codex.binary, args: ['--version'] },
    { runtime: 'spartan', binary: loaded.supervisor.runtimes.spartan.binary, args: ['admin', '--version'] },
  ] as const;
  for (const { runtime, binary, args } of runtimeBins) {
    const available = deps.command(binary, [...args]).ok;
    const selected = selectedRuntimes.has(runtime) || (runtime === 'codex' && selectedRuntimes.has('spartan'));
    const dependency = runtime === 'codex' && !selectedRuntimes.has('codex') && selectedRuntimes.has('spartan');
    results.push(
      available
        ? result('pass', `${runtime} runtime`, `${binary} is available`)
        : result(
            selected ? 'fail' : 'warn',
            `${runtime} runtime`,
            `${binary} is not on PATH${
              dependency
                ? '; install it because the spartan runtime wraps Codex'
                : selected
                  ? '; install it or select another runtime'
                  : ' (not currently selected)'
            }`,
          ),
    );
  }

  const backend = loaded.supervisor.terminal.backend;
  if (backend === 'tmux') {
    const tmux = deps.command('tmux', ['-V']);
    results.push(
      tmux.ok && tmuxUsable(tmux.stdout)
        ? result('pass', 'tmux backend', tmux.stdout)
        : result('fail', 'tmux backend', 'tmux 3.2+ is required; install or upgrade tmux'),
    );
  } else {
    const osascript = deps.command('osascript', ['-e', 'return "ok"']).ok;
    const iterm = deps.command('open', ['-Ra', 'iTerm']).ok || deps.command('open', ['-Ra', 'iTerm2']).ok;
    results.push(
      deps.platform === 'darwin' && osascript && iterm
        ? result('pass', 'iTerm backend', 'iTerm2 and AppleScript are available')
        : result(
            'fail',
            'iTerm backend',
            'iTerm2 on macOS with osascript is required; or select terminal.backend: tmux',
          ),
    );
  }

  for (const command of ['git', 'curl']) {
    results.push(
      deps.command(command, ['--version']).ok
        ? result('pass', command, `${command} is available`)
        : result('warn', command, `${command} is unavailable; install it before using Git-backed workflows`),
    );
  }

  if (loaded.supervisor.shepherd.enabled) {
    const gh = deps.command('gh', ['auth', 'status']);
    results.push(
      gh.ok
        ? result('pass', 'GitHub CLI', 'gh authentication is active')
        : result('fail', 'GitHub CLI', 'PR Shepherd is enabled; install gh and run gh auth login'),
    );
    try {
      assertShepherdProfileReady(loaded.supervisor.shepherd.configPath);
      results.push(result('pass', 'PR Shepherd profile', loaded.supervisor.shepherd.configPath));
    } catch (error) {
      results.push(result('fail', 'PR Shepherd profile', error instanceof Error ? error.message : String(error)));
    }
  } else {
    results.push(result('pass', 'PR Shepherd', 'disabled (optional)'));
  }

  const port = loaded.supervisor.mcp.port;
  const portState = await deps.portState(loaded.supervisor.mcp.host, port);
  results.push(
    portState === 'available'
      ? result('pass', 'Fleet port', `${loaded.supervisor.mcp.host}:${String(port)} is available`)
      : portState === 'healthy'
        ? result('pass', 'Fleet port', `a healthy Conductor is already listening on ${String(port)}`)
        : result('fail', 'Fleet port', `${String(port)} is occupied by another process; change mcp.port or stop it`),
  );

  const stableExecutable = stableConductorExecutable(deps.executablePath);
  results.push(
    stableExecutable
      ? result('pass', 'Daemon executable', deps.executablePath)
      : result('warn', 'Daemon executable', 'use a globally installed conductor before `conductor daemon install`'),
  );

  return results;
}

export function formatPreflight(results: readonly PreflightResult[]): string {
  const marker: Record<PreflightLevel, string> = { pass: '✓', warn: '!', fail: '✗' };
  return results.map((item) => `${marker[item.level]} ${item.label}: ${item.detail}`).join('\n');
}

export function preflightFailures(results: readonly PreflightResult[]): PreflightResult[] {
  return results.filter((item) => item.level === 'fail');
}
