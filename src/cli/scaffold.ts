import { constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { loadSupervisorConfig } from '../config/loader.js';
import { resolveFleetPaths } from '../config/paths.js';

const PACKAGE_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const CONDUCTOR_GITIGNORE = `.env
data/
`;

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

export function ensureShepherdScaffold(baseDir: string): string | undefined {
  const paths = resolveFleetPaths(baseDir);
  const template = readFileSync(join(PACKAGE_ROOT, 'examples', 'pr-shepherd.scaffold.yaml'), 'utf8');
  return createFile(paths.shepherdConfigFile, template) ? paths.shepherdConfigFile : undefined;
}

/** Render every effective default, including values derived for this fleet. */
export function renderSupervisorConfig(baseDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const config = loadSupervisorConfig(baseDir, env);
  const paths = resolveFleetPaths(baseDir);
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
export function ensureFleetScaffold(baseDir: string): string[] {
  const paths = resolveFleetPaths(baseDir);
  const created: string[] = [];

  if (!existsSync(paths.sessionsDir)) {
    mkdirSync(paths.sessionsDir, { recursive: true });
    created.push(paths.sessionsDir);
  }

  if (createFile(paths.supervisorFile, renderSupervisorConfig(baseDir))) created.push(paths.supervisorFile);
  const shepherd = ensureShepherdScaffold(baseDir);
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
