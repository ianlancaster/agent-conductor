import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { ConfigError } from './loader.js';
import { resolveConductorInstance, type ResolvedInstance } from './paths.js';

/**
 * Resolve the environment visible to one fleet without mutating process.env.
 * Fleet-local `.conductor/.env` values override inherited values. This makes
 * editing the fleet file plus restarting deterministic even when a long-lived
 * shell, agent, CI worker, or service manager still carries stale credentials.
 * Inherited values remain the fallback for keys omitted from the fleet file.
 */
export function resolveFleetEnvironment(
  source: string | ResolvedInstance,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
  instance?: string,
): NodeJS.ProcessEnv {
  const resolvedInstance = typeof source === 'string' ? resolveConductorInstance(source, instance) : source;
  const file = resolvedInstance.paths.environmentFile;
  let fileValues: NodeJS.ProcessEnv = {};

  if (existsSync(file)) {
    try {
      fileValues = parseEnv(readFileSync(file, 'utf8'));
    } catch {
      // parseEnv errors may echo the offending line, which can contain a
      // credential. Keep the error actionable without reflecting file data.
      throw new ConfigError(`Could not read or parse fleet environment file ${file}`, file);
    }
  }

  return { ...inheritedEnv, ...fileValues };
}
