import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Run Git without inheriting repository-scoping variables from an outer hook.
 * Conductor Git operations are non-interactive: configured credential helpers
 * and SSH agents still work, but a hidden supervisor can never wait on a prompt.
 */
export function runGit(
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX']) {
    delete env[key];
  }
  return execFileAsync('git', args, {
    env,
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  });
}
