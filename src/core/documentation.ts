import { readFile } from 'node:fs/promises';
import type { FleetPaths } from '../config/paths.js';
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
  'adapters',
  'troubleshooting',
] as const;

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
}

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
  constructor(private readonly options: ConductorDocumentationOptions) {}

  async read(topic?: string): Promise<string> {
    const markdown = await readFile(this.options.referencePath, 'utf8');
    const parsed = parseConductorDocumentation(markdown);
    this.assertComplete(parsed);
    const context = {
      fleetDir: this.options.fleetDir,
      supervisorConfig: this.options.fleetPaths.supervisorFile,
      shepherdConfig: this.options.fleetPaths.shepherdConfigFile,
      sessionsDir: this.options.fleetPaths.sessionsDir,
      environmentFile: this.options.fleetPaths.environmentFile,
      referencePath: this.options.referencePath,
    };

    if (topic === undefined) {
      return JSON.stringify(
        {
          purpose:
            'Lazy reference for operating, composing, configuring, troubleshooting, and extending Agent Conductor.',
          usage: "Call get_conductor_docs again with one topic name. Load only the topics relevant to the user's task.",
          topics: CONDUCTOR_DOC_TOPICS.map((name) => {
            const entry = parsed.get(name);
            return { name, title: entry?.title };
          }),
          fleet: context,
          safety:
            'The environment file may contain credentials. Never print, quote, summarize, or send its values unless the operator explicitly requests a specific safe operation.',
        },
        null,
        2,
      );
    }

    const entry = parsed.get(topic);
    if (entry === undefined) {
      throw new InvalidRequestError(
        `Unknown Conductor documentation topic '${topic}'. Available topics: ${CONDUCTOR_DOC_TOPICS.join(', ')}`,
      );
    }
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

  private assertComplete(parsed: Map<string, ParsedTopic>): void {
    const missing = CONDUCTOR_DOC_TOPICS.filter((topic) => !parsed.has(topic));
    const unknown = [...parsed.keys()].filter((topic) => !CONDUCTOR_DOC_TOPICS.includes(topic as ConductorDocTopic));
    if (missing.length > 0 || unknown.length > 0) {
      throw new Error(
        `Conductor documentation topic mismatch (missing: ${missing.join(', ') || 'none'}; unknown: ${
          unknown.join(', ') || 'none'
        }).`,
      );
    }
  }
}
