import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import yaml from 'js-yaml';
import { RUNBOOK_SEGMENT_PATTERN, loadRunbookBundle } from './schema.js';

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return RUNBOOK_SEGMENT_PATTERN.test(normalized) ? normalized : 'example-runbook';
}

export function initializeRunbook(targetPath: string): string {
  const target = resolve(targetPath);
  if (existsSync(target)) throw new Error(`Refusing to overwrite existing path: ${target}`);
  mkdirSync(target, { recursive: true });
  const name = basename(target);
  const manifest = {
    schemaVersion: 1,
    id: `local/${slug(name)}`,
    name: name.replace(/[-_]+/gu, ' '),
    version: '0.1.0',
    summary: 'Describe the workflow this runbook helps an operator compose.',
    requires: { conductor: '>=0.1.0' },
    topics: [
      {
        id: 'overview',
        title: 'Overview',
        summary: 'Prerequisites, operator decisions, adoption steps, verification, and rollback.',
        path: 'README.md',
      },
    ],
    resources: [],
  };
  writeFileSync(resolve(target, 'runbook.yaml'), yaml.dump(manifest, { noRefs: true, lineWidth: 120 }));
  writeFileSync(
    resolve(target, 'README.md'),
    `# ${manifest.name}\n\nExplain what this runbook composes, the decisions the operator must make, and how to verify and undo the setup.\n`,
  );
  return target;
}

export function validateRunbookPath(path: string, conductorVersion: string): void {
  loadRunbookBundle(resolve(path), 'external', conductorVersion);
}
