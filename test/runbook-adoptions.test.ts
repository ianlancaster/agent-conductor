import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunbookAdoptions } from '../src/core/runbook-adoptions.js';
import { RunbookRegistry } from '../src/runbooks/registry.js';
import { Store } from '../src/store/index.js';
import { FakeEventPublisher } from './fakes/fake-event-publisher.js';

let scratch: string;
let store: Store;
let events: FakeEventPublisher;
let adoptions: RunbookAdoptions;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'conductor-adoptions-'));
  const runbooks = join(scratch, 'runbooks');
  writeBundle(join(runbooks, 'workflow'), 'team/workflow', '1.2.0', ['lean', 'full']);
  writeBundle(join(runbooks, 'replacement'), 'team/replacement', '2.0.0', ['overview']);
  store = new Store(join(scratch, 'conductor.db'));
  events = new FakeEventPublisher();
  adoptions = new RunbookAdoptions({
    store,
    registry: new RunbookRegistry({
      conductorVersion: '0.1.0',
      fleetDir: scratch,
      fleetRunbooksDir: runbooks,
    }),
    sessions: () =>
      new Map([
        ['manager', {}],
        ['reviewer', {}],
      ]),
    events,
  });
});

afterEach(() => {
  store.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('operator-approved runbook adoption provenance', () => {
  it('records only exact installed coordinates and registered role assignments', () => {
    const reply = adoptions.adopt({
      runbookId: 'team/workflow',
      version: '1.2.0',
      topic: 'lean',
      sessions: ['manager=engineering-manager', 'reviewer=gate-reviewer'],
    });
    const event = events.events[0];
    expect(event).toMatchObject({
      type: 'runbook.adopted',
      runbookId: 'team/workflow',
      runbookVersion: '1.2.0',
      source: 'fleet',
      topic: 'lean',
      approvedBy: 'operator',
      sessions: [
        { codename: 'manager', role: 'engineering-manager' },
        { codename: 'reviewer', role: 'gate-reviewer' },
      ],
    });
    if (event?.type !== 'runbook.adopted') throw new Error('missing adoption event');
    expect(reply).toContain(event.adoptionId);
    expect(store.getRunbookAdoption(event.adoptionId)).toMatchObject({
      adoptionId: event.adoptionId,
      status: 'active',
      runbookId: 'team/workflow',
      version: '1.2.0',
    });
  });

  it('rejects coordinates and assignments that are not current catalog facts', () => {
    expect(() => adoptions.adopt({ runbookId: 'team/missing', version: '1.0.0', topic: 'overview' })).toThrow(
      'not installed and valid',
    );
    expect(() => adoptions.adopt({ runbookId: 'team/workflow', version: '1.1.0', topic: 'lean' })).toThrow(
      'installed at version 1.2.0',
    );
    expect(() => adoptions.adopt({ runbookId: 'team/workflow', version: '1.2.0', topic: 'missing' })).toThrow(
      "has no topic 'missing'",
    );
    expect(() =>
      adoptions.adopt({
        runbookId: 'team/workflow',
        version: '1.2.0',
        topic: 'lean',
        sessions: ['ghost=worker'],
      }),
    ).toThrow('Unknown session: ghost');
    expect(() =>
      adoptions.adopt({
        runbookId: 'team/workflow',
        version: '1.2.0',
        topic: 'lean',
        sessions: ['manager'],
      }),
    ).toThrow('codename=role');
  });

  it('preserves stable ids and roles through a supersede chain, then ends only the active record', () => {
    adoptions.adopt({
      runbookId: 'team/workflow',
      version: '1.2.0',
      topic: 'lean',
      sessions: ['manager=manager'],
    });
    const firstEvent = events.events[0];
    if (firstEvent?.type !== 'runbook.adopted') throw new Error('missing first adoption');

    const reply = adoptions.supersede({
      adoptionId: firstEvent.adoptionId,
      runbookId: 'team/replacement',
      version: '2.0.0',
      topic: 'overview',
    });
    const superseded = events.events[1];
    if (superseded?.type !== 'runbook.superseded') throw new Error('missing supersede event');
    expect(superseded.adoptionId).toBe(firstEvent.adoptionId);
    expect(superseded.replacementAdoptionId).not.toBe(firstEvent.adoptionId);
    expect(reply).toContain(superseded.replacementAdoptionId);
    expect(store.getRunbookAdoption(firstEvent.adoptionId)).toMatchObject({
      status: 'superseded',
      supersededBy: superseded.replacementAdoptionId,
    });
    expect(store.getRunbookAdoption(superseded.replacementAdoptionId)).toMatchObject({
      status: 'active',
      sessionRoles: [{ codename: 'manager', role: 'manager' }],
    });
    expect(() => adoptions.end(firstEvent.adoptionId)).toThrow('superseded, not active');

    expect(adoptions.end(superseded.replacementAdoptionId)).toContain(superseded.replacementAdoptionId);
    expect(store.getRunbookAdoption(superseded.replacementAdoptionId)?.status).toBe('ended');
    expect(events.events.at(-1)).toEqual({
      type: 'runbook.adoption.ended',
      adoptionId: superseded.replacementAdoptionId,
      approvedBy: 'operator',
    });
    expect(() => adoptions.end(superseded.replacementAdoptionId)).toThrow('ended, not active');
  });
});

function writeBundle(root: string, id: string, version: string, topics: readonly string[]): void {
  mkdirSync(root, { recursive: true });
  for (const topic of topics) writeFileSync(join(root, `${topic}.md`), `# ${topic}\n`);
  writeFileSync(
    join(root, 'runbook.yaml'),
    yaml.dump({
      schemaVersion: 1,
      id,
      name: id,
      version,
      summary: 'Test workflow.',
      requires: { conductor: '>=0.1.0' },
      topics: topics.map((topic) => ({ id: topic, title: topic, summary: `${topic} topic.`, path: `${topic}.md` })),
      resources: [],
    }),
  );
}
