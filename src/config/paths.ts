import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deriveFleetDefaults, fleetSlug, type FleetDefaults } from './derived-defaults.js';

export const CONDUCTOR_DIRNAME = '.conductor';
export const INSTANCE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

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

export interface ResolvedInstance {
  /** Shared fleet/workspace directory. Session paths continue to resolve here. */
  baseDir: string;
  /** Undefined selects the historical default layout and identity. */
  name?: string;
  paths: FleetPaths;
  /** Mechanical instance identity used for pane ownership and event envelopes. */
  fleetId: string;
  defaults: FleetDefaults;
}

export function validateInstanceName(instance: string): string {
  if (instance === 'default') {
    throw new Error("Instance name 'default' is reserved; omit --instance to select the default instance.");
  }
  if (!INSTANCE_NAME_PATTERN.test(instance)) {
    throw new Error('Instance name must match ^[a-z0-9][a-z0-9-]{0,63}$.');
  }
  return instance;
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
export function resolveFleetPaths(baseDir: string, instance?: string): FleetPaths {
  const resolvedBaseDir = resolve(baseDir);
  const conductorRoot = join(resolvedBaseDir, CONDUCTOR_DIRNAME);
  const conductorConfig = join(conductorRoot, 'config');
  const legacyConfig = join(resolvedBaseDir, 'config');
  const hasConductorConfig = hasConfig(conductorConfig);
  const hasLegacyConfig = hasConfig(legacyConfig);

  if (hasConductorConfig && hasLegacyConfig) {
    throw new Error(
      `Ambiguous Conductor fleet layout: both ${conductorConfig} and ${legacyConfig} contain configuration. ` +
        `Keep only one layout; .conductor/config is preferred.`,
    );
  }

  if (instance !== undefined) {
    const name = validateInstanceName(instance);
    if (hasLegacyConfig) {
      throw new Error(
        `Named instances require the .conductor layout; ${legacyConfig} uses the legacy root layout. ` +
          `Move fleet configuration under ${conductorConfig} before using --instance.`,
      );
    }
    const rootDir = join(conductorRoot, 'instances', name);
    const configDir = join(rootDir, 'config');
    return {
      layout: 'conductor-directory',
      rootDir,
      configDir,
      sessionsDir: join(configDir, 'sessions'),
      runbooksDir: join(rootDir, 'runbooks'),
      supervisorFile: join(configDir, 'supervisor.yaml'),
      shepherdConfigFile: join(configDir, 'pr-shepherd.yaml'),
      dataDirDefault: `./${CONDUCTOR_DIRNAME}/instances/${name}/data`,
      environmentFile: join(rootDir, '.env'),
      environmentTemplate: join(rootDir, 'env.template'),
    };
  }

  const layout: FleetLayout = hasLegacyConfig ? 'legacy-root' : 'conductor-directory';
  const rootDir = layout === 'legacy-root' ? resolvedBaseDir : conductorRoot;
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

export function resolveConductorInstance(baseDir: string, instance?: string): ResolvedInstance {
  const resolvedBaseDir = resolve(baseDir);
  const name = instance === undefined ? undefined : validateInstanceName(instance);
  return {
    baseDir: resolvedBaseDir,
    ...(name === undefined ? {} : { name }),
    paths: resolveFleetPaths(resolvedBaseDir, name),
    fleetId: fleetSlug(resolvedBaseDir, name),
    defaults: deriveFleetDefaults(resolvedBaseDir, name),
  };
}

/** Resolve an explicit or layout-derived data path against the fleet root. */
export function resolveFleetDataDir(baseDir: string, configuredPath: string): string {
  return resolve(baseDir, configuredPath);
}
