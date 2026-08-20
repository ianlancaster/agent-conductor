import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { assertShepherdProfileReady, loadShepherdConfig, parseShepherdConfig } from '../src/shepherd/config.js';
import { repositoryInScope } from '../src/shepherd/scope.js';

describe('PR Shepherd V2 configuration', () => {
  it('uses safe defaults while keeping authored PR discovery enabled', () => {
    const config = parseShepherdConfig({ version: 2, profile: { githubUser: 'octocat' } });
    expect(config.features.authoredPRs.enabled).toBe(true);
    expect(config.features.trackedPRs.enabled).toBe(false);
    expect(config.features.trackedPRs.releaseGate).toBe('none');
    expect(config.features.trackedPRs.selectors).toEqual([]);
    expect(config.features.reviewInbox.enabled).toBe(false);
    expect(config.features.reviewInbox.ignoredHeadPatterns).toEqual([]);
    expect(config.automation).toEqual({ autoMerge: 'notify', branchUpdate: 'notify', reviewerComment: 'notify' });
    expect(config.delivery).toEqual({ type: 'stdout' });
    expect(config.github.mergeMethod).toBe('squash');
  });

  it('keeps the exact-head gate inert by default and validates generic tracked selectors', () => {
    expect(
      parseShepherdConfig({
        version: 2,
        profile: { githubUser: 'octocat' },
        features: { trackedPRs: { enabled: true } },
      }).features.trackedPRs,
    ).toEqual({ enabled: true, releaseGate: 'none', selectors: [] });
    expect(
      parseShepherdConfig({
        version: 2,
        profile: { githubUser: 'octocat' },
        features: { trackedPRs: { enabled: true, releaseGate: 'exact-head-attestation' } },
      }).features.trackedPRs,
    ).toEqual({ enabled: true, releaseGate: 'exact-head-attestation', selectors: [] });
    expect(
      parseShepherdConfig({
        version: 2,
        profile: { githubUser: 'octocat' },
        features: {
          trackedPRs: {
            enabled: true,
            selectors: [
              { id: 'generated-branch', type: 'head-prefix', values: ['generated/'] },
              { id: 'stewardship-label', type: 'label', values: ['stewardship'] },
            ],
          },
        },
      }).features.trackedPRs.selectors,
    ).toHaveLength(2);
    expect(() =>
      parseShepherdConfig({
        version: 2,
        profile: { githubUser: 'octocat' },
        features: {
          trackedPRs: {
            enabled: true,
            selectors: [
              { id: 'same', type: 'head-prefix', values: ['one/'] },
              { id: 'same', type: 'label', values: ['two'] },
            ],
          },
        },
      }),
    ).toThrow(/Duplicate tracked pull-request selector id/);
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

  it('validates each ignored review-inbox head pattern at its exact field index', () => {
    const valid = parseShepherdConfig({
      version: 2,
      profile: { githubUser: 'octocat' },
      features: { reviewInbox: { ignoredHeadPatterns: ['^abby/', 'release/'] } },
    });
    expect(valid.features.reviewInbox.ignoredHeadPatterns).toEqual(['^abby/', 'release/']);

    let failure: unknown;
    try {
      parseShepherdConfig({
        version: 2,
        profile: { githubUser: 'octocat' },
        features: { reviewInbox: { ignoredHeadPatterns: ['^valid/', '[broken'] } },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ZodError);
    const issue = (failure as ZodError).issues.find(
      (candidate) => candidate.path.join('.') === 'features.reviewInbox.ignoredHeadPatterns.1',
    );
    expect(issue?.message).toContain('Invalid regular expression');
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

  it('resolves databasePath relative to the profile for modern and legacy fleet layouts', () => {
    for (const configDir of ['.conductor/config', 'config']) {
      const dir = mkdtempSync(join(tmpdir(), 'shepherd-profile-'));
      const actual = join(dir, configDir, 'pr-shepherd.yaml');
      mkdirSync(join(dir, configDir), { recursive: true });
      writeFileSync(actual, 'version: 2\nprofile:\n  githubUser: octocat\ndatabasePath: ../data/pr-shepherd-v2.db\n');
      try {
        expect(loadShepherdConfig(actual).databasePath).toBe(join(dir, configDir, '..', 'data', 'pr-shepherd-v2.db'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('validates the generated placeholder structurally but refuses to use it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-profile-'));
    const path = join(dir, 'profile.yaml');
    writeFileSync(
      path,
      '# agent-conductor-pr-shepherd-scaffold: identity-required\nversion: 2\nprofile:\n  githubUser: CHANGE_ME\n',
    );
    try {
      expect(loadShepherdConfig(path).profile.githubUser).toBe('CHANGE_ME');
      expect(() => assertShepherdProfileReady(path)).toThrow('Set profile.githubUser');
      writeFileSync(path, 'version: 2\nprofile:\n  githubUser: CHANGE_ME\n');
      expect(() => assertShepherdProfileReady(path)).toThrow('Set profile.githubUser');
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
