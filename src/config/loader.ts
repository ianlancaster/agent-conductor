import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import type { ZodError } from 'zod';
import { log } from '../logger.js';
import { deriveInstanceDefaults } from './instance.js';
import { resolveFleetPaths } from './paths.js';
import { sessionConfigSchema, supervisorConfigSchema, type SessionConfig, type SupervisorConfig } from './schema.js';
import { configuredRunbookRegistry } from '../runbooks/registry.js';
import { PACKAGE_VERSION } from '../version.js';

const PACKAGE_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');

export interface LoadedConfig {
  supervisor: SupervisorConfig;
  sessions: Map<string, SessionConfig>;
  baseDir: string;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly file: string,
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

function formatZodError(err: ZodError): string {
  return err.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/**
 * Default terminal backend when the config doesn't name one: stay in the
 * environment the conductor was launched from. Inside tmux ($TMUX set) →
 * tmux; otherwise iTerm on macOS, tmux elsewhere. Daemons (launchd/systemd)
 * have no $TMUX, so daemon fleets should set `terminal.backend` explicitly.
 */
export function detectBackend(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): 'iterm' | 'tmux' {
  if (env.TMUX !== undefined && env.TMUX !== '') return 'tmux';
  return platform === 'darwin' ? 'iterm' : 'tmux';
}

export function loadSupervisorConfig(baseDir: string, env: NodeJS.ProcessEnv = process.env): SupervisorConfig {
  const paths = resolveFleetPaths(baseDir);
  const file = paths.supervisorFile;
  let raw: unknown = {};
  if (existsSync(file)) {
    raw = yaml.load(readFileSync(file, 'utf8')) ?? {};
  }
  const parsed = supervisorConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`Invalid supervisor config: ${formatZodError(parsed.error)}`, file);
  }
  // Instance-scoped values default per fleet dir so multiple conductors never
  // collide on a port or tmux session. Explicit config always wins. Derivation
  // is deterministic — sessions' MCP configs bake the port into URLs, so it must
  // be stable across restarts.
  const config = parsed.data;
  const rawPaths =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'paths' in raw ? raw.paths : undefined;
  const hasExplicitDataDir =
    typeof rawPaths === 'object' && rawPaths !== null && !Array.isArray(rawPaths) && 'dataDir' in rawPaths;
  if (!hasExplicitDataDir) config.paths.dataDir = paths.dataDirDefault;
  const derived = deriveInstanceDefaults(baseDir);
  config.mcp.port ??= derived.port;
  config.terminal.backend ??= detectBackend(env);
  config.terminal.windowName ??= derived.windowName;
  config.terminal.tmux.sessionName ??= derived.tmuxSessionName;
  config.shepherd.configPath = resolve(paths.configDir, config.shepherd.configPath ?? paths.shepherdConfigFile);
  return config as SupervisorConfig;
}

export function parseSessionConfig(
  raw: unknown,
  file: string,
  baseDir: string,
  defaultRuntime: SessionConfig['runtime'] = 'claude-code',
): SessionConfig {
  const source =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) && !('runtime' in raw)
      ? { ...raw, runtime: defaultRuntime }
      : raw;
  const parsed = sessionConfigSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(`Invalid session config: ${formatZodError(parsed.error)}`, file);
  }
  const session = parsed.data;
  if (!isAbsolute(session.repo)) {
    session.repo = resolve(baseDir, session.repo);
  }
  if (session.systemPromptFile !== undefined && !isAbsolute(session.systemPromptFile)) {
    session.systemPromptFile = resolve(baseDir, session.systemPromptFile);
  }
  return session;
}

export function sessionConfigDir(baseDir: string): string {
  return resolveFleetPaths(baseDir).sessionsDir;
}

/**
 * Load all session configs. `tolerant` skips (and logs) malformed files instead of
 * throwing — used by hot-reload so one bad YAML can't take the fleet down.
 */
export function loadSessionConfigs(
  baseDir: string,
  opts: { tolerant?: boolean; defaultRuntime?: SessionConfig['runtime'] } = {},
): Map<string, SessionConfig> {
  const dir = sessionConfigDir(baseDir);
  const sessions = new Map<string, SessionConfig>();
  if (!existsSync(dir)) return sessions;
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
    const file = join(dir, entry);
    try {
      const raw = yaml.load(readFileSync(file, 'utf8'));
      const session = parseSessionConfig(raw, file, baseDir, opts.defaultRuntime);
      if (sessions.has(session.codename)) {
        throw new ConfigError(`Duplicate codename '${session.codename}'`, file);
      }
      sessions.set(session.codename, session);
    } catch (err) {
      if (opts.tolerant) {
        log().warn('config', `Skipping ${file}: ${err instanceof Error ? err.message : String(err)}`);
      } else {
        throw err;
      }
    }
  }
  return sessions;
}

export function loadConfig(baseDir: string, opts: { tolerant?: boolean } = {}): LoadedConfig {
  const supervisor = loadSupervisorConfig(baseDir);
  return {
    supervisor,
    sessions: loadSessionConfigs(baseDir, { ...opts, defaultRuntime: supervisor.defaults.runtime }),
    baseDir,
  };
}

/** Validate everything and return human-readable problems (for `conductor validate`). */
export function validateConfig(baseDir: string): string[] {
  const problems: string[] = [];
  let defaultRuntime: SessionConfig['runtime'] = 'claude-code';
  try {
    defaultRuntime = loadSupervisorConfig(baseDir).defaults.runtime;
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
  let dir: string;
  try {
    dir = sessionConfigDir(baseDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!problems.includes(message)) problems.push(message);
    return problems;
  }
  if (existsSync(dir)) {
    const seen = new Set<string>();
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
      const file = join(dir, entry);
      try {
        const raw = yaml.load(readFileSync(file, 'utf8'));
        const session = parseSessionConfig(raw, file, baseDir, defaultRuntime);
        if (seen.has(session.codename)) problems.push(`${file}: duplicate codename '${session.codename}'`);
        seen.add(session.codename);
      } catch (err) {
        problems.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (problems.length === 0) {
    try {
      const supervisor = loadSupervisorConfig(baseDir);
      for (const diagnostic of configuredRunbookRegistry(
        baseDir,
        supervisor,
        PACKAGE_VERSION,
        join(PACKAGE_ROOT, 'runbooks'),
      ).snapshot().diagnostics) {
        problems.push(`${diagnostic.path}: ${diagnostic.message}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!problems.includes(message)) problems.push(message);
    }
  }
  return problems;
}
