import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FleetPaths } from '../config/paths.js';
import { log } from '../logger.js';
import type { RunbookRegistry } from '../runbooks/registry.js';
import { readRunbookFile } from '../runbooks/schema.js';
import type { ResolvedRunbook } from '../runbooks/types.js';
import { InvalidRequestError } from './errors.js';

const TOPIC_MARKER = /^<!-- conductor-topic:([a-z0-9-]+) -->$/gmu;

export const CONDUCTOR_DOC_TOPICS = [
  'overview',
  'onboarding',
  'fleet-configuration',
  'communication',
  'lifecycle',
  'worktrees',
  'supervision',
  'scheduling',
  'operator-channels',
  'pr-shepherd',
  'recipes',
  'runbooks',
  'adapters',
  'event-subscribers',
  'troubleshooting',
  'work-status',
  'fleet-knowledge',
] as const;
export const OPTIONAL_CONDUCTOR_DOC_TOPICS = ['opencodex'] as const;

/** Fleet-root file whose presence marks a shared fleet knowledge base. */
export const FLEET_KNOWLEDGE_INDEX_FILE = 'knowledge-index.toml';

/** Marker file of a Federation root: a directory above one or more fleets. */
export const FEDERATION_MARKER_FILE = 'federation.toml';

/** The nearest strict ancestor of `fleetDir` holding `federation.toml`, if any. */
export function findFederationRoot(fleetDir: string): string | undefined {
  let current = dirname(fleetDir);
  for (;;) {
    if (existsSync(join(current, FEDERATION_MARKER_FILE))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * The protocol line that points managed sessions at the fleet knowledge base
 * and, when the fleet sits inside a Federation that has one, the Federation
 * knowledge base. Undefined when neither index file exists. Checked on every
 * call so the line follows the files rather than the Conductor process lifetime.
 */
export function fleetKnowledgeNotice(fleetDir: string): string | undefined {
  const sentences: string[] = [];
  const indexPath = join(fleetDir, FLEET_KNOWLEDGE_INDEX_FILE);
  if (existsSync(indexPath)) {
    sentences.push(
      `This fleet has a shared knowledge base: the markdown folders listed in \`${indexPath}\`, searchable with your memory tools. Put fleet-wide knowledge there rather than in your own repository. Load \`get_conductor_docs\` topic \`fleet-knowledge\` before adding a folder.`,
    );
  }
  const federationRoot = findFederationRoot(fleetDir);
  const federationIndex = federationRoot === undefined ? undefined : join(federationRoot, FLEET_KNOWLEDGE_INDEX_FILE);
  if (federationIndex !== undefined && existsSync(federationIndex)) {
    sentences.push(
      `There is ${sentences.length === 0 ? 'a' : 'also a'} Federation knowledge base for knowledge that holds across fleets, listed in \`${federationIndex}\` and searchable with your memory tools; propose changes to it through its \`_inbox/\` folders.`,
    );
  }
  return sentences.length === 0 ? undefined : sentences.join(' ');
}

export type ConductorDocTopic = (typeof CONDUCTOR_DOC_TOPICS)[number];

interface ParsedTopic {
  name: string;
  title: string;
  content: string;
}

export interface ConductorDocumentationOptions {
  referencePath: string;
  fleetDir: string;
  fleetPaths: FleetPaths;
  runbooks: RunbookRegistry;
  /** Expose proxy-harness guidance only when the fleet enables that runtime. */
  openCodexEnabled?: boolean;
}

const ENGINEERING_MANAGEMENT_ID = 'agent-conductor/engineering-management';
export const CONDUCTOR_DOC_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'runbook-engineering-management': `runbook:${ENGINEERING_MANAGEMENT_ID}/overview`,
  'runbook-engineering-management-tier-1': `runbook:${ENGINEERING_MANAGEMENT_ID}/tier-1`,
  'runbook-engineering-management-tier-2': `runbook:${ENGINEERING_MANAGEMENT_ID}/tier-2`,
  'runbook-engineering-management-tier-3': `runbook:${ENGINEERING_MANAGEMENT_ID}/tier-3`,
  'runbook-engineering-management-tier-4': `runbook:${ENGINEERING_MANAGEMENT_ID}/tier-4`,
  'runbook-engineering-management-practices': `runbook:${ENGINEERING_MANAGEMENT_ID}/practices`,
  'runbook-engineering-management-templates': `runbook:${ENGINEERING_MANAGEMENT_ID}/templates`,
});

/** Parse explicit topic markers while keeping the Markdown useful as a standalone guide. */
export function parseConductorDocumentation(markdown: string): Map<string, ParsedTopic> {
  const markers = [...markdown.matchAll(TOPIC_MARKER)];
  const topics = new Map<string, ParsedTopic>();
  for (const [index, marker] of markers.entries()) {
    const name = marker[1];
    if (name === undefined) continue;
    const start = (marker.index ?? 0) + marker[0].length;
    const end = markers[index + 1]?.index ?? markdown.length;
    const content = markdown.slice(start, end).trim();
    const title = /^##\s+(.+)$/mu.exec(content)?.[1]?.trim();
    if (title === undefined) throw new Error(`Conductor documentation topic '${name}' needs an H2 heading.`);
    if (topics.has(name)) throw new Error(`Duplicate Conductor documentation topic '${name}'.`);
    topics.set(name, { name, title, content });
  }
  return topics;
}

/**
 * Version-matched, lazily loaded documentation for managed sessions.
 *
 * The Markdown ships with the package; callers receive only an index or one
 * requested topic so the extended guide does not consume every session's
 * system-prompt context.
 */
export class ConductorDocumentation {
  private readonly warnedDiagnostics = new Set<string>();

  constructor(private readonly options: ConductorDocumentationOptions) {}

  async read(topic?: string): Promise<string> {
    const parsed = parseConductorDocumentation(await readFile(this.options.referencePath, 'utf8'));
    this.assertComplete(parsed);
    const runbookSnapshot = this.options.runbooks.snapshot();
    for (const diagnostic of runbookSnapshot.diagnostics) {
      const key = `${diagnostic.source}:${diagnostic.path}:${diagnostic.message}`;
      if (this.warnedDiagnostics.has(key)) continue;
      this.warnedDiagnostics.add(key);
      log().warn('runbooks', `${diagnostic.source} ${diagnostic.path}: ${diagnostic.message}`);
    }
    const runbookKeys = runbookSnapshot.runbooks.flatMap((runbook) => this.runbookKeys(runbook));
    const coreTopics: readonly string[] = this.options.openCodexEnabled
      ? [...CONDUCTOR_DOC_TOPICS, ...OPTIONAL_CONDUCTOR_DOC_TOPICS]
      : CONDUCTOR_DOC_TOPICS;
    const availableTopics = [...coreTopics, ...runbookKeys, ...Object.keys(CONDUCTOR_DOC_ALIASES)];
    const context = {
      fleetDir: this.options.fleetDir,
      supervisorConfig: this.options.fleetPaths.supervisorFile,
      shepherdConfig: this.options.fleetPaths.shepherdConfigFile,
      sessionsDir: this.options.fleetPaths.sessionsDir,
      environmentFile: this.options.fleetPaths.environmentFile,
      runbooksDir: this.options.fleetPaths.runbooksDir,
      knowledgeIndexFile: join(this.options.fleetDir, FLEET_KNOWLEDGE_INDEX_FILE),
      referencePath: this.options.referencePath,
    };

    if (topic === undefined) {
      return JSON.stringify(
        {
          purpose:
            'Lazy reference for operating, composing, configuring, troubleshooting, and extending Agent Conductor.',
          usage: "Call get_conductor_docs again with one topic name. Load only the topics relevant to the user's task.",
          topics: coreTopics.map((name) => {
            const entry = parsed.get(name);
            return { name, title: entry?.title };
          }),
          runbooks: runbookSnapshot.runbooks.map((runbook) => ({
            id: runbook.id,
            name: runbook.name,
            version: runbook.version,
            summary: runbook.summary,
            source: runbook.source,
            ...(runbook.variantOf === undefined ? {} : { variantOf: runbook.variantOf, delta: runbook.delta }),
            topics: runbook.topics.map(({ id, title, summary }) => ({ id, title, summary })),
            resources: runbook.resources.map(({ id, title, mediaType }) => ({ id, title, mediaType })),
          })),
          fleet: context,
          safety:
            'The environment file may contain credentials. Never print, quote, summarize, or send its values unless the operator explicitly requests a specific safe operation.',
        },
        null,
        2,
      );
    }

    const entry = coreTopics.includes(topic) ? parsed.get(topic) : undefined;
    if (entry !== undefined) {
      return JSON.stringify(
        {
          topic: entry.name,
          title: entry.title,
          content: entry.content,
          fleet: context,
        },
        null,
        2,
      );
    }

    const canonicalTopic = CONDUCTOR_DOC_ALIASES[topic] ?? topic;
    const resolved = this.resolveRunbookResource(runbookSnapshot.runbooks, canonicalTopic);
    if (resolved === undefined) {
      throw new InvalidRequestError(
        `Unknown Conductor documentation topic '${topic}'. Available topics: ${availableTopics.join(', ')}`,
      );
    }
    return JSON.stringify(
      {
        topic,
        canonicalTopic,
        title: resolved.title,
        mediaType: resolved.mediaType,
        runbook: {
          id: resolved.runbook.id,
          name: resolved.runbook.name,
          version: resolved.runbook.version,
          source: resolved.runbook.source,
        },
        content: readRunbookFile(resolved.runbook, resolved.path, `Runbook resource '${canonicalTopic}'`),
        fleet: context,
      },
      null,
      2,
    );
  }

  private runbookKeys(runbook: ResolvedRunbook): string[] {
    return [
      ...runbook.topics.map((topic) => `runbook:${runbook.id}/${topic.id}`),
      ...runbook.resources.map((resource) => `runbook:${runbook.id}/resource/${resource.id}`),
    ];
  }

  private resolveRunbookResource(
    runbooks: readonly ResolvedRunbook[],
    key: string,
  ): { runbook: ResolvedRunbook; title: string; mediaType: string; path: string } | undefined {
    for (const runbook of runbooks) {
      for (const topic of runbook.topics) {
        if (key === `runbook:${runbook.id}/${topic.id}`) {
          return { runbook, title: topic.title, mediaType: 'text/markdown', path: topic.path };
        }
      }
      for (const resource of runbook.resources) {
        if (key === `runbook:${runbook.id}/resource/${resource.id}`) {
          return { runbook, title: resource.title, mediaType: resource.mediaType, path: resource.path };
        }
      }
    }
    return undefined;
  }

  private assertComplete(parsed: Map<string, ParsedTopic>): void {
    const allTopics: readonly string[] = [...CONDUCTOR_DOC_TOPICS, ...OPTIONAL_CONDUCTOR_DOC_TOPICS];
    const required: readonly string[] = this.options.openCodexEnabled ? allTopics : CONDUCTOR_DOC_TOPICS;
    const missing = required.filter((topic) => !parsed.has(topic));
    const unknown = [...parsed.keys()].filter((topic) => !allTopics.includes(topic));
    if (missing.length > 0 || unknown.length > 0) {
      throw new Error(
        `Conductor documentation topic mismatch (missing: ${missing.join(', ') || 'none'}; unknown: ${
          unknown.join(', ') || 'none'
        }).`,
      );
    }
  }
}
