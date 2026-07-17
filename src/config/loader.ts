import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import type { ZodError } from 'zod';
import { log } from '../logger.js';
import { deriveInstanceDefaults } from './instance.js';
import { sessionConfigSchema, supervisorConfigSchema, type SessionConfig, type SupervisorConfig } from './schema.js';

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

export function loadSupervisorConfig(baseDir: string): SupervisorConfig {
  const file = join(baseDir, 'config', 'supervisor.yaml');
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
  const derived = deriveInstanceDefaults(baseDir);
  config.mcp.port ??= derived.port;
  config.terminal.windowName ??= derived.windowName;
  config.terminal.tmux.sessionName ??= derived.tmuxSessionName;
  return config as SupervisorConfig;
}

export function parseSessionConfig(raw: unknown, file: string, baseDir: string): SessionConfig {
  const parsed = sessionConfigSchema.safeParse(raw);
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
  return join(baseDir, 'config', 'sessions');
}

/**
 * Load all session configs. `tolerant` skips (and logs) malformed files instead of
 * throwing — used by hot-reload so one bad YAML can't take the fleet down.
 */
export function loadSessionConfigs(baseDir: string, opts: { tolerant?: boolean } = {}): Map<string, SessionConfig> {
  const dir = sessionConfigDir(baseDir);
  const sessions = new Map<string, SessionConfig>();
  if (!existsSync(dir)) return sessions;
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
    const file = join(dir, entry);
    try {
      const raw = yaml.load(readFileSync(file, 'utf8'));
      const session = parseSessionConfig(raw, file, baseDir);
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
  return {
    supervisor: loadSupervisorConfig(baseDir),
    sessions: loadSessionConfigs(baseDir, opts),
    baseDir,
  };
}

/** Validate everything and return human-readable problems (for `conductor validate`). */
export function validateConfig(baseDir: string): string[] {
  const problems: string[] = [];
  try {
    loadSupervisorConfig(baseDir);
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
  }
  const dir = sessionConfigDir(baseDir);
  if (existsSync(dir)) {
    const seen = new Set<string>();
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
      const file = join(dir, entry);
      try {
        const raw = yaml.load(readFileSync(file, 'utf8'));
        const session = parseSessionConfig(raw, file, baseDir);
        if (seen.has(session.codename)) problems.push(`${file}: duplicate codename '${session.codename}'`);
        seen.add(session.codename);
      } catch (err) {
        problems.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return problems;
}
