import { realpathSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import yaml from 'js-yaml';
import { satisfies, valid, validRange } from 'semver';
import { z } from 'zod';
import type { ResolvedRunbook, RunbookResourceManifest, RunbookSource, RunbookTopicManifest } from './types.js';

export const RUNBOOK_MANIFEST_MAX_BYTES = 64 * 1024;
export const RUNBOOK_RESOURCE_MAX_BYTES = 1024 * 1024;
export const RUNBOOK_DECLARATION_LIMIT = 200;
export const RUNBOOK_DELTA_MAX_LENGTH = 2_000;
export const RUNBOOK_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const RUNBOOK_ID_PATTERN = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

const RESERVED_TOPIC_IDS = new Set(['resource', 'topics']);
const MEDIA_TYPES = ['text/markdown', 'application/yaml', 'application/json', 'text/plain'] as const;

const segment = z.string().regex(RUNBOOK_SEGMENT_PATTERN, 'must use lowercase letters, digits, and dashes');
const declaredFile = z
  .object({
    id: segment,
    title: z.string().trim().min(1).max(200),
    path: z.string().trim().min(1),
  })
  .strict();

const topicSchema = declaredFile
  .extend({ summary: z.string().trim().min(1).max(500) })
  .strict()
  .superRefine((topic, context) => {
    if (RESERVED_TOPIC_IDS.has(topic.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['id'], message: `'${topic.id}' is reserved` });
    }
  });

const resourceSchema = declaredFile.extend({ mediaType: z.enum(MEDIA_TYPES) }).strict();

export const runbookManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(RUNBOOK_ID_PATTERN, 'must be a lowercase owner/name identifier'),
    name: z.string().trim().min(1).max(200),
    version: z.string().refine((value) => valid(value) === value, 'must be an exact semantic version'),
    summary: z.string().trim().min(1).max(500),
    license: z.string().trim().min(1).max(100).optional(),
    repository: z
      .string()
      .url()
      .refine((value) => value.startsWith('https://') || value.startsWith('http://'), 'must use http or https')
      .optional(),
    variantOf: z
      .object({
        id: z.string().regex(RUNBOOK_ID_PATTERN, 'must be a lowercase owner/name identifier'),
        version: z.string().refine((value) => valid(value) === value, 'must be an exact semantic version'),
      })
      .strict()
      .optional(),
    delta: z.string().trim().min(1).max(RUNBOOK_DELTA_MAX_LENGTH).optional(),
    requires: z
      .object({
        conductor: z.string().refine((value) => validRange(value) !== null, 'must be a semantic-version range'),
      })
      .strict(),
    topics: z.array(topicSchema).min(1).max(RUNBOOK_DECLARATION_LIMIT),
    resources: z.array(resourceSchema).max(RUNBOOK_DECLARATION_LIMIT).default([]),
  })
  .strict()
  .superRefine((manifest, context) => {
    if ((manifest.variantOf === undefined) !== (manifest.delta === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['delta'],
        message: 'variantOf and delta must be provided together',
      });
    }
    if (manifest.topics.length + manifest.resources.length > RUNBOOK_DECLARATION_LIMIT) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['resources'],
        message: `topics and resources together may not exceed ${String(RUNBOOK_DECLARATION_LIMIT)}`,
      });
    }
    for (const [kind, entries] of [
      ['topic', manifest.topics],
      ['resource', manifest.resources],
    ] as const) {
      const seen = new Set<string>();
      for (const entry of entries) {
        if (seen.has(entry.id)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [kind === 'topic' ? 'topics' : 'resources'],
            message: `duplicate ${kind} id '${entry.id}'`,
          });
        }
        seen.add(entry.id);
      }
    }
  });

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

function containedFile(rootDir: string, declaredPath: string, label: string): string {
  if (isAbsolute(declaredPath)) throw new Error(`${label} path must be relative: ${declaredPath}`);
  const root = realpathSync(rootDir);
  const candidate = resolve(rootDir, declaredPath);
  const lexical = relative(rootDir, candidate);
  if (lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
    throw new Error(`${label} path escapes the runbook: ${declaredPath}`);
  }
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch {
    throw new Error(`${label} file does not exist: ${declaredPath}`);
  }
  const resolvedRelative = relative(root, real);
  if (resolvedRelative === '..' || resolvedRelative.startsWith(`..${sep}`) || isAbsolute(resolvedRelative)) {
    throw new Error(`${label} symlink escapes the runbook: ${declaredPath}`);
  }
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error(`${label} is not a file: ${declaredPath}`);
  if (stat.size > RUNBOOK_RESOURCE_MAX_BYTES) {
    throw new Error(`${label} exceeds ${String(RUNBOOK_RESOURCE_MAX_BYTES)} bytes: ${declaredPath}`);
  }
  return real;
}

/** Parse and validate one inert bundle with the exact production safety rules. */
export function loadRunbookBundle(rootDir: string, source: RunbookSource, conductorVersion: string): ResolvedRunbook {
  const manifestPath = containedFile(rootDir, 'runbook.yaml', 'Manifest');
  const manifestStat = statSync(manifestPath);
  if (!manifestStat.isFile()) throw new Error(`runbook.yaml is not a file in ${rootDir}`);
  if (manifestStat.size > RUNBOOK_MANIFEST_MAX_BYTES) {
    throw new Error(`runbook.yaml exceeds ${String(RUNBOOK_MANIFEST_MAX_BYTES)} bytes`);
  }
  let raw: unknown;
  try {
    raw = yaml.load(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid runbook.yaml: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = runbookManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid runbook.yaml: ${formatIssues(parsed.error)}`);
  const manifest = parsed.data;
  if (!satisfies(conductorVersion, manifest.requires.conductor, { includePrerelease: true })) {
    throw new Error(
      `Runbook ${manifest.id}@${manifest.version} requires Conductor ${manifest.requires.conductor}; running ${conductorVersion}`,
    );
  }

  const topics = manifest.topics.map((topic: RunbookTopicManifest) => {
    if (!topic.path.toLowerCase().endsWith('.md'))
      throw new Error(`Topic '${topic.id}' must reference a Markdown file`);
    return { ...topic, absolutePath: containedFile(rootDir, topic.path, `Topic '${topic.id}'`) };
  });
  const resources = manifest.resources.map((resource: RunbookResourceManifest) => ({
    ...resource,
    absolutePath: containedFile(rootDir, resource.path, `Resource '${resource.id}'`),
  }));

  return {
    ...manifest,
    source,
    rootDir: realpathSync(rootDir),
    manifestPath: realpathSync(manifestPath),
    topics,
    resources,
  };
}

/** Re-check containment at read time so a symlink cannot be swapped after discovery. */
export function readRunbookFile(runbook: ResolvedRunbook, path: string, label: string): string {
  return readFileSync(containedFile(runbook.rootDir, path, label), 'utf8');
}
