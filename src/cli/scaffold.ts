import { constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { loadSupervisorConfig } from '../config/loader.js';
import { resolveConductorInstance, type ResolvedInstance } from '../config/paths.js';

const PACKAGE_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const CONDUCTOR_GITIGNORE = `.env
data/
`;

/** Fleet-root marker that lets launcher-neutral tools find the fleet directory and its id. */
export const FLEET_MARKER_FILE = 'fleet.toml';

/**
 * The fleet id recorded in `fleet.toml`: the federation name when configured,
 * otherwise the fleet directory name normalized to the same pattern.
 */
export function fleetMarkerId(baseDir: string, federationName?: string): string {
  if (federationName !== undefined) return federationName;
  const normalized = basename(baseDir)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return normalized.length > 0 ? normalized : 'fleet';
}

function createFile(file: string, contents: string, mode?: number): boolean {
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(file, contents, { flag: 'wx', ...(mode === undefined ? {} : { mode }) });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

function asResolvedInstance(source: string | ResolvedInstance, instance?: string): ResolvedInstance {
  return typeof source === 'string' ? resolveConductorInstance(source, instance) : source;
}

export function ensureShepherdScaffold(source: string | ResolvedInstance, instance?: string): string | undefined {
  const paths = asResolvedInstance(source, instance).paths;
  const template = readFileSync(join(PACKAGE_ROOT, 'examples', 'pr-shepherd.scaffold.yaml'), 'utf8');
  return createFile(paths.shepherdConfigFile, template) ? paths.shepherdConfigFile : undefined;
}

/** Render every effective default, including values derived for this fleet. */
export function renderSupervisorConfig(
  source: string | ResolvedInstance,
  env: NodeJS.ProcessEnv = process.env,
  instance?: string,
): string {
  const resolvedInstance = asResolvedInstance(source, instance);
  const config = loadSupervisorConfig(resolvedInstance, env);
  const { paths } = resolvedInstance;
  const rendered = {
    ...config,
    shepherd: {
      ...config.shepherd,
      configPath: config.shepherd.configPath === paths.shepherdConfigFile ? null : config.shepherd.configPath,
    },
  };
  return (
    '# agent-conductor supervisor config. This is a complete, working configuration.\n' +
    '# Edit values here; examples/supervisor.yaml documents every setting.\n\n' +
    yaml.dump(rendered, { noRefs: true, lineWidth: 120, sortKeys: false })
  );
}

/**
 * Ensure the non-destructive fleet scaffold required by `conductor start`.
 * Existing files are never rewritten. Legacy root-level fleets stay in place;
 * new fleets use `.conductor/`. Returns only paths created by this call so
 * routine restarts remain quiet.
 */
export function ensureFleetScaffold(baseDir: string, instance?: string): string[] {
  const resolvedInstance = resolveConductorInstance(baseDir, instance);
  const { paths } = resolvedInstance;
  const created: string[] = [];

  if (!existsSync(paths.sessionsDir)) {
    mkdirSync(paths.sessionsDir, { recursive: true });
    created.push(paths.sessionsDir);
  }

  if (createFile(paths.supervisorFile, renderSupervisorConfig(resolvedInstance))) created.push(paths.supervisorFile);
  // Written once when absent and never rewritten, so a fleet owner can edit the id freely.
  const fleetMarker = join(resolvedInstance.baseDir, FLEET_MARKER_FILE);
  if (!existsSync(fleetMarker)) {
    const id = fleetMarkerId(resolvedInstance.baseDir, loadSupervisorConfig(resolvedInstance).federation?.name);
    if (
      createFile(
        fleetMarker,
        `# Fleet marker written by Agent Conductor; tools find the fleet root by this file.\nid = "${id}"\n`,
      )
    ) {
      created.push(fleetMarker);
    }
  }
  const shepherd = ensureShepherdScaffold(resolvedInstance);
  if (shepherd !== undefined) created.push(shepherd);

  const environmentTemplate = readFileSync(join(PACKAGE_ROOT, 'env.template'), 'utf8');
  if (createFile(paths.environmentTemplate, environmentTemplate)) created.push(paths.environmentTemplate);
  // The live file is gitignored and owner-only. Empty values are inert until
  // the matching channel is enabled in supervisor.yaml.
  if (createFile(paths.environmentFile, environmentTemplate, constants.S_IRUSR | constants.S_IWUSR)) {
    created.push(paths.environmentFile);
  }

  if (paths.layout === 'conductor-directory') {
    const gitignore = join(paths.rootDir, '.gitignore');
    if (createFile(gitignore, CONDUCTOR_GITIGNORE)) created.push(gitignore);
  }

  return created;
}
