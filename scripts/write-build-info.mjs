import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Records which source tree produced dist/, so a running Conductor can report
// the build it actually loaded (for example in `conductor restart` output).
// A package built outside a Git checkout records no commit.
function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

function writeBuildInfo(packageRoot) {
  const commit = git(packageRoot, ['rev-parse', '--short', 'HEAD']);
  const dirty =
    commit !== undefined && (git(packageRoot, ['status', '--porcelain', '--untracked-files=no']) ?? '') !== '';
  const info = { commit: commit ?? null, dirty, builtAt: new Date().toISOString() };
  writeFileSync(path.join(packageRoot, 'dist', 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeBuildInfo(path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
}
