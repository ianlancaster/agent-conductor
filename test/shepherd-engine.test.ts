import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseShepherdConfig, type ShepherdConfig } from '../src/shepherd/config.js';
import { TrackedPullRequestControl } from '../src/shepherd/control.js';
import { ShepherdEngine } from '../src/shepherd/engine.js';
import { SqliteShepherdStore } from '../src/shepherd/store.js';
import type {
  DiscoveryKind,
  DiscoveryResult,
  GitHubMutation,
  GitHubProvider,
  PullRequestDetails,
  PullRequestRef,
  PullRequestSummary,
  ReviewThread,
} from '../src/shepherd/types.js';

class FakeGitHub implements GitHubProvider {
  readonly discoveries = new Map<DiscoveryKind, DiscoveryResult<PullRequestSummary>>();
  readonly details = new Map<string, PullRequestDetails>();
  readonly mutations: GitHubMutation[] = [];
  mutationError: Error | undefined;
  discoverCalls = 0;
  readonly getCalls: PullRequestRef[] = [];

  async discover(kind: DiscoveryKind): Promise<DiscoveryResult<PullRequestSummary>> {
    this.discoverCalls += 1;
    return this.discoveries.get(kind) ?? { items: [], exhaustive: true };
  }

  async getPullRequest(pr: PullRequestRef): Promise<PullRequestDetails> {
    this.getCalls.push(structuredClone(pr));
    const details = this.details.get(`${pr.repo}#${String(pr.number)}`);
    if (details === undefined) throw new Error(`missing ${pr.repo}#${String(pr.number)}`);
    return structuredClone(details);
  }

  async mutate(mutation: GitHubMutation): Promise<void> {
    if (this.mutationError !== undefined) throw this.mutationError;
    this.mutations.push(mutation);
  }
}

function pr(overrides: Partial<PullRequestDetails> = {}): PullRequestDetails {
  return {
    repo: 'acme/api',
    number: 7,
    title: 'Improve API',
    url: 'https://github.com/acme/api/pull/7',
    isDraft: false,
    updatedAt: '2026-07-20T10:00:00.000Z',
    state: 'OPEN',
    headSha: 'head-a',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    autoMergeRequest: null,
    mergedAt: null,
    closedAt: null,
    checks: [],
    reviews: [],
    reviewThreads: [],
    requestedReviewers: [],
    comments: [],
    commits: [{ sha: 'head-a', committedAt: '2026-07-20T09:00:00.000Z', message: 'initial' }],
    ...overrides,
  };
}

function config(input: Record<string, unknown> = {}): ShepherdConfig {
  return parseShepherdConfig({
    version: 2,
    profile: { githubUser: 'octocat' },
    features: { staleThresholdHours: 24 },
    delivery: { type: 'conductor', endpoint: 'http://localhost:3000', coordinatorSession: 'coord' },
    ...input,
  });
}

function reviewThread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 'thread-1',
    rootCommentId: 'root-1',
    reviewId: 'review-comment',
    rootAuthor: 'octocat',
    path: 'src/api.ts',
    originalLine: 10,
    originalSide: 'RIGHT',
    currentLine: 12,
    currentSide: 'RIGHT',
    url: 'https://github.com/acme/api/pull/7#discussion_r1',
    isOutdated: false,
    isResolved: false,
    comments: [
      {
        id: 'root-1',
        author: 'octocat',
        body: 'Please preserve the API contract.',
        createdAt: '2026-07-20T09:30:00Z',
        updatedAt: '2026-07-20T09:30:00Z',
        url: 'https://github.com/acme/api/pull/7#discussion_r1',
      },
    ],
    ...overrides,
  };
}

const commentedReview = {
  id: 'review-comment',
  author: 'octocat',
  state: 'COMMENTED' as const,
  body: '',
  submittedAt: '2026-07-20T09:30:00Z',
  commitSha: 'head-a',
};

function setDiscovery(github: FakeGitHub, kind: DiscoveryKind, details: PullRequestDetails, exhaustive = true): void {
  github.details.set(`${details.repo}#${String(details.number)}`, details);
  github.discoveries.set(kind, { items: [details], exhaustive });
}

describe('Shepherd engine', () => {
  it('coalesces overlapping poll requests into one serialized cycle', async () => {
    const github = new FakeGitHub();
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(config(), github, store);
    const first = engine.pollOnce();
    const overlapping = engine.pollOnce();
    expect(overlapping).toBe(first);
    await Promise.all([first, overlapping]);
    expect(github.discoverCalls).toBe(1);
    store.close();
  });

  it('polls a durable manual claim without authored discovery or review assignment', async () => {
    const github = new FakeGitHub();
    const initial = pr();
    github.details.set('acme/api#7', initial);
    const store = new SqliteShepherdStore(':memory:');
    const resolved = config({
      features: { authoredPRs: { enabled: false }, trackedPRs: { enabled: true }, staleThresholdHours: 24 },
    });
    const clock = () => new Date('2026-08-17T10:00:00Z');
    const control = new TrackedPullRequestControl(resolved, github, store, clock);
    await control.claim({
      repo: 'acme/api',
      number: 7,
      actor: 'operator',
      evidence: { reason: 'owned' },
      idempotencyKey: 'claim-owned-7',
    });
    const engine = new ShepherdEngine(resolved, github, store, clock);

    expect(await engine.pollOnce()).toMatchObject({ discovered: 1, emitted: 0 });
    expect(github.discoverCalls).toBe(0);
    expect(store.getTrackedPullRequest(initial)).toMatchObject({ baselinePending: false, status: 'active' });

    github.details.set(
      'acme/api#7',
      pr({
        headSha: 'head-b',
        checks: [{ id: 'failed', name: 'test', state: 'FAILURE', bucket: 'fail', workflow: 'CI' }],
        reviews: [
          {
            id: 'feedback-1',
            author: 'reviewer',
            state: 'CHANGES_REQUESTED',
            body: 'Please preserve the existing contract.',
            submittedAt: '2026-08-17T10:05:00Z',
          },
        ],
        comments: [
          {
            id: 'comment-1',
            author: 'stakeholder',
            body: 'This comment is intentionally long enough to be actionable to the coordinator.',
            createdAt: '2026-08-17T10:06:00Z',
          },
        ],
      }),
    );
    expect(await engine.pollOnce()).toMatchObject({ discovered: 1, emitted: 4 });
    expect(store.listEvents().map((event) => event.type)).toEqual(
      expect.arrayContaining(['tracked-pr-claimed', 'head-changed', 'ci-failed', 'review-feedback', 'comment']),
    );
    expect(
      control.unclaim({
        repo: 'acme/api',
        number: 7,
        actor: 'operator',
        evidence: { reason: 'complete' },
        idempotencyKey: 'unclaim-owned-7',
      }),
    ).toMatchObject({ outcome: 'unclaimed' });
    expect(store.listEntities('authored')).toEqual([]);
    store.close();
  });

  it('deduplicates a claimed PR that also appears in authored discovery', async () => {
    const github = new FakeGitHub();
    const details = pr();
    setDiscovery(github, 'authored', details);
    const store = new SqliteShepherdStore(':memory:');
    const resolved = config({ features: { trackedPRs: { enabled: true }, staleThresholdHours: 24 } });
    await new TrackedPullRequestControl(resolved, github, store).claim({
      repo: details.repo,
      number: details.number,
      actor: 'operator',
      evidence: {},
      idempotencyKey: 'claim-overlap',
    });
    github.getCalls.length = 0;

    expect(await new ShepherdEngine(resolved, github, store).pollOnce()).toMatchObject({ discovered: 1 });
    expect(github.getCalls).toHaveLength(1);
    expect(store.listEntities('authored')).toHaveLength(1);
    expect(
      new TrackedPullRequestControl(resolved, github, store).unclaim({
        repo: details.repo,
        number: details.number,
        actor: 'operator',
        evidence: {},
        idempotencyKey: 'unclaim-overlap',
      }),
    ).toMatchObject({ outcome: 'unclaimed' });
    expect(store.listEntities('authored')).toHaveLength(1);
    store.close();
  });

  it('keeps tracked-only merge execution inert until an exact-head release gate exists', async () => {
    const github = new FakeGitHub();
    const details = pr();
    github.details.set('acme/api#7', details);
    const store = new SqliteShepherdStore(':memory:');
    const resolved = config({
      features: { authoredPRs: { enabled: false }, trackedPRs: { enabled: true }, staleThresholdHours: 24 },
      automation: { autoMerge: 'execute' },
    });
    await new TrackedPullRequestControl(resolved, github, store).claim({
      repo: details.repo,
      number: details.number,
      actor: 'operator',
      evidence: {},
      idempotencyKey: 'claim-inert-execute',
    });
    const engine = new ShepherdEngine(resolved, github, store);
    await engine.pollOnce();
    github.details.set(
      'acme/api#7',
      pr({
        reviews: [
          {
            id: 'approval',
            author: 'reviewer',
            state: 'APPROVED',
            body: '',
            submittedAt: '2026-08-17T10:00:00Z',
          },
        ],
      }),
    );

    await engine.pollOnce();
    expect(github.mutations).toEqual([]);
    expect(store.listEntities('action')).toEqual([]);
    expect(store.listEvents().find((event) => event.type === 'auto-merge-decision')?.source.mode).toBe('notify');
    store.close();
  });

  it('marks a merged claim terminal and cleans its live lifecycle state across restart', async () => {
    const github = new FakeGitHub();
    const details = pr();
    github.details.set('acme/api#7', details);
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-tracked-engine-'));
    const path = join(dir, 'shepherd.db');
    try {
      const resolved = config({
        features: { authoredPRs: { enabled: false }, trackedPRs: { enabled: true }, staleThresholdHours: 24 },
      });
      const first = new SqliteShepherdStore(path);
      await new TrackedPullRequestControl(resolved, github, first).claim({
        repo: details.repo,
        number: details.number,
        actor: 'operator',
        evidence: {},
        idempotencyKey: 'claim-terminal',
      });
      const engine = new ShepherdEngine(resolved, github, first);
      await engine.pollOnce();
      github.details.set(
        'acme/api#7',
        pr({ state: 'MERGED', mergedAt: '2026-08-17T11:00:00Z', updatedAt: '2026-08-17T11:00:00Z' }),
      );
      expect(await engine.pollOnce()).toMatchObject({ emitted: 1 });
      expect(first.listEntities('authored')).toEqual([]);
      expect(first.getTrackedPullRequest(details)).toMatchObject({ status: 'terminal', terminalState: 'MERGED' });
      first.close();

      const reopened = new SqliteShepherdStore(path);
      github.getCalls.length = 0;
      expect(await new ShepherdEngine(resolved, github, reopened).pollOnce()).toMatchObject({
        discovered: 0,
        emitted: 0,
      });
      expect(github.getCalls).toEqual([]);
      expect(reopened.listEvents().filter((event) => event.type === 'merged')).toHaveLength(1);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('atomically emits current failures and bot findings once', async () => {
    const github = new FakeGitHub();
    const details = pr({
      checks: [{ id: 'check-1', name: 'test', state: 'FAILURE', bucket: 'fail', workflow: 'CI' }],
      comments: [
        {
          id: 'comment-1',
          author: 'quality-bot',
          body: 'Finding: broken contract',
          createdAt: '2026-07-20T09:30:00Z',
        },
      ],
    });
    setDiscovery(github, 'authored', details);
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(
      config({
        reviews: { bots: [{ username: 'quality-bot', actionablePatterns: ['Finding:'] }] },
      }),
      github,
      store,
      () => new Date('2026-07-20T10:00:00Z'),
    );

    expect(await engine.pollOnce()).toMatchObject({ emitted: 2 });
    expect(
      store
        .listEvents()
        .map((event) => event.type)
        .sort(),
    ).toEqual(['bot-findings', 'ci-failed']);
    expect(store.listOutbox()).toHaveLength(2);
    expect(await engine.pollOnce()).toMatchObject({ emitted: 0 });
    expect(store.listEvents()).toHaveLength(2);
    store.close();
  });

  it('deduplicates a failing check rerun by stable check name at the same head', async () => {
    const github = new FakeGitHub();
    const first = pr({
      checks: [{ id: 'run-1', name: 'test', state: 'FAILURE', bucket: 'fail', workflow: 'CI' }],
    });
    setDiscovery(github, 'authored', first);
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(config(), github, store, () => new Date('2026-07-20T10:00:00Z'));
    await engine.pollOnce();

    setDiscovery(
      github,
      'authored',
      pr({ checks: [{ ...first.checks[0]!, id: 'run-2', state: 'FAILURE', bucket: 'fail' }] }),
    );

    expect(await engine.pollOnce()).toMatchObject({ emitted: 0 });
    expect(store.listEvents().filter((event) => event.type === 'ci-failed')).toHaveLength(1);
    store.close();
  });

  it('records a stable auto-merge decision before executing the configured mutation', async () => {
    const github = new FakeGitHub();
    setDiscovery(
      github,
      'authored',
      pr({
        reviews: [
          {
            id: 'review-1',
            author: 'reviewer',
            state: 'APPROVED',
            body: 'Looks good with a small note to consider.',
            submittedAt: '2026-07-20T09:30:00Z',
          },
        ],
      }),
    );
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(
      config({ automation: { autoMerge: 'execute' } }),
      github,
      store,
      () => new Date('2026-07-20T10:00:00Z'),
    );

    expect(await engine.pollOnce()).toMatchObject({ emitted: 2, mutations: 1 });
    expect(
      store
        .listEvents()
        .map((event) => event.type)
        .sort(),
    ).toEqual(['approved', 'auto-merge-decision']);
    expect(github.mutations).toEqual([
      { type: 'enable-auto-merge', pr: { repo: 'acme/api', number: 7 }, mergeMethod: 'squash' },
    ]);
    await engine.pollOnce();
    expect(github.mutations).toHaveLength(1);
    store.close();
  });

  it('waits for relevant checks to pass before approving or enabling auto-merge', async () => {
    const github = new FakeGitHub();
    const review = {
      id: 'review-1',
      author: 'reviewer',
      state: 'APPROVED' as const,
      body: 'Looks good',
      submittedAt: '2026-07-20T09:30:00Z',
    };
    const failing = pr({
      checks: [{ id: 'check-1', name: 'test', state: 'FAILURE', bucket: 'fail', workflow: 'CI' }],
      reviews: [review],
    });
    setDiscovery(github, 'authored', failing);
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(
      config({ automation: { autoMerge: 'execute' } }),
      github,
      store,
      () => new Date('2026-07-20T10:00:00Z'),
    );

    await engine.pollOnce();
    expect(store.listEvents().map((event) => event.type)).toEqual(['ci-failed']);
    expect(github.mutations).toEqual([]);

    setDiscovery(
      github,
      'authored',
      pr({ checks: [{ ...failing.checks[0]!, state: 'SUCCESS', bucket: 'pass' }], reviews: [review] }),
    );
    await engine.pollOnce();
    expect(
      store
        .listEvents()
        .map((event) => event.type)
        .sort(),
    ).toEqual(['approved', 'auto-merge-decision', 'ci-failed']);
    expect(github.mutations).toHaveLength(1);
    store.close();
  });

  it('never evicts live state after a non-exhaustive discovery cycle', async () => {
    const github = new FakeGitHub();
    const details = pr();
    setDiscovery(github, 'authored', details);
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(config(), github, store, () => new Date('2026-07-20T10:00:00Z'));
    await engine.pollOnce();
    github.discoveries.set('authored', { items: [], exhaustive: false, warning: '51/50 results returned' });
    await engine.pollOnce();
    expect(store.listEntities('authored')).toHaveLength(1);
    store.close();
  });

  it('isolates a malformed PR without starving later items in the feature', async () => {
    const github = new FakeGitHub();
    const missing = pr({ number: 6, title: 'Malformed upstream result' });
    const healthy = pr({
      number: 7,
      checks: [{ id: 'check-1', name: 'test', state: 'FAILURE', bucket: 'fail', workflow: 'CI' }],
    });
    github.discoveries.set('authored', { items: [missing, healthy], exhaustive: true });
    github.details.set(`${healthy.repo}#${String(healthy.number)}`, healthy);
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(config(), github, store, () => new Date('2026-07-20T10:00:00Z'));

    const result = await engine.pollOnce();

    expect(result).toMatchObject({ discovered: 2, emitted: 1 });
    expect(result.warnings[0]).toContain('acme/api#6');
    expect(store.listEvents().map((event) => event.type)).toEqual(['ci-failed']);
    store.close();
  });

  it('records a baseline without replaying unchanged stale conditions', async () => {
    const github = new FakeGitHub();
    setDiscovery(github, 'authored', pr({ updatedAt: '2026-07-18T10:00:00Z' }));
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(
      config({ polling: { bootstrap: 'baseline-only' } }),
      github,
      store,
      () => new Date('2026-07-20T10:00:00Z'),
    );
    expect(await engine.pollOnce()).toMatchObject({ emitted: 0 });
    expect(await engine.pollOnce()).toMatchObject({ emitted: 0 });
    store.close();
  });

  it('resets stale recurrence after fresh PR activity', async () => {
    let now = new Date('2026-07-20T10:00:00Z');
    const github = new FakeGitHub();
    setDiscovery(github, 'authored', pr({ updatedAt: '2026-07-18T10:00:00Z' }));
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(config(), github, store, () => now);

    await engine.pollOnce();
    expect(store.listEvents().filter((event) => event.type === 'stale')).toHaveLength(1);

    setDiscovery(github, 'authored', pr({ updatedAt: now.toISOString() }));
    await engine.pollOnce();
    now = new Date('2026-07-21T11:00:00Z');
    await engine.pollOnce();

    const stale = store.listEvents().filter((event) => event.type === 'stale');
    expect(stale).toHaveLength(2);
    expect(new Set(stale.map((event) => event.id)).size).toBe(2);
    store.close();
  });

  it('does not create reviewer-comment decisions when reviewer nudges are disabled', async () => {
    const github = new FakeGitHub();
    const initial = pr({
      reviews: [
        {
          id: 'changes',
          author: 'reviewer',
          state: 'CHANGES_REQUESTED',
          body: 'Fix it',
          submittedAt: '2026-07-20T09:00:00Z',
        },
      ],
    });
    setDiscovery(github, 'authored', initial);
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(config(), github, store, () => new Date('2026-07-20T10:00:00Z'));
    await engine.pollOnce();

    setDiscovery(github, 'authored', pr({ ...initial, headSha: 'head-b' }));
    await engine.pollOnce();

    expect(store.listEvents().some((event) => event.type === 'reviewer-comment-decision')).toBe(false);
    expect(store.listEntities('nudge')).toEqual([]);
    store.close();
  });

  it('uses positive bot patterns to complete inbox work without dispatching a human', async () => {
    const github = new FakeGitHub();
    const details = pr({
      comments: [
        {
          id: 'bot-1',
          author: 'quality-bot',
          body: 'No findings; approved',
          createdAt: '2026-07-20T09:30:00Z',
        },
      ],
    });
    setDiscovery(github, 'review-inbox', details);
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(
      config({
        reviews: {
          bots: [
            {
              username: 'quality-bot',
              inboxGate: true,
              positivePatterns: ['approved'],
              actionablePatterns: ['Finding:'],
            },
          ],
        },
        features: { authoredPRs: { enabled: false }, reviewInbox: { enabled: true }, staleThresholdHours: 24 },
      }),
      github,
      store,
      () => new Date('2026-07-20T10:00:00Z'),
    );
    await engine.pollOnce();
    expect(store.listEvents().map((event) => event.type)).toEqual(['review-completed']);

    github.discoveries.set('review-inbox', { items: [], exhaustive: true });
    expect(await engine.pollOnce()).toMatchObject({ emitted: 0 });
    const completed = store.listEvents().filter((event) => event.type === 'review-completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]?.source.outcome).toBe('bot-auto-approved');
    expect(store.listOutbox()).toHaveLength(1);
    expect(store.listEntities('review-inbox')).toEqual([]);
    store.close();
  });

  it('labels a genuinely ended review assignment without duplicating a prior completion', async () => {
    const github = new FakeGitHub();
    const details = pr();
    setDiscovery(github, 'review-inbox', details);
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(
      config({
        features: { authoredPRs: { enabled: false }, reviewInbox: { enabled: true }, staleThresholdHours: 24 },
      }),
      github,
      store,
      () => new Date('2026-07-20T10:00:00Z'),
    );

    await engine.pollOnce();
    github.discoveries.set('review-inbox', { items: [], exhaustive: true });
    expect(await engine.pollOnce()).toMatchObject({ emitted: 1 });

    const completion = store.listEvents().find((event) => event.type === 'review-completed');
    expect(completion?.source).toMatchObject({
      headSha: details.headSha,
      requestUpdatedAt: details.updatedAt,
      outcome: 'assignment-ended',
    });
    expect(completion?.message).toContain('outcome: assignment-ended');
    store.close();
  });

  it('keeps tracking an existing review assignment when the PR later becomes draft', async () => {
    const github = new FakeGitHub();
    const details = pr();
    setDiscovery(github, 'review-inbox', details);
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(
      config({
        features: { authoredPRs: { enabled: false }, reviewInbox: { enabled: true }, staleThresholdHours: 24 },
      }),
      github,
      store,
      () => new Date('2026-07-20T10:00:00Z'),
    );
    await engine.pollOnce();
    const eventCount = store.listEvents().length;

    setDiscovery(github, 'review-inbox', pr({ isDraft: true }));
    await engine.pollOnce();

    expect(store.listEntities('review-inbox')).toHaveLength(1);
    expect(store.listEvents()).toHaveLength(eventCount);
    store.close();
  });

  it('does not request direct branch updates in merge-queue mode', async () => {
    const github = new FakeGitHub();
    setDiscovery(github, 'authored', pr({ mergeStateStatus: 'BEHIND' }));
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(
      config({ github: { mode: 'merge-queue' }, automation: { branchUpdate: 'execute' } }),
      github,
      store,
      () => new Date('2026-07-20T10:00:00Z'),
    );
    await engine.pollOnce();
    expect(store.listEvents().some((event) => event.type === 'branch-update-decision')).toBe(false);
    expect(github.mutations).toEqual([]);
    store.close();
  });

  it('enqueues a ready merge-queue PR while behind without updating its branch', async () => {
    const github = new FakeGitHub();
    setDiscovery(
      github,
      'authored',
      pr({
        mergeStateStatus: 'BEHIND',
        reviews: [
          {
            id: 'approval',
            author: 'reviewer',
            state: 'APPROVED',
            body: '',
            submittedAt: '2026-07-20T09:00:00Z',
          },
        ],
      }),
    );
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(
      config({ github: { mode: 'merge-queue' }, automation: { autoMerge: 'execute', branchUpdate: 'execute' } }),
      github,
      store,
      () => new Date('2026-07-20T10:00:00Z'),
    );
    await engine.pollOnce();
    expect(github.mutations).toEqual([
      { type: 'enable-auto-merge', pr: { repo: 'acme/api', number: 7 }, mergeMethod: 'squash' },
    ]);
    store.close();
  });

  it('updates a direct PR before auto-merge readiness and does not require auto-merge first', async () => {
    const github = new FakeGitHub();
    const behind = pr({
      mergeStateStatus: 'BEHIND',
      reviews: [
        {
          id: 'approval',
          author: 'reviewer',
          state: 'APPROVED',
          body: '',
          submittedAt: '2026-07-20T09:00:00Z',
        },
      ],
    });
    setDiscovery(github, 'authored', behind);
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(
      config({ automation: { branchUpdate: 'execute', autoMerge: 'execute' } }),
      github,
      store,
      () => new Date('2026-07-20T10:00:00Z'),
    );
    await engine.pollOnce();
    expect(github.mutations).toEqual([{ type: 'update-branch', pr: { repo: 'acme/api', number: 7 } }]);
    expect(store.listEvents().some((event) => event.type === 'auto-merge-decision')).toBe(false);
    store.close();
  });

  it('reports a behind direct branch once per head when branch updates are off', async () => {
    const github = new FakeGitHub();
    setDiscovery(github, 'authored', pr({ mergeStateStatus: 'BEHIND' }));
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(
      config({ automation: { branchUpdate: 'off' } }),
      github,
      store,
      () => new Date('2026-07-20T10:00:00Z'),
    );
    await engine.pollOnce();
    await engine.pollOnce();
    expect(github.mutations).toEqual([]);
    expect(store.listEvents().filter((event) => event.type === 'branch-behind')).toHaveLength(1);
    store.close();
  });

  it('defers BEHIND+UNKNOWN and re-evaluates when mergeability becomes known', async () => {
    const github = new FakeGitHub();
    const approval = {
      id: 'approval',
      author: 'reviewer',
      state: 'APPROVED' as const,
      body: '',
      submittedAt: '2026-07-20T09:00:00Z',
    };
    setDiscovery(github, 'authored', pr({ mergeStateStatus: 'BEHIND', mergeable: 'UNKNOWN', reviews: [approval] }));
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(
      config({ automation: { branchUpdate: 'execute', autoMerge: 'execute' } }),
      github,
      store,
      () => new Date('2026-07-20T10:00:00Z'),
    );
    await engine.pollOnce();
    expect(github.mutations).toEqual([]);
    expect(store.listEvents()).toEqual([]);

    setDiscovery(github, 'authored', pr({ mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE', reviews: [approval] }));
    await engine.pollOnce();
    expect(github.mutations).toEqual([
      { type: 'enable-auto-merge', pr: { repo: 'acme/api', number: 7 }, mergeMethod: 'squash' },
    ]);
    store.close();
  });

  it('reports CONFLICTING and blocks enqueue even with approvals and green checks', async () => {
    const github = new FakeGitHub();
    setDiscovery(
      github,
      'authored',
      pr({
        mergeable: 'CONFLICTING',
        reviews: [
          {
            id: 'approval',
            author: 'reviewer',
            state: 'APPROVED',
            body: '',
            submittedAt: '2026-07-20T09:00:00Z',
          },
        ],
      }),
    );
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(
      config({ github: { mode: 'merge-queue' }, automation: { autoMerge: 'execute' } }),
      github,
      store,
      () => new Date('2026-07-20T10:00:00Z'),
    );
    await engine.pollOnce();
    expect(github.mutations).toEqual([]);
    expect(store.listEvents().map((event) => event.type)).toEqual(['conflict']);
    store.close();
  });

  it('cancels a failed enqueue retry when the PR becomes conflicting', async () => {
    let now = new Date('2026-07-20T10:00:00Z');
    const github = new FakeGitHub();
    const approval = {
      id: 'approval',
      author: 'reviewer',
      state: 'APPROVED' as const,
      body: '',
      submittedAt: '2026-07-20T09:00:00Z',
    };
    setDiscovery(github, 'authored', pr({ reviews: [approval] }));
    github.mutationError = new Error('temporary queue rejection');
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(
      config({ github: { mode: 'merge-queue' }, automation: { autoMerge: 'execute' } }),
      github,
      store,
      () => now,
    );
    await engine.pollOnce();

    github.mutationError = undefined;
    now = new Date(now.getTime() + 10_000);
    setDiscovery(github, 'authored', pr({ mergeable: 'CONFLICTING', reviews: [approval] }));
    await engine.pollOnce();

    expect(github.mutations).toEqual([]);
    expect(store.listEntities<{ status: string }>('action')[0]?.value.status).toBe('cancelled');
    expect(store.listEvents().some((event) => event.type === 'conflict')).toBe(true);
    store.close();
  });

  it('parks a repeatedly failing branch update and emits one failure fact', async () => {
    let now = new Date('2026-07-20T10:00:00Z');
    const github = new FakeGitHub();
    github.mutationError = new Error('update rejected');
    setDiscovery(github, 'authored', pr({ mergeStateStatus: 'BEHIND' }));
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(config({ automation: { branchUpdate: 'execute' } }), github, store, () => now);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await engine.pollOnce();
      now = new Date(now.getTime() + 10 * 60_000);
    }
    expect(store.listEvents().filter((event) => event.type === 'branch-update-failed')).toHaveLength(1);
    expect(store.listEntities<{ status: string }>('action')[0]?.value.status).toBe('failed');
    store.close();
  });

  it('cancels persisted mutations that are no longer inside configured scope', async () => {
    const github = new FakeGitHub();
    const store = new SqliteShepherdStore(':memory:');
    store.commit(
      [
        {
          key: 'action:outside',
          kind: 'action',
          value: {
            status: 'pending',
            mutation: { type: 'update-branch', pr: { repo: 'acme/api', number: 7 } },
          },
        },
      ],
      [],
    );
    const engine = new ShepherdEngine(
      config({ github: { includeOwners: ['approved-owner'] } }),
      github,
      store,
      () => new Date('2026-07-20T10:00:00Z'),
    );

    expect(await engine.drainActions()).toBe(0);
    expect(github.mutations).toEqual([]);
    expect(store.getEntity<{ status: string }>('action:outside')?.value.status).toBe('cancelled');
    store.close();
  });

  it('cancels a reviewer comment action superseded by a newer head', async () => {
    const github = new FakeGitHub();
    const store = new SqliteShepherdStore(':memory:');
    const nudgeKey = 'nudge:acme/api#7:reviewer';
    store.commit(
      [
        {
          key: nudgeKey,
          kind: 'nudge',
          value: {
            reviewer: 'reviewer',
            fixPushedAt: '2026-07-20T10:00:00Z',
            commentPostedAt: null,
            lastEscalatedAt: null,
            escalationCount: 0,
            details: pr({ headSha: 'head-new' }),
          },
        },
        {
          key: 'action:old-comment',
          kind: 'action',
          value: {
            status: 'pending',
            mutation: {
              type: 'post-reviewer-comment',
              pr: { repo: 'acme/api', number: 7 },
              reviewer: 'reviewer',
              body: 'old',
            },
            relatedNudgeKey: nudgeKey,
            relatedNudgeHeadSha: 'head-old',
          },
        },
      ],
      [],
    );
    const engine = new ShepherdEngine(config(), github, store);

    expect(await engine.drainActions()).toBe(0);
    expect(github.mutations).toEqual([]);
    expect(store.getEntity<{ status: string }>('action:old-comment')?.value.status).toBe('cancelled');
    store.close();
  });

  it('compares re-review heads without suppressing the first new commit', async () => {
    const github = new FakeGitHub();
    const first = pr({
      reviews: [
        {
          id: 'review-change',
          author: 'octocat',
          state: 'CHANGES_REQUESTED',
          body: 'Fix this',
          submittedAt: '2026-07-20T09:30:00Z',
        },
      ],
    });
    setDiscovery(github, 'review-follow-up', first);
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(
      config({
        features: { authoredPRs: { enabled: false }, reviewFollowUp: { enabled: true }, staleThresholdHours: 24 },
      }),
      github,
      store,
      () => new Date('2026-07-20T10:00:00Z'),
    );
    await engine.pollOnce();

    const changed = pr({
      headSha: 'head-b',
      updatedAt: '2026-07-20T11:00:00Z',
      reviews: first.reviews,
      commits: [...first.commits, { sha: 'head-b', committedAt: '2026-07-20T10:30:00Z', message: 'fix' }],
    });
    setDiscovery(github, 'review-follow-up', changed);
    expect(await engine.pollOnce()).toMatchObject({ emitted: 1 });
    expect(store.listEvents()[0]?.type).toBe('scoped-re-review');
    expect(await engine.pollOnce()).toMatchObject({ emitted: 0 });
    store.close();
  });

  it('keeps following changes requested when a later non-decisive review is posted', async () => {
    const github = new FakeGitHub();
    const first = pr({
      reviews: [
        {
          id: 'review-change',
          author: 'octocat',
          state: 'CHANGES_REQUESTED',
          body: 'Fix this',
          submittedAt: '2026-07-20T09:30:00Z',
        },
      ],
    });
    setDiscovery(github, 'review-follow-up', first);
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(
      config({
        features: { authoredPRs: { enabled: false }, reviewFollowUp: { enabled: true }, staleThresholdHours: 24 },
      }),
      github,
      store,
      () => new Date('2026-07-20T11:00:00Z'),
    );
    await engine.pollOnce();

    setDiscovery(
      github,
      'review-follow-up',
      pr({
        headSha: 'head-b',
        reviews: [
          ...first.reviews,
          {
            id: 'review-comment',
            author: 'octocat',
            state: 'COMMENTED',
            body: 'One more note',
            submittedAt: '2026-07-20T10:00:00Z',
          },
        ],
        commits: [...first.commits, { sha: 'head-b', committedAt: '2026-07-20T10:30:00Z', message: 'fix' }],
      }),
    );

    expect(await engine.pollOnce()).toMatchObject({ emitted: 1 });
    expect(store.listEvents()[0]?.type).toBe('scoped-re-review');
    store.close();
  });

  it('upgrades a persisted single-review cursor without replaying its notified head', async () => {
    const github = new FakeGitHub();
    const legacyReview = {
      id: 'octocat:2026-07-20T09:30:00Z:CHANGES_REQUESTED',
      author: 'octocat',
      state: 'CHANGES_REQUESTED' as const,
      body: 'Fix this',
      submittedAt: '2026-07-20T09:30:00Z',
    };
    const currentReview = { ...legacyReview, id: 'PRR_global' };
    const details = pr({ headSha: 'head-b', reviews: [currentReview] });
    setDiscovery(github, 'review-follow-up', details);
    const store = new SqliteShepherdStore(':memory:');
    store.commit(
      [
        {
          key: 'follow-up:acme/api#7',
          kind: 'review-follow-up',
          value: {
            reviewId: legacyReview.id,
            reviewedHeadSha: 'head-a',
            notifiedHeadSha: 'head-b',
            details: pr({ headSha: 'head-b', reviews: [legacyReview] }),
          },
        },
      ],
      [],
    );
    store.markBootstrapComplete('review-follow-up');
    const engine = new ShepherdEngine(
      config({
        features: { authoredPRs: { enabled: false }, reviewFollowUp: { enabled: true }, staleThresholdHours: 24 },
      }),
      github,
      store,
    );

    expect(await engine.pollOnce()).toMatchObject({ emitted: 0 });
    expect(store.getEntity<{ trackedReviewIds: string[] }>('follow-up:acme/api#7')?.value.trackedReviewIds).toEqual([
      'PRR_global',
    ]);
    setDiscovery(github, 'review-follow-up', pr({ headSha: 'head-c', reviews: [currentReview] }));
    expect(await engine.pollOnce()).toMatchObject({ emitted: 1 });
    store.close();
  });

  it('baselines actionable COMMENTED findings and emits once for each new head', async () => {
    const github = new FakeGitHub();
    const initial = pr({ reviews: [commentedReview], reviewThreads: [reviewThread()] });
    setDiscovery(github, 'review-follow-up', initial);
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(
      config({
        polling: { bootstrap: 'baseline-only' },
        features: { authoredPRs: { enabled: false }, reviewFollowUp: { enabled: true }, staleThresholdHours: 24 },
      }),
      github,
      store,
      () => new Date('2026-07-20T10:00:00Z'),
    );

    expect(await engine.pollOnce()).toMatchObject({ emitted: 0 });
    expect(store.listEntities('review-follow-up')).toHaveLength(1);

    const headB = pr({ headSha: 'head-b', reviews: [commentedReview], reviewThreads: [reviewThread()] });
    setDiscovery(github, 'review-follow-up', headB);
    expect(await engine.pollOnce()).toMatchObject({ emitted: 1 });
    const first = store.listEvents()[0];
    expect(first).toMatchObject({ type: 'scoped-re-review' });
    expect(first?.source).toMatchObject({
      triggeringReasons: ['head-changed'],
      activeReviewIds: ['review-comment'],
      reviewedHeadSha: 'head-a',
      currentHeadSha: 'head-b',
    });
    expect(first?.source.affectedThreads).toEqual([
      expect.objectContaining({
        threadId: 'thread-1',
        path: 'src/api.ts',
        rootFinding: 'Please preserve the API contract.',
      }),
    ]);
    expect(await engine.pollOnce()).toMatchObject({ emitted: 0 });

    setDiscovery(
      github,
      'review-follow-up',
      pr({ headSha: 'head-c', reviews: [commentedReview], reviewThreads: [reviewThread()] }),
    );
    expect(await engine.pollOnce()).toMatchObject({ emitted: 1 });
    expect(store.listEvents().filter((event) => event.type === 'scoped-re-review')).toHaveLength(2);
    store.close();
  });

  it('coalesces new thread replies while ignoring self, configured actors, and issue comments', async () => {
    const github = new FakeGitHub();
    const initial = pr({ reviews: [commentedReview], reviewThreads: [reviewThread()] });
    setDiscovery(github, 'review-follow-up', initial);
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(
      config({
        polling: { bootstrap: 'baseline-only' },
        reviews: { ignoredActors: ['automation-bot'] },
        features: { authoredPRs: { enabled: false }, reviewFollowUp: { enabled: true }, staleThresholdHours: 24 },
      }),
      github,
      store,
      () => new Date('2026-07-20T11:00:00Z'),
    );
    await engine.pollOnce();

    const selfReply = {
      id: 'reply-self',
      author: 'octocat',
      body: 'Additional reviewer context',
      createdAt: '2026-07-20T10:00:00Z',
      updatedAt: '2026-07-20T10:00:00Z',
      url: 'https://github.com/acme/api/pull/7#discussion_r2',
    };
    const ignoredReply = { ...selfReply, id: 'reply-bot', author: 'automation-bot' };
    const quiet = pr({
      reviews: [commentedReview],
      reviewThreads: [reviewThread({ comments: [...reviewThread().comments, selfReply, ignoredReply] })],
      comments: [
        { id: 'issue-comment', author: 'author', body: 'Unrelated PR comment', createdAt: '2026-07-20T10:05:00Z' },
      ],
    });
    setDiscovery(github, 'review-follow-up', quiet);
    expect(await engine.pollOnce()).toMatchObject({ emitted: 0 });

    const authorReply = { ...selfReply, id: 'reply-author', author: 'author', body: 'Fixed in the latest push.' };
    const teammateReply = { ...selfReply, id: 'reply-teammate', author: 'teammate', body: 'I verified the edge case.' };
    setDiscovery(
      github,
      'review-follow-up',
      pr({
        reviews: [commentedReview],
        reviewThreads: [
          reviewThread({ comments: [...reviewThread().comments, selfReply, ignoredReply, authorReply, teammateReply] }),
        ],
        comments: quiet.comments,
      }),
    );
    expect(await engine.pollOnce()).toMatchObject({ emitted: 1 });
    const event = store.listEvents()[0];
    expect(event?.source).toMatchObject({ triggeringReasons: ['thread-replied'] });
    expect(event?.source.affectedThreads).toEqual([
      expect.objectContaining({
        threadId: 'thread-1',
        newReplies: [
          expect.objectContaining({ id: 'reply-author', author: 'author', body: 'Fixed in the latest push.' }),
          expect.objectContaining({ id: 'reply-teammate', author: 'teammate', body: 'I verified the edge case.' }),
        ],
      }),
    ]);
    expect(store.listOutbox()).toHaveLength(1);
    expect(await engine.pollOnce()).toMatchObject({ emitted: 0 });
    expect(store.listEvents()).toHaveLength(1);
    expect(store.listOutbox()).toHaveLength(1);
    store.close();
  });

  it('coalesces thread-state and explicit re-review-request transitions recurrently', async () => {
    const github = new FakeGitHub();
    const initial = pr({ reviews: [commentedReview], reviewThreads: [reviewThread()] });
    setDiscovery(github, 'review-follow-up', initial);
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(
      config({
        polling: { bootstrap: 'baseline-only' },
        features: { authoredPRs: { enabled: false }, reviewFollowUp: { enabled: true }, staleThresholdHours: 24 },
      }),
      github,
      store,
      () => new Date('2026-07-20T11:00:00Z'),
    );
    await engine.pollOnce();

    setDiscovery(
      github,
      'review-follow-up',
      pr({
        reviews: [commentedReview],
        reviewThreads: [reviewThread({ isOutdated: true, isResolved: true })],
        requestedReviewers: [{ login: 'octocat' }],
      }),
    );
    expect(await engine.pollOnce()).toMatchObject({ emitted: 1 });
    expect(store.listEvents()[0]?.source).toMatchObject({
      triggeringReasons: ['thread-outdated', 'thread-resolved', 'review-requested'],
      reviewRequested: true,
    });
    expect(await engine.pollOnce()).toMatchObject({ emitted: 0 });

    setDiscovery(
      github,
      'review-follow-up',
      pr({ reviews: [commentedReview], reviewThreads: [reviewThread({ isOutdated: true })] }),
    );
    expect(await engine.pollOnce()).toMatchObject({ emitted: 0 });
    setDiscovery(
      github,
      'review-follow-up',
      pr({
        reviews: [commentedReview],
        reviewThreads: [reviewThread({ isOutdated: true, isResolved: true })],
        requestedReviewers: [{ login: 'OCTOCAT' }],
      }),
    );
    expect(await engine.pollOnce()).toMatchObject({ emitted: 1 });
    expect(store.listEvents()[0]?.source).toMatchObject({
      triggeringReasons: ['thread-resolved', 'review-requested'],
      reviewRequestCycle: 2,
    });
    expect(store.listEvents()).toHaveLength(2);
    store.close();
  });

  it('closes on approval or dismissal and starts a fresh lifecycle for later findings', async () => {
    const github = new FakeGitHub();
    const initial = pr({ reviews: [commentedReview], reviewThreads: [reviewThread()] });
    setDiscovery(github, 'review-follow-up', initial);
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(
      config({
        polling: { bootstrap: 'baseline-only' },
        features: { authoredPRs: { enabled: false }, reviewFollowUp: { enabled: true }, staleThresholdHours: 24 },
      }),
      github,
      store,
    );
    await engine.pollOnce();
    expect(store.listEntities('review-follow-up')).toHaveLength(1);

    const approval = {
      id: 'approval',
      author: 'octocat',
      state: 'APPROVED' as const,
      body: '',
      submittedAt: '2026-07-20T10:00:00Z',
      commitSha: 'head-a',
    };
    setDiscovery(
      github,
      'review-follow-up',
      pr({ reviews: [commentedReview, approval], reviewThreads: [reviewThread()] }),
    );
    expect(await engine.pollOnce()).toMatchObject({ emitted: 0 });
    expect(store.listEntities('review-follow-up')).toHaveLength(0);

    const laterReview = { ...commentedReview, id: 'review-later', submittedAt: '2026-07-20T11:00:00Z' };
    const laterThread = reviewThread({
      id: 'thread-later',
      rootCommentId: 'root-later',
      reviewId: 'review-later',
      comments: [
        {
          ...reviewThread().comments[0]!,
          id: 'root-later',
          body: 'A new finding after approval.',
        },
      ],
    });
    setDiscovery(
      github,
      'review-follow-up',
      pr({ reviews: [commentedReview, approval, laterReview], reviewThreads: [reviewThread(), laterThread] }),
    );
    expect(await engine.pollOnce()).toMatchObject({ emitted: 0 });
    expect(store.listEntities('review-follow-up')).toHaveLength(1);

    setDiscovery(
      github,
      'review-follow-up',
      pr({
        headSha: 'head-b',
        reviews: [commentedReview, approval, laterReview],
        reviewThreads: [reviewThread(), laterThread],
      }),
    );
    expect(await engine.pollOnce()).toMatchObject({ emitted: 1 });

    const dismissed = { ...laterReview, state: 'DISMISSED' as const };
    setDiscovery(
      github,
      'review-follow-up',
      pr({ reviews: [commentedReview, approval, dismissed], reviewThreads: [reviewThread(), laterThread] }),
    );
    expect(await engine.pollOnce()).toMatchObject({ emitted: 0 });
    expect(store.listEntities('review-follow-up')).toHaveLength(0);
    store.close();
  });

  it('ignores COMMENTED reviews without inline findings', async () => {
    const github = new FakeGitHub();
    setDiscovery(github, 'review-follow-up', pr({ reviews: [{ ...commentedReview, body: 'General note' }] }));
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(
      config({
        features: { authoredPRs: { enabled: false }, reviewFollowUp: { enabled: true }, staleThresholdHours: 24 },
      }),
      github,
      store,
    );
    expect(await engine.pollOnce()).toMatchObject({ emitted: 0 });
    expect(store.listEntities('review-follow-up')).toHaveLength(0);
    store.close();
  });

  it.each(['CLOSED', 'MERGED'] as const)('removes follow-up state when the pull request is %s', async (state) => {
    const github = new FakeGitHub();
    const initial = pr({ reviews: [commentedReview], reviewThreads: [reviewThread()] });
    setDiscovery(github, 'review-follow-up', initial);
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(
      config({
        polling: { bootstrap: 'baseline-only' },
        features: { authoredPRs: { enabled: false }, reviewFollowUp: { enabled: true }, staleThresholdHours: 24 },
      }),
      github,
      store,
    );
    await engine.pollOnce();
    setDiscovery(github, 'review-follow-up', pr({ ...initial, state }));

    expect(await engine.pollOnce()).toMatchObject({ emitted: 0 });
    expect(store.listEntities('review-follow-up')).toHaveLength(0);
    store.close();
  });

  it('persists a complete baseline so restart does not replay historical thread state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-follow-up-'));
    const path = join(dir, 'shepherd.db');
    const github = new FakeGitHub();
    const historicalReply = {
      id: 'reply-old',
      author: 'author',
      body: 'This reply predates Shepherd startup.',
      createdAt: '2026-07-20T10:00:00Z',
      updatedAt: '2026-07-20T10:00:00Z',
      url: 'https://github.com/acme/api/pull/7#discussion_r2',
    };
    const details = pr({
      reviews: [commentedReview],
      reviewThreads: [
        reviewThread({ isOutdated: true, isResolved: true, comments: [...reviewThread().comments, historicalReply] }),
      ],
      requestedReviewers: [{ login: 'octocat' }],
    });
    setDiscovery(github, 'review-follow-up', details);
    const resolvedConfig = config({
      polling: { bootstrap: 'baseline-only' },
      features: { authoredPRs: { enabled: false }, reviewFollowUp: { enabled: true }, staleThresholdHours: 24 },
    });
    try {
      const firstStore = new SqliteShepherdStore(path);
      const firstEngine = new ShepherdEngine(resolvedConfig, github, firstStore);
      expect(await firstEngine.pollOnce()).toMatchObject({ emitted: 0 });
      firstStore.close();

      const restartedStore = new SqliteShepherdStore(path);
      const restartedEngine = new ShepherdEngine(resolvedConfig, github, restartedStore);
      expect(await restartedEngine.pollOnce()).toMatchObject({ emitted: 0 });
      expect(restartedStore.listEvents()).toEqual([]);
      expect(restartedStore.listEntities('review-follow-up')).toHaveLength(1);
      restartedStore.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses recurrence discriminators for repeated stale and reviewer escalation events', async () => {
    let now = new Date('2026-07-20T10:00:00Z');
    const github = new FakeGitHub();
    const initial = pr({
      updatedAt: '2026-07-19T10:00:00Z',
      reviews: [
        {
          id: 'changes',
          author: 'reviewer',
          state: 'CHANGES_REQUESTED',
          body: 'Fix it',
          submittedAt: '2026-07-20T09:00:00Z',
        },
      ],
    });
    setDiscovery(github, 'authored', initial);
    setDiscovery(github, 'reviewer-nudge', initial);
    const store = new SqliteShepherdStore(':memory:');
    const engine = new ShepherdEngine(
      config({
        features: {
          staleThresholdHours: 24,
          reviewerNudge: { enabled: true, businessDaysOnly: false, escalateAfterHours: 24, maxEscalations: 2 },
        },
        automation: { reviewerComment: 'execute' },
      }),
      github,
      store,
      () => now,
    );
    await engine.pollOnce();
    now = new Date('2026-07-20T11:00:00Z');
    const fixed = pr({
      headSha: 'head-b',
      updatedAt: '2026-07-19T10:00:00Z',
      reviews: initial.reviews,
      commits: [...initial.commits, { sha: 'head-b', committedAt: now.toISOString(), message: 'fix' }],
    });
    setDiscovery(github, 'authored', fixed);
    setDiscovery(github, 'reviewer-nudge', fixed);
    await engine.pollOnce();
    expect(github.mutations.some((mutation) => mutation.type === 'post-reviewer-comment')).toBe(true);

    now = new Date('2026-07-21T12:00:00Z');
    await engine.pollOnce();
    now = new Date('2026-07-22T13:00:00Z');
    await engine.pollOnce();
    const escalationEvents = store.listEvents().filter((event) => event.type === 'reviewer-escalation');
    expect(escalationEvents).toHaveLength(2);
    expect(new Set(escalationEvents.map((event) => event.id)).size).toBe(2);
    const staleEvents = store.listEvents().filter((event) => event.type === 'stale');
    expect(new Set(staleEvents.map((event) => event.id)).size).toBe(staleEvents.length);
    expect(staleEvents.length).toBeGreaterThan(1);
    store.close();
  });

  it.each(['notify', 'off'] as const)(
    'starts the escalation clock when reviewer-comment automation is %s',
    async (reviewerComment) => {
      let now = new Date('2026-07-20T10:00:00Z');
      const github = new FakeGitHub();
      const initial = pr({
        reviews: [
          {
            id: 'changes',
            author: 'reviewer',
            state: 'CHANGES_REQUESTED',
            body: 'Fix it',
            submittedAt: '2026-07-20T09:00:00Z',
          },
        ],
      });
      setDiscovery(github, 'authored', initial);
      setDiscovery(github, 'reviewer-nudge', initial);
      const store = new SqliteShepherdStore(':memory:');
      const engine = new ShepherdEngine(
        config({
          features: {
            staleThresholdHours: 24,
            reviewerNudge: { enabled: true, businessDaysOnly: false, escalateAfterHours: 24 },
          },
          automation: { reviewerComment },
        }),
        github,
        store,
        () => now,
      );
      await engine.pollOnce();

      const fixed = pr({ headSha: 'head-b', reviews: initial.reviews });
      setDiscovery(github, 'authored', fixed);
      setDiscovery(github, 'reviewer-nudge', fixed);
      await engine.pollOnce();
      expect(github.mutations).toEqual([]);
      expect(store.listEvents().some((event) => event.type === 'reviewer-comment-decision')).toBe(
        reviewerComment === 'notify',
      );

      now = new Date('2026-07-21T11:00:00Z');
      await engine.pollOnce();
      expect(store.listEvents().some((event) => event.type === 'reviewer-escalation')).toBe(true);
      store.close();
    },
  );

  it('baselines an already-overdue reviewer escalation without replaying it next poll', async () => {
    let now = new Date('2026-07-20T10:00:00Z');
    const github = new FakeGitHub();
    const details = pr();
    setDiscovery(github, 'reviewer-nudge', details);
    const store = new SqliteShepherdStore(':memory:');
    store.commit(
      [
        {
          key: 'nudge:acme/api#7:reviewer',
          kind: 'nudge',
          value: {
            reviewer: 'reviewer',
            fixPushedAt: '2026-07-17T08:00:00Z',
            commentPostedAt: '2026-07-17T08:00:00Z',
            lastEscalatedAt: null,
            escalationCount: 0,
            details,
          },
        },
      ],
      [],
    );
    const engine = new ShepherdEngine(
      config({
        polling: { bootstrap: 'baseline-only' },
        features: {
          authoredPRs: { enabled: false },
          reviewerNudge: { enabled: true, businessDaysOnly: false, escalateAfterHours: 24 },
          staleThresholdHours: 24,
        },
      }),
      github,
      store,
      () => now,
    );

    await engine.pollOnce();
    await engine.pollOnce();
    expect(store.listEvents()).toEqual([]);

    now = new Date('2026-07-21T11:00:00Z');
    await engine.pollOnce();
    expect(store.listEvents().map((event) => event.type)).toEqual(['reviewer-escalation']);
    store.close();
  });
});
