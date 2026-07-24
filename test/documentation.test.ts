import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONDUCTOR_DOC_TOPICS,
  ConductorDocumentation,
  parseConductorDocumentation,
} from '../src/core/documentation.js';
import { InvalidRequestError } from '../src/core/errors.js';

const referencePath = fileURLToPath(new URL('../docs/agent-guide.md', import.meta.url));

function documentation(): ConductorDocumentation {
  return new ConductorDocumentation({
    referencePath,
    fleetDir: '/fleets/example',
    fleetPaths: {
      layout: 'conductor-directory',
      rootDir: '/fleets/example/.conductor',
      configDir: '/fleets/example/.conductor/config',
      sessionsDir: '/fleets/example/.conductor/config/sessions',
      supervisorFile: '/fleets/example/.conductor/config/supervisor.yaml',
      shepherdConfigFile: '/fleets/example/.conductor/config/pr-shepherd.yaml',
      dataDirDefault: './.conductor/data',
      environmentFile: '/fleets/example/.conductor/.env',
      environmentTemplate: '/fleets/example/.conductor/env.template',
    },
  });
}

describe('agent documentation', () => {
  it('parses every declared lazy topic exactly once with a visible heading', () => {
    const parsed = parseConductorDocumentation(readFileSync(referencePath, 'utf8'));
    expect([...parsed.keys()]).toEqual(CONDUCTOR_DOC_TOPICS);
    for (const topic of parsed.values()) {
      expect(topic.title.length).toBeGreaterThan(0);
      expect(topic.content).toContain(`## ${topic.title}`);
    }
  });

  it('returns a compact index plus authoritative fleet paths when no topic is requested', async () => {
    const result = JSON.parse(await documentation().read()) as {
      topics: { name: string }[];
      fleet: Record<string, string>;
      safety: string;
    };
    expect(result.topics.map((topic) => topic.name)).toEqual(CONDUCTOR_DOC_TOPICS);
    expect(result.fleet).toMatchObject({
      fleetDir: '/fleets/example',
      supervisorConfig: '/fleets/example/.conductor/config/supervisor.yaml',
      shepherdConfig: '/fleets/example/.conductor/config/pr-shepherd.yaml',
      sessionsDir: '/fleets/example/.conductor/config/sessions',
      environmentFile: '/fleets/example/.conductor/.env',
      referencePath,
    });
    expect(result.safety).toContain('Never print');
  });

  it('loads only the requested topic and rejects unknown topics with the available list', async () => {
    const result = JSON.parse(await documentation().read('worktrees')) as {
      topic: string;
      content: string;
      fleet: { supervisorConfig: string };
    };
    expect(result.topic).toBe('worktrees');
    expect(result.content).toContain('## Worktrees, templates, and full-fleet workspace patterns');
    expect(result.content).not.toContain('## Cron schedules');
    expect(result.fleet.supervisorConfig).toBe('/fleets/example/.conductor/config/supervisor.yaml');

    await expect(documentation().read('not-real')).rejects.toThrow(InvalidRequestError);
    await expect(documentation().read('not-real')).rejects.toThrow('Available topics:');
  });

  it('keeps live status, maintenance commands, and health semantics discoverable', async () => {
    const operator = JSON.parse(await documentation().read('operator-channels')) as { content: string };
    expect(operator.content).toContain('conductor status [session]');
    expect(operator.content).toContain('default refresh interval is 15 seconds');
    expect(operator.content).toContain('conductor logs [session]');
    expect(operator.content).toContain('conductor validate');
    expect(operator.content).toContain('conductor daemon install');

    const lifecycle = JSON.parse(await documentation().read('lifecycle')) as { content: string };
    expect(lifecycle.content).toContain('`idle`:');
    expect(lifecycle.content).toContain('`stalled`:');
    expect(lifecycle.content).toContain('`health.idleConfirmMs`');

    const supervision = JSON.parse(await documentation().read('supervision')) as { content: string };
    expect(supervision.content).toContain('does not semantically decide');
    expect(supervision.content).toContain('`blocked` immediately');
    expect(supervision.content).toContain('`silent`');
    expect(supervision.content).toContain('Codex currently reports completed turns');
  });
});
