import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const CONDUCTOR_DIRNAME = '.conductor';

export type FleetLayout = 'conductor-directory' | 'legacy-root';

export interface FleetPaths {
  layout: FleetLayout;
  rootDir: string;
  configDir: string;
  sessionsDir: string;
  runbooksDir: string;
  supervisorFile: string;
  shepherdConfigFile: string;
  dataDirDefault: string;
  environmentFile: string;
  environmentTemplate: string;
}

function hasConfig(configDir: string): boolean {
  if (existsSync(join(configDir, 'supervisor.yaml'))) return true;
  const sessionsDir = join(configDir, 'sessions');
  if (!existsSync(sessionsDir)) return false;
  return readdirSync(sessionsDir).some((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'));
}

/**
 * Resolve one fleet's on-disk layout.
 *
 * New fleets keep every Conductor-owned artifact under `.conductor/`. Fleets
 * created by releases before this layout remain readable in place. If both
 * layouts contain configuration, refusing to guess prevents a conductor from
 * silently supervising the wrong roster or opening the wrong database.
 */
export function resolveFleetPaths(baseDir: string): FleetPaths {
  const conductorRoot = join(baseDir, CONDUCTOR_DIRNAME);
  const conductorConfig = join(conductorRoot, 'config');
  const legacyConfig = join(baseDir, 'config');
  const hasConductorConfig = hasConfig(conductorConfig);
  const hasLegacyConfig = hasConfig(legacyConfig);

  if (hasConductorConfig && hasLegacyConfig) {
    throw new Error(
      `Ambiguous Conductor fleet layout: both ${conductorConfig} and ${legacyConfig} contain configuration. ` +
        `Keep only one layout; .conductor/config is preferred.`,
    );
  }

  const layout: FleetLayout = hasLegacyConfig ? 'legacy-root' : 'conductor-directory';
  const rootDir = layout === 'legacy-root' ? baseDir : conductorRoot;
  const configDir = join(rootDir, 'config');

  return {
    layout,
    rootDir,
    configDir,
    sessionsDir: join(configDir, 'sessions'),
    runbooksDir: join(rootDir, 'runbooks'),
    supervisorFile: join(configDir, 'supervisor.yaml'),
    shepherdConfigFile: join(configDir, 'pr-shepherd.yaml'),
    dataDirDefault: layout === 'legacy-root' ? './data' : './.conductor/data',
    environmentFile: join(rootDir, '.env'),
    environmentTemplate: join(rootDir, 'env.template'),
  };
}

/** Resolve an explicit or layout-derived data path against the fleet root. */
export function resolveFleetDataDir(baseDir: string, configuredPath: string): string {
  return resolve(baseDir, configuredPath);
}
