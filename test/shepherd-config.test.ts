import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { loadShepherdConfig, parseShepherdConfig } from '../src/shepherd/config.js';
import { repositoryInScope } from '../src/shepherd/scope.js';

describe('PR Shepherd V2 configuration', () => {
  it('uses safe defaults while keeping authored PR discovery enabled', () => {
    const config = parseShepherdConfig({ version: 2, profile: { githubUser: 'octocat' } });
    expect(config.features.authoredPRs.enabled).toBe(true);
    expect(config.features.reviewInbox.enabled).toBe(false);
    expect(config.automation).toEqual({ autoMerge: 'notify', branchUpdate: 'notify', reviewerComment: 'notify' });
    expect(config.delivery).toEqual({ type: 'stdout' });
    expect(config.github.mergeMethod).toBe('squash');
  });

  it('rejects unknown keys, guidance event names, remote endpoints, and invalid timezones', () => {
    expect(() => parseShepherdConfig({ version: 2, profile: { githubUser: 'octocat' }, surprise: true })).toThrow(
      /Unrecognized key/,
    );
    expect(() =>
      parseShepherdConfig({
        version: 2,
        profile: { githubUser: 'octocat' },
        guidance: { invented: 'do something' },
      }),
    ).toThrow();
    expect(() =>
      parseShepherdConfig({
        version: 2,
        profile: { githubUser: 'octocat' },
        delivery: { type: 'conductor', endpoint: 'https://example.com', coordinatorSession: 'coord' },
      }),
    ).toThrow(/localhost/);
    expect(() =>
      parseShepherdConfig({
        version: 2,
        profile: { githubUser: 'octocat' },
        features: { reviewerNudge: { timezone: 'Mars/Olympus' } },
      }),
    ).toThrow(/Invalid IANA timezone/);
  });

  it('accepts IPv4 and IPv6 loopback Conductor endpoints', () => {
    for (const endpoint of ['http://127.0.0.1:3000', 'http://[::1]:3000']) {
      expect(
        parseShepherdConfig({
          version: 2,
          profile: { githubUser: 'octocat' },
          delivery: { type: 'conductor', endpoint, coordinatorSession: 'coord' },
        }).delivery,
      ).toMatchObject({ type: 'conductor', endpoint });
    }
  });

  it('lets CLI-style overrides win and validates a complete enterprise-equivalent fixture', () => {
    const fixture = yaml.load(
      readFileSync(join(import.meta.dirname, 'fixtures', 'pr-shepherd-enterprise-equivalent.yaml'), 'utf8'),
    );
    const config = parseShepherdConfig(fixture, {
      githubUser: 'ian',
      coordinatorSession: 'coordinator',
      conductorEndpoint: 'http://localhost:4000',
    });
    expect(config.profile.githubUser).toBe('ian');
    expect(config.github).toMatchObject({
      includeOwners: ['example-enterprise'],
      mode: 'merge-queue',
      mergeMethod: 'squash',
    });
    expect(config.reviews).toMatchObject({
      ignoredActors: ['github-actions[bot]', 'vercel[bot]'],
      bots: [{ username: 'quality-reviewer[bot]', inboxGate: true, maxFeedbackAttempts: 2 }],
    });
    expect(config.features).toMatchObject({
      reviewInbox: { enabled: true, ignoreDrafts: true },
      reviewFollowUp: { enabled: true },
      reviewerNudge: { enabled: true, maxEscalations: null },
      staleThresholdHours: 24,
    });
    expect(config.delivery).toEqual({
      type: 'conductor',
      endpoint: 'http://localhost:4000',
      coordinatorSession: 'coordinator',
    });
  });

  it('does not let conductor field overrides turn a stdout shadow profile into live delivery', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-config-'));
    const path = join(dir, 'shadow.yaml');
    writeFileSync(path, 'version: 2\nprofile:\n  githubUser: octocat\ndelivery:\n  type: stdout\n');
    try {
      const config = loadShepherdConfig(
        path,
        {},
        {
          PR_SHEPHERD_COORDINATOR_SESSION: 'coord',
          PR_SHEPHERD_CONDUCTOR_ENDPOINT: 'http://127.0.0.1:3000',
        },
      );
      expect(config.delivery).toEqual({ type: 'stdout' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies include and exclude rules case-insensitively', () => {
    const config = parseShepherdConfig({
      version: 2,
      profile: { githubUser: 'octocat' },
      github: { includeOwners: ['Acme'], includeRepos: ['special/repo'], excludeRepos: ['acme/private'] },
    });
    expect(repositoryInScope('acme/api', config.github)).toBe(true);
    expect(repositoryInScope('SPECIAL/REPO', config.github)).toBe(true);
    expect(repositoryInScope('acme/private', config.github)).toBe(false);
    expect(repositoryInScope('other/repo', config.github)).toBe(false);
  });
});
