import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { SupervisorConfig } from '../config/schema.js';
import { resolveFleetPaths } from '../config/paths.js';
import { loadRunbookBundle } from './schema.js';
import type { ResolvedRunbook, RunbookDiagnostic, RunbookRegistrySnapshot, RunbookSource } from './types.js';

const DISCOVERY_MAX_DEPTH = 4;
const DISCOVERY_MAX_DIRECTORIES = 1_000;

export interface RunbookRegistryOptions {
  conductorVersion: string;
  fleetDir: string;
  fleetRunbooksDir: string;
  builtInDir?: string;
  externalPaths?: readonly string[];
}

interface Candidate {
  source: RunbookSource;
  path: string;
}

function discoverFrom(root: string, source: RunbookSource): Candidate[] {
  if (!existsSync(root)) return [];
  const resolvedRoot = resolve(root);
  if (existsSync(join(resolvedRoot, 'runbook.yaml'))) return [{ source, path: resolvedRoot }];

  const candidates: Candidate[] = [];
  const queue: { path: string; depth: number }[] = [{ path: resolvedRoot, depth: 0 }];
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    visited += 1;
    if (visited > DISCOVERY_MAX_DIRECTORIES)
      throw new Error(
        `Runbook discovery exceeded ${String(DISCOVERY_MAX_DIRECTORIES)} directories under ${resolvedRoot}`,
      );
    if (existsSync(join(current.path, 'runbook.yaml'))) {
      candidates.push({ source, path: current.path });
      continue;
    }
    if (current.depth >= DISCOVERY_MAX_DEPTH) continue;
    for (const entry of readdirSync(current.path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const child = join(current.path, entry.name);
      if (lstatSync(child).isSymbolicLink()) continue;
      queue.push({ path: child, depth: current.depth + 1 });
    }
  }
  return candidates;
}

/** Dynamic local-first registry. Every snapshot re-reads disk; discovery never executes bundle code. */
export class RunbookRegistry {
  constructor(private readonly options: RunbookRegistryOptions) {}

  snapshot(): RunbookRegistrySnapshot {
    const diagnostics: RunbookDiagnostic[] = [];
    const candidates: Candidate[] = [];
    const roots: { source: RunbookSource; path: string }[] = [
      ...(this.options.builtInDir === undefined
        ? []
        : [{ source: 'built-in' as const, path: this.options.builtInDir }]),
      { source: 'fleet', path: this.options.fleetRunbooksDir },
      ...(this.options.externalPaths ?? []).map((path) => ({
        source: 'external' as const,
        path: isAbsolute(path) ? path : resolve(this.options.fleetDir, path),
      })),
    ];
    for (const root of roots) {
      if (!existsSync(root.path)) {
        if (root.source === 'external') {
          diagnostics.push({ source: root.source, path: root.path, message: 'Configured runbook path does not exist' });
        }
        continue;
      }
      try {
        candidates.push(...discoverFrom(root.path, root.source));
      } catch (error) {
        diagnostics.push({
          source: root.source,
          path: root.path,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const loaded: ResolvedRunbook[] = [];
    for (const candidate of candidates.sort((a, b) => a.path.localeCompare(b.path))) {
      try {
        loaded.push(loadRunbookBundle(candidate.path, candidate.source, this.options.conductorVersion));
      } catch (error) {
        diagnostics.push({
          source: candidate.source,
          path: candidate.path,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const groups = new Map<string, ResolvedRunbook[]>();
    for (const runbook of loaded) groups.set(runbook.id, [...(groups.get(runbook.id) ?? []), runbook]);
    const runbooks: ResolvedRunbook[] = [];
    for (const [id, group] of groups) {
      if (group.length === 1 && group[0] !== undefined) {
        runbooks.push(group[0]);
        continue;
      }
      for (const duplicate of group) {
        diagnostics.push({
          source: duplicate.source,
          path: duplicate.rootDir,
          message: `Duplicate runbook id '${id}' is also declared by ${group
            .filter((item) => item !== duplicate)
            .map((item) => item.rootDir)
            .join(', ')}`,
        });
      }
    }
    runbooks.sort((a, b) => a.id.localeCompare(b.id));
    diagnostics.sort((a, b) => a.path.localeCompare(b.path) || a.message.localeCompare(b.message));
    return { runbooks, diagnostics };
  }
}

export function configuredRunbookRegistry(
  fleetDir: string,
  config: SupervisorConfig,
  conductorVersion: string,
  builtInDir?: string,
  fleetRunbooksDir?: string,
): RunbookRegistry {
  return new RunbookRegistry({
    conductorVersion,
    fleetDir,
    fleetRunbooksDir: fleetRunbooksDir ?? resolveFleetPaths(fleetDir).runbooksDir,
    ...(builtInDir === undefined ? {} : { builtInDir }),
    externalPaths: config.runbooks.paths,
  });
}
