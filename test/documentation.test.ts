import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONDUCTOR_DOC_ALIASES,
  CONDUCTOR_DOC_TOPICS,
  ConductorDocumentation,
  parseConductorDocumentation,
} from '../src/core/documentation.js';
import { InvalidRequestError } from '../src/core/errors.js';
import { RunbookRegistry } from '../src/runbooks/registry.js';

const referencePath = fileURLToPath(new URL('../docs/agent-guide.md', import.meta.url));
const builtInDir = fileURLToPath(new URL('../runbooks', import.meta.url));
const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function documentation(): ConductorDocumentation {
  return new ConductorDocumentation({
    referencePath,
    fleetDir: '/fleets/example',
    fleetPaths: {
      layout: 'conductor-directory',
      rootDir: '/fleets/example/.conductor',
      configDir: '/fleets/example/.conductor/config',
      sessionsDir: '/fleets/example/.conductor/config/sessions',
      runbooksDir: '/fleets/example/.conductor/runbooks',
      supervisorFile: '/fleets/example/.conductor/config/supervisor.yaml',
      shepherdConfigFile: '/fleets/example/.conductor/config/pr-shepherd.yaml',
      dataDirDefault: './.conductor/data',
      environmentFile: '/fleets/example/.conductor/.env',
      environmentTemplate: '/fleets/example/.conductor/env.template',
    },
    runbooks: new RunbookRegistry({
      conductorVersion: '0.1.0',
      fleetDir: '/fleets/example',
      fleetRunbooksDir: '/fleets/example/.conductor/runbooks',
      builtInDir,
    }),
  });
}

describe('agent documentation', () => {
  it('parses every declared lazy topic exactly once with a visible heading', () => {
    const parsed = new Map([...parseConductorDocumentation(readFileSync(referencePath, 'utf8'))]);
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
      runbooksDir: '/fleets/example/.conductor/runbooks',
    });
    expect(result.safety).toContain('Never print');
  });

  it('offers the runbook as a catalog plus canonical resources and byte-identical aliases', async () => {
    const index = JSON.parse(await documentation().read()) as {
      runbooks: { id: string; version: string; source: string; topics: { id: string }[] }[];
    };
    const engineering = index.runbooks.find((runbook) => runbook.id === 'agent-conductor/engineering-management');
    expect(engineering).toMatchObject({ version: '1.0.0', source: 'built-in' });
    expect(engineering?.topics.map((topic) => topic.id)).toContain('tier-1');
    const catalog = JSON.parse(await documentation().read('runbooks')) as { content: string };
    expect(catalog.content).toContain('engineering-management');

    const canonical = JSON.parse(
      await documentation().read('runbook:agent-conductor/engineering-management/tier-1'),
    ) as {
      content: string;
      canonicalTopic: string;
    };
    const alias = JSON.parse(await documentation().read('runbook-engineering-management-tier-1')) as {
      content: string;
      canonicalTopic: string;
    };
    expect(canonical.content).toContain('Tier 1');
    expect(canonical.content).not.toContain('Tier 4');
    expect(alias.content).toBe(canonical.content);
    expect(alias.canonicalTopic).toBe(canonical.canonicalTopic);
    expect(CONDUCTOR_DOC_ALIASES['runbook-engineering-management-tier-1']).toBe(canonical.canonicalTopic);
  });

  it('re-reads a live fleet bundle and exposes only declared metadata and content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'conductor-doc-runbook-'));
    scratch.push(root);
    const bundle = join(root, '.conductor', 'runbooks', 'team', 'workflow');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, 'README.md'), '# Fleet workflow\n\nFirst version.\n');
    writeFileSync(
      join(bundle, 'runbook.yaml'),
      'schemaVersion: 1\nid: team/workflow\nname: Team Workflow\nversion: 1.0.0\nsummary: A local workflow.\nrequires:\n  conductor: ">=0.1.0"\ntopics:\n  - id: overview\n    title: Fleet workflow\n    summary: Start here.\n    path: README.md\nresources: []\n',
    );
    const paths = {
      layout: 'conductor-directory' as const,
      rootDir: join(root, '.conductor'),
      configDir: join(root, '.conductor', 'config'),
      sessionsDir: join(root, '.conductor', 'config', 'sessions'),
      runbooksDir: join(root, '.conductor', 'runbooks'),
      supervisorFile: join(root, '.conductor', 'config', 'supervisor.yaml'),
      shepherdConfigFile: join(root, '.conductor', 'config', 'pr-shepherd.yaml'),
      dataDirDefault: './.conductor/data',
      environmentFile: join(root, '.conductor', '.env'),
      environmentTemplate: join(root, '.conductor', 'env.template'),
    };
    const docs = new ConductorDocumentation({
      referencePath,
      fleetDir: root,
      fleetPaths: paths,
      runbooks: new RunbookRegistry({
        conductorVersion: '0.1.0',
        fleetDir: root,
        fleetRunbooksDir: paths.runbooksDir,
      }),
    });
    const first = JSON.parse(await docs.read('runbook:team/workflow/overview')) as { content: string };
    expect(first.content).toContain('First version');
    writeFileSync(join(bundle, 'README.md'), '# Fleet workflow\n\nChanged without restart.\n');
    const changed = JSON.parse(await docs.read('runbook:team/workflow/overview')) as { content: string };
    expect(changed.content).toContain('Changed without restart');
    expect(JSON.stringify(await docs.read())).not.toContain(bundle);
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

    const events = JSON.parse(await documentation().read('event-subscribers')) as { content: string };
    expect(events.content).toContain('`ConductorEventSubscriber`');
    expect(events.content).toContain('live, best-effort, and at most once');
    expect(events.content).toContain('without a preceding `session.started`');
    expect(events.content).toContain('do not carry pane captures');
  });
});
