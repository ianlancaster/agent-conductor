import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// `pnpm build` deletes dist/ before compiling, and tsc writes new files without the execute bit.
// A globally linked checkout's bin symlinks point straight at these files, so every rebuild would
// otherwise leave `conductor` failing with EACCES until someone re-runs chmod by hand.
function markBinsExecutable(packageRoot) {
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
  const marked = [];
  for (const relative of bins) {
    const target = path.join(packageRoot, relative);
    if (!existsSync(target)) throw new Error(`package.json bin target is missing after build: ${relative}`);
    chmodSync(target, statSync(target).mode | 0o111);
    marked.push(relative);
  }
  return marked;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // An explicit package root keeps the script testable against fixtures; the build passes none.
  markBinsExecutable(path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..')));
}
