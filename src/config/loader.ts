import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import type { ZodError } from 'zod';
import { log } from '../logger.js';
import { resolveConductorInstance, type ResolvedInstance } from './paths.js';
import { sessionConfigSchema, supervisorConfigSchema, type SessionConfig, type SupervisorConfig } from './schema.js';
import { configuredRunbookRegistry } from '../runbooks/registry.js';
import { PACKAGE_VERSION } from '../version.js';
import { resolveConfiguredIntegrations } from '../integrations/configured.js';

const PACKAGE_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');

export interface LoadedConfig {
  supervisor: SupervisorConfig;
  sessions: Map<string, SessionConfig>;
  baseDir: string;
}

type InstanceSource = string | ResolvedInstance;

function asResolvedInstance(source: InstanceSource, instance?: string): ResolvedInstance {
  return typeof source === 'string' ? resolveConductorInstance(source, instance) : source;
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

export function validateFederationExposure(
  supervisor: SupervisorConfig,
  sessions: ReadonlyMap<string, SessionConfig>,
  file: string,
  options: { sessionsDir?: string; tolerateUnparsed?: boolean } = {},
): void {
  const exposure = supervisor.federation?.expose;
  if (exposure === undefined) return;
  if (!['127.0.0.1', 'localhost'].includes(supervisor.mcp.host)) {
    throw new ConfigError(
      `Invalid federation transport: mcp.host must be 127.0.0.1 or localhost, got '${supervisor.mcp.host}'`,
      file,
    );
  }
  if (exposure.includes('*')) return;
  const unknown = exposure.filter((codename) => !sessions.has(codename));
  const unparsed =
    options.sessionsDir === undefined
      ? []
      : unknown.filter(
          (codename) =>
            existsSync(join(options.sessionsDir!, `${codename}.yaml`)) ||
            existsSync(join(options.sessionsDir!, `${codename}.yml`)),
        );
  if (unparsed.length > 0 && options.tolerateUnparsed !== true) {
    throw new ConfigError(
      `Invalid federation exposure: exposed session configuration failed to parse: ${unparsed.join(', ')}; fix the YAML or remove it from federation.expose`,
      file,
    );
  }
  // Explicit names are allowlist reservations, not a requirement that every
  // session already exist. This lets a dynamic fleet pre-authorize a future
  // spawn and keeps its supervisor configuration valid after teardown. A file
  // that exists but cannot be parsed remains an error above rather than being
  // mistaken for an intentionally absent reservation.
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

export function loadSupervisorConfig(
  source: InstanceSource,
  env: NodeJS.ProcessEnv = process.env,
  instance?: string,
): SupervisorConfig {
  const resolvedInstance = asResolvedInstance(source, instance);
  const { paths } = resolvedInstance;
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
  const derived = resolvedInstance.defaults;
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

export function sessionConfigDir(source: InstanceSource, instance?: string): string {
  return asResolvedInstance(source, instance).paths.sessionsDir;
}

/**
 * Load all session configs. `tolerant` skips (and logs) malformed files instead of
 * throwing — used by hot-reload so one bad YAML can't take the fleet down.
 */
export function loadSessionConfigs(
  source: InstanceSource,
  opts: { tolerant?: boolean; defaultRuntime?: SessionConfig['runtime'] } = {},
): Map<string, SessionConfig> {
  const resolvedInstance = asResolvedInstance(source);
  const { baseDir } = resolvedInstance;
  const dir = sessionConfigDir(resolvedInstance);
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

export function loadConfig(baseDir: string, opts: { tolerant?: boolean; instance?: string } = {}): LoadedConfig {
  const resolvedInstance = resolveConductorInstance(baseDir, opts.instance);
  const supervisor = loadSupervisorConfig(resolvedInstance);
  const sessions = loadSessionConfigs(resolvedInstance, { ...opts, defaultRuntime: supervisor.defaults.runtime });
  validateFederationExposure(supervisor, sessions, resolvedInstance.paths.supervisorFile, {
    sessionsDir: resolvedInstance.paths.sessionsDir,
    tolerateUnparsed: opts.tolerant === true,
  });
  return {
    supervisor,
    sessions,
    baseDir: resolvedInstance.baseDir,
  };
}

export interface ValidateConfigOptions {
  /** Default true. Doctor validates these separately so it can label file failures distinctly. */
  configuredIntegrations?: boolean;
  /** Optional named instance; undefined validates the historical default. */
  instance?: string;
}

/** Validate everything and return human-readable problems (for `conductor validate`). */
export function validateConfig(baseDir: string, options: ValidateConfigOptions = {}): string[] {
  const problems: string[] = [];
  let resolvedInstance: ResolvedInstance;
  try {
    resolvedInstance = resolveConductorInstance(baseDir, options.instance);
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
  let defaultRuntime: SessionConfig['runtime'] = 'claude-code';
  try {
    const supervisor = loadSupervisorConfig(resolvedInstance);
    defaultRuntime = supervisor.defaults.runtime;
    if (options.configuredIntegrations !== false) {
      try {
        resolveConfiguredIntegrations(baseDir, supervisor.integrations);
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
  let dir: string;
  try {
    dir = sessionConfigDir(resolvedInstance);
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
      const supervisor = loadSupervisorConfig(resolvedInstance);
      const sessions = loadSessionConfigs(resolvedInstance, { defaultRuntime });
      validateFederationExposure(supervisor, sessions, resolvedInstance.paths.supervisorFile, {
        sessionsDir: resolvedInstance.paths.sessionsDir,
      });
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (problems.length === 0) {
    try {
      const supervisor = loadSupervisorConfig(resolvedInstance);
      for (const diagnostic of configuredRunbookRegistry(
        baseDir,
        supervisor,
        PACKAGE_VERSION,
        join(PACKAGE_ROOT, 'runbooks'),
        resolvedInstance.paths.runbooksDir,
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
