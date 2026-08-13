import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

async function executable(file: string): Promise<string | undefined> {
  try {
    await access(file, constants.X_OK);
    return path.resolve(file);
  } catch {
    return undefined;
  }
}

/** Resolve one configured executable without invoking a shell. */
export async function resolveExecutable(
  command: string,
  opts: { cwd: string; env?: NodeJS.ProcessEnv },
): Promise<string | undefined> {
  if (path.isAbsolute(command)) return executable(command);
  if (command.includes(path.sep) || (path.sep === '\\' && command.includes('/'))) {
    return executable(path.resolve(opts.cwd, command));
  }
  const searchPath = opts.env?.PATH ?? process.env.PATH ?? '';
  for (const entry of searchPath.split(path.delimiter)) {
    if (entry.length === 0) continue;
    const directory = path.isAbsolute(entry) ? entry : path.resolve(opts.cwd, entry);
    const found = await executable(path.join(directory, command));
    if (found !== undefined) return found;
  }
  return undefined;
}
