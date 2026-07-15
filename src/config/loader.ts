import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import type { ZodError } from 'zod';
import { log } from '../logger.js';
import { agentConfigSchema, supervisorConfigSchema, type AgentConfig, type SupervisorConfig } from './schema.js';

export interface LoadedConfig {
  supervisor: SupervisorConfig;
  agents: Map<string, AgentConfig>;
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
  return parsed.data;
}

export function parseAgentConfig(raw: unknown, file: string, baseDir: string): AgentConfig {
  const parsed = agentConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`Invalid agent config: ${formatZodError(parsed.error)}`, file);
  }
  const agent = parsed.data;
  if (!isAbsolute(agent.repo)) {
    agent.repo = resolve(baseDir, agent.repo);
  }
  if (agent.systemPromptFile !== undefined && !isAbsolute(agent.systemPromptFile)) {
    agent.systemPromptFile = resolve(baseDir, agent.systemPromptFile);
  }
  return agent;
}

export function agentConfigDir(baseDir: string): string {
  return join(baseDir, 'config', 'agents');
}

/**
 * Load all agent configs. `tolerant` skips (and logs) malformed files instead of
 * throwing — used by hot-reload so one bad YAML can't take the fleet down.
 */
export function loadAgentConfigs(baseDir: string, opts: { tolerant?: boolean } = {}): Map<string, AgentConfig> {
  const dir = agentConfigDir(baseDir);
  const agents = new Map<string, AgentConfig>();
  if (!existsSync(dir)) return agents;
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
    const file = join(dir, entry);
    try {
      const raw = yaml.load(readFileSync(file, 'utf8'));
      const agent = parseAgentConfig(raw, file, baseDir);
      if (agents.has(agent.codename)) {
        throw new ConfigError(`Duplicate codename '${agent.codename}'`, file);
      }
      agents.set(agent.codename, agent);
    } catch (err) {
      if (opts.tolerant) {
        log().warn('config', `Skipping ${file}: ${err instanceof Error ? err.message : String(err)}`);
      } else {
        throw err;
      }
    }
  }
  return agents;
}

export function loadConfig(baseDir: string, opts: { tolerant?: boolean } = {}): LoadedConfig {
  return {
    supervisor: loadSupervisorConfig(baseDir),
    agents: loadAgentConfigs(baseDir, opts),
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
  const dir = agentConfigDir(baseDir);
  if (existsSync(dir)) {
    const seen = new Set<string>();
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
      const file = join(dir, entry);
      try {
        const raw = yaml.load(readFileSync(file, 'utf8'));
        const agent = parseAgentConfig(raw, file, baseDir);
        if (seen.has(agent.codename)) problems.push(`${file}: duplicate codename '${agent.codename}'`);
        seen.add(agent.codename);
      } catch (err) {
        problems.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return problems;
}
