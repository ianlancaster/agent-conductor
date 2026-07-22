import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { ConfigError } from './loader.js';
import { resolveFleetPaths } from './paths.js';

/**
 * Resolve the environment visible to one fleet without mutating process.env.
 * Values inherited from the parent process deliberately override fleet-local
 * `.conductor/.env` values so shell, CI, and service configuration remains authoritative.
 */
export function resolveFleetEnvironment(
  baseDir: string,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const file = resolveFleetPaths(baseDir).environmentFile;
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

  return { ...fileValues, ...inheritedEnv };
}
