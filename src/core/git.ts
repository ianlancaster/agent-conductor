import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// `git rev-parse --local-env-vars` documents these as repository-local. Git
// exports a subset to hooks; in a linked worktree GIT_DIR points at
// .git/worktrees/<name>. Letting a later `git init` inherit that path can
// reinitialize the administrative directory and rewrite the shared config as
// core.bare=true.
export const REPOSITORY_LOCAL_GIT_ENV = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
] as const;

/** Clone an environment without any outer repository's process-local scope. */
export function isolatedGitEnvironment(inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherited, GIT_TERMINAL_PROMPT: '0' };
  for (const key of REPOSITORY_LOCAL_GIT_ENV) delete env[key];
  // GIT_CONFIG_COUNT is accompanied by indexed key/value variables. They are
  // ignored without the count, but removing them keeps the boundary complete.
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  return env;
}

/**
 * Run Git without inheriting repository-scoping variables from an outer hook.
 * Conductor Git operations are non-interactive: configured credential helpers
 * and SSH agents still work, but a hidden supervisor can never wait on a prompt.
 */
export function runGit(
  args: string[],
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, {
    env: isolatedGitEnvironment(options.env),
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  });
}
