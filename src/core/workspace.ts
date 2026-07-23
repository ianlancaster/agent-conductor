import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, rmdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { SpawnTemplate } from '../config/schema.js';
import { runGit } from './git.js';
import { addWorktree } from './worktree.js';

export type WorkspaceSource =
  | { kind: 'empty' }
  | { kind: 'worktree'; repo: string; branch: string }
  | { kind: 'template'; template: SpawnTemplate; baseDir: string; timeoutMs: number };

/** Resolve local template paths without rewriting URL and scp-style Git sources. */
export function resolveTemplateSource(source: string, baseDir: string): string {
  if (isAbsolute(source) || /^[^/\\]+:/.test(source)) return source;
  return resolve(baseDir, source);
}

/** Materialize exactly one kind of workspace before session registration. */
export async function materializeWorkspace(dir: string, source: WorkspaceSource): Promise<void> {
  if (source.kind === 'empty') {
    mkdirSync(dir, { recursive: true });
    return;
  }
  if (source.kind === 'worktree') {
    await addWorktree(source.repo, dir, source.branch);
    return;
  }

  const destinationExisted = existsSync(dir);
  if (destinationExisted) {
    if (!statSync(dir).isDirectory() || readdirSync(dir).length > 0) {
      throw new Error(`Template destination is not empty: ${dir}`);
    }
  }

  if (source.template.ref?.startsWith('-') === true) {
    throw new Error(`Invalid template ref '${source.template.ref}': must not begin with '-'.`);
  }

  const parent = dirname(dir);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, `.${basename(dir)}.conductor-template-`));
  const templateSource = resolveTemplateSource(source.template.source, source.baseDir);
  let promoted = false;
  try {
    await runGit(['clone', '--origin', 'template', '--', templateSource, staging], { timeoutMs: source.timeoutMs });
    if (source.template.ref !== undefined) {
      await runGit(['-C', staging, 'checkout', source.template.ref], { timeoutMs: source.timeoutMs });
    }
    // An existing destination was proven empty above. rmdir is deliberately
    // non-recursive: if anything appeared there during the clone, promotion
    // fails without deleting it.
    if (destinationExisted) rmdirSync(dir);
    renameSync(staging, dir);
    promoted = true;
  } finally {
    // This exact staging directory was created by us and is never user-owned.
    if (!promoted && existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}
