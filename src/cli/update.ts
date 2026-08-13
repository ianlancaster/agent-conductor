import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SCHEMA_VERSION_PATH = 'src/store/schema-version.ts';

interface ProcessResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface UpdateDependencies {
  run(command: string, args: readonly string[], cwd: string, visible?: boolean): Promise<ProcessResult>;
  exists(path: string): boolean;
}

export interface SourceUpdateOptions {
  packageRoot: string;
  fleetDir?: string;
  instance?: string;
  requiredSchemaVersion?: number;
  automatic?: boolean;
  fleetRunning?: () => Promise<boolean>;
  log?: (line: string) => void;
}

export interface SourceUpdateResult {
  branch: string;
  commit: string;
  schemaVersion: number;
  fastForwarded: boolean;
  migratedFleet: boolean;
}

function defaultRun(command: string, args: readonly string[], cwd: string, visible = false): Promise<ProcessResult> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      stdio: visible ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    if (!visible) {
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
    }
    child.once('error', reject);
    child.once('close', (status) => {
      resolveProcess({ status: status ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

const DEFAULT_DEPS: UpdateDependencies = { run: defaultRun, exists: existsSync };

function commandText(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ');
}

async function requireSuccess(
  deps: UpdateDependencies,
  command: string,
  args: readonly string[],
  cwd: string,
  visible = false,
): Promise<ProcessResult> {
  const result = await deps.run(command, args, cwd, visible);
  if (result.status !== 0) {
    const detail = result.stderr || result.stdout || `exit status ${String(result.status)}`;
    throw new Error(`${commandText(command, args)} failed: ${detail}`);
  }
  return result;
}

async function git(
  deps: UpdateDependencies,
  root: string,
  args: readonly string[],
  visible = false,
): Promise<ProcessResult> {
  return await requireSuccess(deps, 'git', ['-C', root, ...args], root, visible);
}

async function isAncestor(
  deps: UpdateDependencies,
  root: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await deps.run('git', ['-C', root, 'merge-base', '--is-ancestor', ancestor, descendant], root);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`git merge-base --is-ancestor ${ancestor} ${descendant} failed: ${result.stderr || result.stdout}`);
}

async function optionalGit(deps: UpdateDependencies, root: string, args: readonly string[]): Promise<string | null> {
  const result = await deps.run('git', ['-C', root, ...args], root);
  return result.status === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : null;
}

function parseSchemaVersion(source: string, ref: string): number {
  const match = /STORE_SCHEMA_VERSION\s*=\s*(\d+)/u.exec(source);
  const version = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(
      `${ref} does not advertise a valid store schema in ${SCHEMA_VERSION_PATH}; integrate a newer Conductor source manually.`,
    );
  }
  return version;
}

async function advertisedSchemaVersion(deps: UpdateDependencies, root: string, ref: string): Promise<number> {
  const shown = await git(deps, root, ['show', `${ref}:${SCHEMA_VERSION_PATH}`]);
  return parseSchemaVersion(shown.stdout, ref);
}

/**
 * Refresh a Git-source installation without inventing history.
 *
 * The updater either rebuilds an already-current source commit or performs one
 * unambiguous fast-forward. Diverged feature work is left for its author.
 */
export async function updateSourceInstallation(
  options: SourceUpdateOptions,
  overrides: Partial<UpdateDependencies> = {},
): Promise<SourceUpdateResult> {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  const root = realpathSync(resolve(options.packageRoot));
  const log = options.log ?? (() => undefined);

  if (!deps.exists(join(root, '.git'))) {
    throw new Error(
      `This Conductor is not running from a Git source checkout (${root}). Update it with the package manager that installed it.`,
    );
  }
  const repositoryRoot = realpathSync((await git(deps, root, ['rev-parse', '--show-toplevel'])).stdout);
  if (repositoryRoot !== root) {
    throw new Error(`Conductor package root ${root} is not the Git checkout root ${repositoryRoot}.`);
  }
  const branch = (await git(deps, root, ['branch', '--show-current'])).stdout;
  if (branch.length === 0) {
    throw new Error('Conductor source is detached. Check out a branch before running conductor update.');
  }
  const dirty = (await git(deps, root, ['status', '--porcelain=v1', '--untracked-files=normal'])).stdout;
  if (dirty.length > 0) {
    throw new Error('Conductor source has uncommitted changes. Commit or stash them before running conductor update.');
  }
  if (options.fleetRunning !== undefined && (await options.fleetRunning())) {
    throw new Error('This fleet has a running Conductor. Stop it before updating the CLI or database schema.');
  }

  log('Fetching Conductor source...');
  await git(deps, root, ['fetch', '--prune', 'origin'], true);

  const defaultRef =
    (await optionalGit(deps, root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])) ?? 'origin/main';
  if ((await optionalGit(deps, root, ['rev-parse', '--verify', defaultRef])) === null) {
    throw new Error(`Cannot resolve the source remote's default branch (${defaultRef}).`);
  }

  let candidate = 'HEAD';
  let fastForwarded = false;
  const upstream = await optionalGit(deps, root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (
    upstream !== null &&
    (await isAncestor(deps, root, 'HEAD', upstream)) &&
    !(await isAncestor(deps, root, upstream, 'HEAD'))
  ) {
    candidate = upstream;
  } else if (await isAncestor(deps, root, defaultRef, 'HEAD')) {
    candidate = 'HEAD';
  } else if (await isAncestor(deps, root, 'HEAD', defaultRef)) {
    candidate = defaultRef;
  } else {
    throw new Error(
      `Conductor source branch ${branch} has diverged from ${defaultRef}. Rebase or merge ${defaultRef} manually, then rerun conductor update.`,
    );
  }

  const candidateSchema = await advertisedSchemaVersion(deps, root, candidate);
  if (options.requiredSchemaVersion !== undefined && candidateSchema < options.requiredSchemaVersion) {
    throw new Error(
      `Latest safe source ${candidate} supports database schema ${String(candidateSchema)}, but this fleet requires ${String(options.requiredSchemaVersion)}. Integrate a source branch containing that migration, then rerun conductor update.`,
    );
  }

  if (candidate !== 'HEAD') {
    log(`Fast-forwarding ${branch} to ${candidate}...`);
    await git(deps, root, ['merge', '--ff-only', candidate], true);
    fastForwarded = true;
  } else {
    log(`${branch} already contains the latest ${defaultRef}; rebuilding its current source.`);
  }

  for (const [label, args] of [
    ['Installing locked dependencies', ['install', '--frozen-lockfile']],
    ['Building Conductor', ['build']],
    ['Verifying the package', ['verify:package']],
    ['Refreshing the global CLI link', ['link', '--global']],
  ] as const) {
    log(`${label}...`);
    await requireSuccess(deps, 'pnpm', args, root, true);
  }

  let migratedFleet = false;
  if (options.fleetDir !== undefined) {
    const args = [join(root, 'dist', 'cli', 'index.js'), '-C', resolve(options.fleetDir)];
    if (options.instance !== undefined) args.push('--instance', options.instance);
    args.push('_migrate');
    log('Synchronizing the fleet database schema...');
    await requireSuccess(deps, process.execPath, args, root, true);
    migratedFleet = true;
  }

  const commit = (await git(deps, root, ['rev-parse', '--short', 'HEAD'])).stdout;
  return { branch, commit, schemaVersion: candidateSchema, fastForwarded, migratedFleet };
}
