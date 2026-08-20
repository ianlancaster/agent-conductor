import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { parseShepherdConfig, type ShepherdConfig } from '../src/shepherd/config.js';
import { ReleaseGateControl, TrackedPullRequestControl } from '../src/shepherd/control.js';
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
} from '../src/shepherd/types.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function config(enabled = true, releaseGate: 'none' | 'exact-head-attestation' = 'none'): ShepherdConfig {
  return parseShepherdConfig({
    version: 2,
    profile: { githubUser: 'octocat' },
    features: { authoredPRs: { enabled: false }, trackedPRs: { enabled, releaseGate } },
    delivery: { type: 'conductor', endpoint: 'http://localhost:3000', coordinatorSession: 'coord' },
  });
}

function pullRequest(state: PullRequestDetails['state'] = 'OPEN'): PullRequestDetails {
  return {
    repo: 'acme/api',
    number: 7,
    title: 'Improve API',
    url: 'https://github.com/acme/api/pull/7',
    isDraft: false,
    updatedAt: '2026-08-17T10:00:00Z',
    state,
    headRefName: 'feature/improve-api',
    headSha: 'head-a',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    autoMergeRequest: null,
    mergedAt: state === 'MERGED' ? '2026-08-17T10:00:00Z' : null,
    closedAt: state === 'CLOSED' ? '2026-08-17T10:00:00Z' : null,
    checks: [],
    reviews: [],
    reviewThreads: [],
    requestedReviewers: [],
    comments: [],
    commits: [],
  };
}

class FakeGitHub implements GitHubProvider {
  details: PullRequestDetails | Error = pullRequest();
  readonly mutations: GitHubMutation[] = [];
  mutationError: Error | undefined;
  mutationErrorType: GitHubMutation['type'] | undefined;
  mutationErrorAfterApply: Error | undefined;
  readonly automationStates: { headSha: string; autoMergeEnabled: boolean; queued: boolean }[] = [];
  queued = false;

  async discover(_kind: DiscoveryKind, _githubUser: string): Promise<DiscoveryResult<PullRequestSummary>> {
    return { items: [], exhaustive: true };
  }

  async getPullRequest(_pr: PullRequestRef): Promise<PullRequestDetails> {
    if (this.details instanceof Error) throw this.details;
    return structuredClone(this.details);
  }

  async getMergeAutomationState(): Promise<{ headSha: string; autoMergeEnabled: boolean; queued: boolean }> {
    if (this.details instanceof Error) throw this.details;
    const scripted = this.automationStates.shift();
    if (scripted !== undefined) return structuredClone(scripted);
    return {
      headSha: this.details.headSha,
      autoMergeEnabled: this.details.autoMergeRequest !== null,
      queued: this.queued,
    };
  }

  async mutate(_mutation: GitHubMutation): Promise<void> {
    if (
      this.mutationError !== undefined &&
      (this.mutationErrorType === undefined || this.mutationErrorType === _mutation.type)
    ) {
      throw this.mutationError;
    }
    this.mutations.push(structuredClone(_mutation));
    if (_mutation.type === 'dequeue') this.queued = false;
    if (_mutation.type === 'disable-auto-merge' && !(this.details instanceof Error)) {
      this.details = { ...this.details, autoMergeRequest: null };
    }
    if (this.mutationErrorAfterApply !== undefined) throw this.mutationErrorAfterApply;
  }
}

function input(idempotencyKey: string, evidence: unknown = { ticket: 'OPS-7' }) {
  return { repo: 'Acme/API', number: 7, actor: 'local-operator', evidence, idempotencyKey };
}

describe('tracked pull request controls', () => {
  it('claims once, audits the transition, and replays the same request idempotently', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const github = new FakeGitHub();
    const control = new TrackedPullRequestControl(config(), github, store, () => new Date('2026-08-17T10:00:00Z'));

    expect(await control.claim(input('claim-7'))).toMatchObject({
      outcome: 'claimed',
      generation: 1,
      idempotentReplay: false,
    });
    github.details = new Error('GitHub is unavailable during replay');
    expect(await control.claim(input('claim-7'))).toMatchObject({
      outcome: 'claimed',
      generation: 1,
      idempotentReplay: true,
    });
    expect(store.getTrackedPullRequest({ repo: 'acme/api', number: 7 })).toMatchObject({
      repo: 'Acme/API',
      status: 'active',
      generation: 1,
      baselinePending: false,
    });
    expect(store.listEvents().map((event) => event.type)).toEqual(['tracked-pr-claimed']);
    expect(store.listOutbox()).toHaveLength(1);
    expect(store.listTrackedControlOperations(100)).toEqual([
      expect.objectContaining({ idempotencyKey: 'claim-7', operation: 'claim', outcome: 'claimed' }),
    ]);
    store.close();
  });

  it('rejects reuse of an idempotency key for different arguments', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const control = new TrackedPullRequestControl(config(), new FakeGitHub(), store);
    await control.claim(input('claim-7'));
    await expect(control.claim(input('claim-7', { ticket: 'OTHER' }))).rejects.toThrow(/different control request/);
    store.close();
  });

  it('hashes the normalized persisted evidence with locale-independent key ordering', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const control = new TrackedPullRequestControl(config(), new FakeGitHub(), store);
    const evidence = { z: 1, a: 2, omitted: undefined };
    const original = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error('locale ordering must not participate in durable hashes');
    };
    try {
      expect(await control.claim(input('claim-locale', evidence))).toMatchObject({ outcome: 'claimed' });
      expect(await control.claim(input('claim-locale', evidence))).toMatchObject({ idempotentReplay: true });
    } finally {
      String.prototype.localeCompare = original;
    }
    expect(store.getTrackedPullRequest({ repo: 'acme/api', number: 7 })?.evidence).toEqual({ z: 1, a: 2 });
    store.close();
  });

  it('replays an equivalent operation whose hash was persisted with the legacy locale ordering', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-legacy-control-hash-'));
    dirs.push(dir);
    const path = join(dir, 'shepherd.db');
    const evidence = { z: 1, ä: 2 };
    const first = new SqliteShepherdStore(path);
    await new TrackedPullRequestControl(config(), new FakeGitHub(), first).claim(input('claim-legacy-hash', evidence));
    first.close();

    const legacyCanonical = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(legacyCanonical).join(',')}]`;
      if (typeof value === 'object' && value !== null) {
        return `{${Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
          .map(([key, item]) => `${JSON.stringify(key)}:${legacyCanonical(item)}`)
          .join(',')}}`;
      }
      return JSON.stringify(value);
    };
    const legacyHash = createHash('sha256')
      .update(
        legacyCanonical({
          operation: 'claim',
          repo: 'acme/api',
          number: 7,
          actor: 'local-operator',
          evidence,
        }),
      )
      .digest('hex');
    const raw = new DatabaseSync(path);
    const current = raw
      .prepare('SELECT request_hash FROM shepherd_control_operations WHERE idempotency_key = ?')
      .get('claim-legacy-hash') as { request_hash: string };
    expect(legacyHash).not.toBe(current.request_hash);
    raw
      .prepare('UPDATE shepherd_control_operations SET request_hash = ? WHERE idempotency_key = ?')
      .run(legacyHash, 'claim-legacy-hash');
    raw.close();

    const reopened = new SqliteShepherdStore(path);
    expect(
      await new TrackedPullRequestControl(config(), new FakeGitHub(), reopened).claim(
        input('claim-legacy-hash', evidence),
      ),
    ).toMatchObject({ outcome: 'claimed', generation: 1, idempotentReplay: true });
    reopened.close();

    const verified = new DatabaseSync(path);
    expect(
      (
        verified
          .prepare('SELECT request_hash FROM shepherd_control_operations WHERE idempotency_key = ?')
          .get('claim-legacy-hash') as { request_hash: string }
      ).request_hash,
    ).toBe(current.request_hash);
    verified.close();
  });

  it('replaces an old lifecycle snapshot at claim time while preserving authored ownership', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const oldDetails = { ...pullRequest(), headSha: 'old-head' };
    store.commit(
      [
        {
          key: 'authored:acme/api#7',
          kind: 'authored',
          value: {
            details: oldDetails,
            lastObservedAt: '2026-08-17T09:00:00Z',
            botAttempts: {},
            staleCycle: 0,
            conflictCycle: 0,
            sources: { authored: true },
          },
        },
      ],
      [],
    );
    const github = new FakeGitHub();
    github.details = { ...pullRequest(), headSha: 'verified-head' };

    await new TrackedPullRequestControl(config(), github, store).claim(input('claim-overlap'));

    expect(
      store.getEntity<{ details: PullRequestDetails; sources: { authored: boolean; trackedGeneration: number } }>(
        'authored:acme/api#7',
      )?.value,
    ).toMatchObject({
      details: { headSha: 'verified-head' },
      sources: { authored: true, trackedGeneration: 1 },
    });
    store.close();
  });

  it('audits new-key no-ops and increments the generation after an explicit unclaim', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const control = new TrackedPullRequestControl(config(), new FakeGitHub(), store);
    await control.claim(input('claim-1'));
    expect(await control.claim(input('claim-2'))).toMatchObject({ outcome: 'already-claimed', generation: 1 });
    expect(control.unclaim(input('unclaim-1', { reason: 'handoff' }))).toMatchObject({
      outcome: 'unclaimed',
      generation: 1,
    });
    expect(control.unclaim(input('unclaim-2', { reason: 'handoff' }))).toMatchObject({
      outcome: 'already-unclaimed',
      generation: 1,
    });
    expect(await control.claim(input('claim-3'))).toMatchObject({ outcome: 'reclaimed', generation: 2 });
    expect(store.countTrackedControlOperations()).toBe(5);
    expect(store.listTrackedControlOperations(2, 0)).toHaveLength(2);
    expect(store.listTrackedControlOperations(2, 4)).toHaveLength(1);
    expect(
      store
        .listEvents()
        .map((event) => event.type)
        .sort(),
    ).toEqual(['tracked-pr-claimed', 'tracked-pr-claimed', 'tracked-pr-unclaimed']);
    store.close();
  });

  it('never lets an automatic selector claim override an explicit unclaim tombstone', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const control = new TrackedPullRequestControl(config(), new FakeGitHub(), store);
    await control.claim(input('claim-before-selector'));
    control.unclaim(input('unclaim-before-selector', { reason: 'explicit exception' }));

    expect(await control.claimIfUntracked(input('selector-after-unclaim'))).toMatchObject({
      outcome: 'selector-skipped',
      generation: 1,
    });
    expect(store.getTrackedPullRequest({ repo: 'acme/api', number: 7 })).toMatchObject({
      status: 'unclaimed',
      generation: 1,
    });
    expect(
      store
        .listEvents()
        .map((event) => event.type)
        .sort(),
    ).toEqual(['tracked-pr-claimed', 'tracked-pr-unclaimed']);
    store.close();
  });

  it.each(['CLOSED', 'MERGED'] as const)('durably rejects a %s pull request', async (state) => {
    const store = new SqliteShepherdStore(':memory:');
    const github = new FakeGitHub();
    github.details = pullRequest(state);
    const control = new TrackedPullRequestControl(config(), github, store);
    const first = await control.claim(input(`claim-${state}`));
    expect(first).toMatchObject({ outcome: `rejected-${state.toLowerCase()}`, generation: null });
    expect(await control.claim(input(`claim-${state}`))).toEqual({ ...first, idempotentReplay: true });
    expect(store.listTrackedPullRequests()).toEqual([]);
    expect(store.listEvents()).toEqual([]);
    expect(store.listTrackedControlOperations(100)).toEqual([
      expect.objectContaining({ operation: 'claim', outcome: `rejected-${state.toLowerCase()}` }),
    ]);
    store.close();
  });

  it('does not record a false claim when GitHub verification is retryable', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const github = new FakeGitHub();
    github.details = new Error('temporary outage');
    const control = new TrackedPullRequestControl(config(), github, store);
    await expect(control.claim(input('claim-retry'))).rejects.toThrow(/no claim was recorded/);
    expect(store.listTrackedPullRequests()).toEqual([]);
    github.details = pullRequest();
    expect(await control.claim(input('claim-retry'))).toMatchObject({ outcome: 'claimed' });
    store.close();
  });

  it('keeps controls inert unless tracked PRs are explicitly enabled', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const control = new TrackedPullRequestControl(config(false), new FakeGitHub(), store);
    await expect(control.claim(input('claim-disabled'))).rejects.toThrow(/features.trackedPRs.enabled/);
    expect(() => control.unclaim(input('unclaim-disabled'))).toThrow(/features.trackedPRs.enabled/);
    store.close();
  });

  it('recovers durable claim and idempotency state after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-control-'));
    dirs.push(dir);
    const path = join(dir, 'shepherd.db');
    const first = new SqliteShepherdStore(path);
    await new TrackedPullRequestControl(config(), new FakeGitHub(), first).claim(input('claim-restart'));
    first.close();

    const reopened = new SqliteShepherdStore(path);
    const result = await new TrackedPullRequestControl(config(), new FakeGitHub(), reopened).claim(
      input('claim-restart'),
    );
    expect(result).toMatchObject({ outcome: 'claimed', generation: 1, idempotentReplay: true });
    expect(reopened.listTrackedPullRequests('active')).toHaveLength(1);
    reopened.close();
  });
});

describe('exact-head release controls', () => {
  const headSha = 'a'.repeat(40);

  async function claimedGate(store: SqliteShepherdStore, github: FakeGitHub) {
    github.details = { ...pullRequest(), headSha };
    const resolved = config(true, 'exact-head-attestation');
    await new TrackedPullRequestControl(resolved, github, store).claim(input('claim-gated'));
    return { resolved, release: new ReleaseGateControl(resolved, github, store) };
  }

  async function legacyNoneRevokeState(scenario: string, sourceType: 'enqueue' | 'auto-merge' = 'enqueue') {
    const dir = mkdtempSync(join(tmpdir(), `shepherd-legacy-revoke-${scenario}-`));
    dirs.push(dir);
    const path = join(dir, 'shepherd.db');
    const store = new SqliteShepherdStore(path);
    const github = new FakeGitHub();
    const { release } = await claimedGate(store, github);
    await release.attest({ ...input(`attest-${scenario}`), headSha });
    const sourceActionKey = `action:legacy-cancelled-${scenario}`;
    store.commit(
      [
        {
          key: sourceActionKey,
          kind: 'action',
          value: {
            status: 'pending',
            ...(sourceType === 'enqueue' ? { trackedGeneration: 1 } : {}),
            mutation:
              sourceType === 'enqueue'
                ? { type: 'enqueue-exact-head', pr: { repo: 'acme/api', number: 7 }, headSha }
                : {
                    type: 'enable-auto-merge',
                    pr: { repo: 'acme/api', number: 7 },
                    mergeMethod: 'squash',
                  },
          },
        },
      ],
      [],
    );
    github.mutationError = new Error('seed pending compensation');
    const revokeInput = { ...input(`revoke-${scenario}`), reason: 'withdraw legacy release' };
    const initial = await release.revoke(revokeInput);
    const originalCompensationKey = initial.compensationActionKeys[0];
    if (originalCompensationKey === undefined) throw new Error('expected seeded compensation action');
    store.close();

    const database = new DatabaseSync(path);
    const row = database
      .prepare('SELECT result_json FROM shepherd_release_operations WHERE idempotency_key = ?')
      .get(revokeInput.idempotencyKey) as { result_json: string };
    const legacyResult = {
      ...(JSON.parse(row.result_json) as Record<string, unknown>),
      compensation: 'none',
      compensationActionKeys: [],
    };
    database
      .prepare('UPDATE shepherd_release_operations SET result_json = ? WHERE idempotency_key = ?')
      .run(JSON.stringify(legacyResult), revokeInput.idempotencyKey);
    database.prepare('DELETE FROM shepherd_entities WHERE key = ?').run(originalCompensationKey);
    database.close();
    github.mutationError = undefined;
    const compensationType = sourceType === 'enqueue' ? 'dequeue' : 'disable-auto-merge';
    return {
      github,
      path,
      revokeInput,
      sourceActionKey,
      safetyActionKey: `${sourceActionKey}:safety-${compensationType}`,
      compensationType,
    };
  }

  it('persists exact-head evidence and replays attest/revoke requests idempotently', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const github = new FakeGitHub();
    const { release } = await claimedGate(store, github);
    const attestInput = { ...input('attest-head', { mode: 'verified' }), headSha };

    expect(await release.attest(attestInput)).toMatchObject({
      outcome: 'attested',
      headSha,
      generation: 1,
      idempotentReplay: false,
    });
    github.details = new Error('replay must not call GitHub');
    expect(await release.attest(attestInput)).toMatchObject({ outcome: 'attested', idempotentReplay: true });
    expect(store.getReleaseGateStatus(input('unused'), 1, headSha)).toBe('applicable');
    expect(store.getReleaseAttestation(input('unused'), 1, headSha)).toMatchObject({
      idempotencyKey: 'attest-head',
      actor: 'local-operator',
      evidence: { mode: 'verified' },
      status: 'active',
    });

    github.details = { ...pullRequest(), headSha };
    const revokeInput = { ...input('revoke-head', { incident: 'INC-1' }), reason: 'release withdrawn' };
    expect(await release.revoke(revokeInput)).toMatchObject({
      outcome: 'revoked',
      compensation: 'none',
      idempotentReplay: false,
    });
    expect(await release.revoke(revokeInput)).toMatchObject({ outcome: 'revoked', idempotentReplay: true });
    expect(store.getReleaseGateStatus(input('unused'), 1, headSha)).toBe('revoked');
    expect(store.listReleaseControlOperations(10)).toEqual([
      expect.objectContaining({ idempotencyKey: 'revoke-head', reason: 'release withdrawn' }),
      expect.objectContaining({ idempotencyKey: 'attest-head', headSha, evidence: { mode: 'verified' } }),
    ]);
    store.close();
  });

  it('rejects a stale asserted head without recording an attestation', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const github = new FakeGitHub();
    const { release } = await claimedGate(store, github);
    await expect(release.attest({ ...input('attest-stale'), headSha: 'b'.repeat(40) })).rejects.toThrow(
      /does not match the current GitHub head/,
    );
    expect(store.countReleaseControlOperations()).toBe(0);
    expect(store.getReleaseGateStatus(input('unused'), 1, headSha)).toBe('missing');
    store.close();
  });

  it('rejects attestation while provider merge automation is already active', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const github = new FakeGitHub();
    const { release } = await claimedGate(store, github);
    github.queued = true;
    await expect(release.attest({ ...input('attest-while-queued'), headSha })).rejects.toThrow(
      /remove the pull request from the merge queue/,
    );
    expect(store.countReleaseControlOperations()).toBe(0);
    store.close();
  });

  it.each(['auto-merge', 'merge-queue'] as const)(
    'safely hands off a gated claim that inherits existing %s state',
    async (state) => {
      const store = new SqliteShepherdStore(':memory:');
      const github = new FakeGitHub();
      github.details = {
        ...pullRequest(),
        headSha,
        autoMergeRequest: state === 'auto-merge' ? { mergeMethod: 'SQUASH' } : null,
      };
      github.queued = state === 'merge-queue';
      const result = await new TrackedPullRequestControl(config(true, 'exact-head-attestation'), github, store).claim(
        input(`claim-existing-${state}`),
      );
      expect(result).toMatchObject({
        outcome: 'claimed',
        generation: 1,
        handoff: 'completed',
        handoffActionKeys: [expect.any(String)],
      });
      expect(github.mutations).toEqual([
        {
          type: state === 'auto-merge' ? 'disable-auto-merge' : 'dequeue',
          pr: { repo: 'Acme/API', number: 7 },
        },
      ]);
      expect(store.listTrackedPullRequests()).toEqual([
        expect.objectContaining({ status: 'active', generation: 1, releaseGate: 'exact-head-attestation' }),
      ]);
      store.close();
    },
  );

  it('leaves provider failures durable and resumes the same claim key without a false claim', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const github = new FakeGitHub();
    github.details = { ...pullRequest(), headSha };
    github.queued = true;
    github.mutationError = new Error('temporary dequeue failure');
    const control = new TrackedPullRequestControl(config(true, 'exact-head-attestation'), github, store);
    const claimInput = input('claim-provider-retry');

    await expect(control.claim(claimInput)).rejects.toThrow(/no claim was recorded.*same claim key/i);
    expect(store.listTrackedPullRequests()).toEqual([]);
    expect(store.listTrackedControlOperations(10)).toEqual([]);
    expect(store.listEntities<{ status: string }>('claim-handoff')).toHaveLength(1);
    expect(store.listEntities<{ status: string }>('action')[0]?.value.status).toBe('pending');
    await expect(control.claim({ ...claimInput, evidence: { ticket: 'different' } })).rejects.toThrow(
      /different control request/,
    );

    github.mutationError = undefined;
    const completed = await control.claim(claimInput);
    expect(completed).toMatchObject({ outcome: 'claimed', generation: 1, handoff: 'completed' });
    expect(github.mutations).toEqual([{ type: 'dequeue', pr: { repo: 'Acme/API', number: 7 } }]);
    github.details = new Error('idempotent replay must not call GitHub');
    await expect(control.claim(claimInput)).resolves.toEqual({ ...completed, idempotentReplay: true });
    expect(store.listEntities('claim-handoff')).toEqual([]);
    expect(store.countTrackedControlOperations()).toBe(1);
    store.close();
  });

  it('persists every required handoff action before a later auto-merge compensation fails', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const github = new FakeGitHub();
    github.details = { ...pullRequest(), headSha, autoMergeRequest: { mergeMethod: 'SQUASH' } };
    github.queued = true;
    github.mutationError = new Error('temporary auto-merge disable failure');
    github.mutationErrorType = 'disable-auto-merge';
    const control = new TrackedPullRequestControl(config(true, 'exact-head-attestation'), github, store);
    const claimInput = input('claim-multiple-provider-states');

    await expect(control.claim(claimInput)).rejects.toThrow(/no claim was recorded/);
    expect(store.listTrackedPullRequests()).toEqual([]);
    expect(
      store
        .listEntities<{ status: string; mutation: GitHubMutation }>('action')
        .map((entity) => [entity.value.mutation.type, entity.value.status]),
    ).toEqual([
      ['dequeue', 'completed'],
      ['disable-auto-merge', 'pending'],
    ]);

    github.mutationError = undefined;
    await expect(control.claim(claimInput)).resolves.toMatchObject({
      outcome: 'claimed',
      handoff: 'completed',
      handoffActionKeys: [expect.any(String), expect.any(String)],
    });
    expect(github.mutations.map((mutation) => mutation.type)).toEqual(['dequeue', 'disable-auto-merge']);
    store.close();
  });

  it('recovers after a crash-ambiguous accepted provider mutation without submitting it twice', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-claim-handoff-crash-'));
    dirs.push(dir);
    const path = join(dir, 'shepherd.db');
    const github = new FakeGitHub();
    github.details = { ...pullRequest(), headSha };
    github.queued = true;
    github.mutationErrorAfterApply = new Error('connection lost after GitHub accepted dequeue');
    const claimInput = input('claim-after-crash');
    const first = new SqliteShepherdStore(path);

    await expect(
      new TrackedPullRequestControl(config(true, 'exact-head-attestation'), github, first).claim(claimInput),
    ).rejects.toThrow(/no claim was recorded/);
    expect(first.listTrackedPullRequests()).toEqual([]);
    expect(github.mutations).toEqual([{ type: 'dequeue', pr: { repo: 'Acme/API', number: 7 } }]);
    first.close();

    github.mutationErrorAfterApply = undefined;
    const reopened = new SqliteShepherdStore(path);
    await expect(
      new TrackedPullRequestControl(config(true, 'exact-head-attestation'), github, reopened).claim(claimInput),
    ).resolves.toMatchObject({ outcome: 'claimed', generation: 1, handoff: 'completed' });
    expect(github.mutations).toHaveLength(1);
    expect(reopened.listTrackedPullRequests('active')).toHaveLength(1);
    reopened.close();
  });

  it('does not commit a stale snapshot when the head changes during provider handoff', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const github = new FakeGitHub();
    const nextHead = 'b'.repeat(40);
    github.details = { ...pullRequest(), headSha };
    github.queued = true;
    github.automationStates.push(
      { headSha, autoMergeEnabled: false, queued: true },
      { headSha, autoMergeEnabled: false, queued: true },
      { headSha: nextHead, autoMergeEnabled: false, queued: false },
    );
    const control = new TrackedPullRequestControl(config(true, 'exact-head-attestation'), github, store);
    const claimInput = input('claim-head-changed');

    await expect(control.claim(claimInput)).rejects.toThrow(/head changed during gated claim handoff/);
    expect(store.listTrackedPullRequests()).toEqual([]);
    github.details = { ...pullRequest(), headSha: nextHead };
    await expect(control.claim(claimInput)).resolves.toMatchObject({ outcome: 'claimed', generation: 1 });
    expect(store.getEntity<{ details: PullRequestDetails }>('authored:acme/api#7')?.value.details.headSha).toBe(
      nextHead,
    );
    store.close();
  });

  it('fences a pending handoff from an intervening claim generation', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const github = new FakeGitHub();
    github.details = { ...pullRequest(), headSha };
    github.queued = true;
    github.mutationError = new Error('pause the first handoff');
    const gated = new TrackedPullRequestControl(config(true, 'exact-head-attestation'), github, store);
    const pendingInput = input('claim-generation-fence');
    await expect(gated.claim(pendingInput)).rejects.toThrow(/no claim was recorded/);

    github.mutationError = undefined;
    await new TrackedPullRequestControl(config(true, 'none'), github, store).claim(input('intervening-claim'));
    await expect(gated.claim(pendingInput)).rejects.toThrow(/generation changed during claim handoff/);
    expect(store.getTrackedPullRequest(input('unused'))).toMatchObject({
      generation: 1,
      actor: 'local-operator',
      releaseGate: 'none',
    });
    expect(store.countTrackedControlOperations()).toBe(1);
    store.close();
  });

  it('keeps the releaseGate none claim path backward compatible with inherited provider state', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const github = new FakeGitHub();
    github.details = { ...pullRequest(), headSha, autoMergeRequest: { mergeMethod: 'SQUASH' } };
    github.queued = true;

    await expect(
      new TrackedPullRequestControl(config(true, 'none'), github, store).claim(input('claim-ungated')),
    ).resolves.toMatchObject({ outcome: 'claimed', generation: 1 });
    expect(github.mutations).toEqual([]);
    expect(store.listEntities('claim-handoff')).toEqual([]);
    store.close();
  });

  it('keeps selector claims non-mutating when an exact-head candidate has inherited provider state', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const github = new FakeGitHub();
    github.details = { ...pullRequest(), headSha };
    github.queued = true;

    await expect(
      new TrackedPullRequestControl(config(true, 'exact-head-attestation'), github, store).claimIfUntracked(
        input('selector-queued'),
      ),
    ).rejects.toThrow(/remove the pull request from the merge queue/i);
    expect(github.mutations).toEqual([]);
    expect(store.listTrackedPullRequests()).toEqual([]);
    expect(store.listEntities('claim-handoff')).toEqual([]);
    store.close();
  });

  it('requires revoke and completed queue compensation before safely unclaiming', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const github = new FakeGitHub();
    const { resolved, release } = await claimedGate(store, github);
    await release.attest({ ...input('attest-before-unclaim'), headSha });
    const control = new TrackedPullRequestControl(resolved, github, store);
    const unclaimInput = input('unclaim-gated', { reason: 'done' });

    expect(() => control.unclaim(unclaimInput)).toThrow(/asynchronous safe control path/);
    await expect(control.unclaimSafely(unclaimInput)).rejects.toThrow(/Revoke the exact-head release gate/);

    store.commit(
      [
        {
          key: 'action:queued-release',
          kind: 'action',
          value: {
            status: 'completed',
            completedAt: '2026-08-17T11:00:00Z',
            trackedGeneration: 1,
            mutation: { type: 'enqueue-exact-head', pr: { repo: 'Acme/API', number: 7 }, headSha },
          },
        },
      ],
      [],
    );
    expect(await release.revoke({ ...input('revoke-before-unclaim'), reason: 'handoff' })).toMatchObject({
      outcome: 'revoked',
      compensation: 'completed',
      compensationActionKeys: [expect.any(String)],
    });
    expect(github.mutations).toEqual([{ type: 'dequeue', pr: { repo: 'Acme/API', number: 7 } }]);
    await expect(control.unclaimSafely(unclaimInput)).resolves.toMatchObject({ outcome: 'unclaimed' });
    store.close();
  });

  it('leaves failed compensation durable for restart retry', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const github = new FakeGitHub();
    const { release } = await claimedGate(store, github);
    await release.attest({ ...input('attest-failed-compensation'), headSha });
    store.commit(
      [
        {
          key: 'action:queued-before-crash',
          kind: 'action',
          value: {
            status: 'completed',
            completedAt: '2026-08-17T11:00:00Z',
            trackedGeneration: 1,
            mutation: { type: 'enqueue-exact-head', pr: { repo: 'acme/api', number: 7 }, headSha },
          },
        },
      ],
      [],
    );
    github.mutationError = new Error('temporary provider failure');
    const revokeInput = { ...input('revoke-failed-compensation'), reason: 'stop release' };
    const result = await release.revoke(revokeInput);
    expect(result).toMatchObject({ compensation: 'pending', compensationActionKeys: [expect.any(String)] });
    expect(store.getEntity<{ status: string }>(result.compensationActionKeys[0] ?? '')?.value.status).toBe('pending');
    github.mutationError = undefined;
    await expect(release.revoke(revokeInput)).resolves.toMatchObject({
      compensation: 'completed',
      idempotentReplay: true,
    });
    store.close();
  });

  it('disables a crash-ambiguous legacy auto-merge submission on revoke', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const github = new FakeGitHub();
    const { release } = await claimedGate(store, github);
    await release.attest({ ...input('attest-before-disable'), headSha });
    store.commit(
      [
        {
          key: 'action:legacy-auto-merge',
          kind: 'action',
          value: {
            status: 'pending',
            mutation: { type: 'enable-auto-merge', pr: { repo: 'acme/api', number: 7 }, mergeMethod: 'squash' },
          },
        },
      ],
      [],
    );

    expect(await release.revoke({ ...input('revoke-disable-auto'), reason: 'withdraw release' })).toMatchObject({
      compensation: 'completed',
      compensationActionKeys: [expect.any(String)],
    });
    expect(github.mutations).toEqual([{ type: 'disable-auto-merge', pr: { repo: 'Acme/API', number: 7 } }]);
    expect(store.getEntity<{ status: string }>('action:legacy-auto-merge')?.value.status).toBe('cancelled');
    store.close();
  });

  it('completes every required provider compensation before marking revoke complete', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const github = new FakeGitHub();
    const { release } = await claimedGate(store, github);
    await release.attest({ ...input('attest-multiple-compensations'), headSha });
    store.commit(
      [
        {
          key: 'action:ambiguous-queue',
          kind: 'action',
          value: {
            status: 'pending',
            trackedGeneration: 1,
            mutation: { type: 'enqueue-exact-head', pr: { repo: 'acme/api', number: 7 }, headSha },
          },
        },
        {
          key: 'action:ambiguous-auto-merge',
          kind: 'action',
          value: {
            status: 'pending',
            mutation: { type: 'enable-auto-merge', pr: { repo: 'acme/api', number: 7 }, mergeMethod: 'squash' },
          },
        },
      ],
      [],
    );

    const result = await release.revoke({
      ...input('revoke-multiple-compensations'),
      reason: 'withdraw release',
    });
    expect(result.compensation).toBe('completed');
    expect(result.compensationActionKeys).toHaveLength(2);
    expect(github.mutations.map((mutation) => mutation.type)).toEqual(['dequeue', 'disable-auto-merge']);
    store.close();
  });

  it('allows cleanup revoke after the configured gate is turned off', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const github = new FakeGitHub();
    const { release } = await claimedGate(store, github);
    await release.attest({ ...input('attest-before-config-disable'), headSha });

    const cleanup = new ReleaseGateControl(config(false, 'none'), github, store);
    await expect(
      cleanup.revoke({ ...input('revoke-after-config-disable'), reason: 'configuration rollback' }),
    ).resolves.toMatchObject({ outcome: 'revoked' });
    const noNewAttestations = new ReleaseGateControl(config(true, 'none'), github, store);
    await expect(noNewAttestations.attest({ ...input('attest-after-config-disable'), headSha })).rejects.toThrow(
      /releaseGate: exact-head-attestation/,
    );
    store.close();
  });

  it('replays a durable attestation after tracked controls and the gate are disabled', async () => {
    const store = new SqliteShepherdStore(':memory:');
    const github = new FakeGitHub();
    const { release } = await claimedGate(store, github);
    const attestInput = { ...input('attest-replay-after-disable'), headSha };
    await expect(release.attest(attestInput)).resolves.toMatchObject({
      outcome: 'attested',
      idempotentReplay: false,
    });

    const disabled = new ReleaseGateControl(config(false, 'none'), github, store);
    await expect(disabled.attest(attestInput)).resolves.toMatchObject({
      outcome: 'attested',
      idempotentReplay: true,
    });
    await expect(disabled.attest({ ...attestInput, evidence: { ticket: 'different' } })).rejects.toThrow(
      /different release request/,
    );
    store.close();
  });

  it('reconciles a legacy compensation-none revoke replay before startup repair', async () => {
    const seeded = await legacyNoneRevokeState('before-repair');
    const store = new SqliteShepherdStore(seeded.path);
    const release = new ReleaseGateControl(config(false, 'none'), seeded.github, store);
    await expect(release.revoke({ ...seeded.revokeInput, reason: 'different request' })).rejects.toThrow(
      /different release request/,
    );

    seeded.github.mutationError = new Error('keep reconciled compensation pending');
    const pending = await release.revoke(seeded.revokeInput);
    expect(pending).toMatchObject({ compensation: 'pending', idempotentReplay: true });
    expect(pending.compensationActionKeys).toEqual([seeded.safetyActionKey]);
    expect(store.listReleaseControlOperations(10)[0]?.result).toMatchObject({
      compensation: 'pending',
      compensationActionKeys: pending.compensationActionKeys,
    });

    seeded.github.mutationError = undefined;
    await expect(release.revoke(seeded.revokeInput)).resolves.toMatchObject({
      compensation: 'completed',
      compensationActionKeys: pending.compensationActionKeys,
      idempotentReplay: true,
    });
    expect(store.listReleaseControlOperations(10)[0]?.result.compensation).toBe('completed');
    store.close();
  });

  it('adopts startup-repaired safety work into a legacy compensation-none revoke audit', async () => {
    const seeded = await legacyNoneRevokeState('after-repair');
    const store = new SqliteShepherdStore(seeded.path);
    seeded.github.mutationError = new Error('leave startup safety work pending');
    expect(await new ShepherdEngine(config(false, 'none'), seeded.github, store).drainActions()).toBe(0);
    const safetyKey = seeded.safetyActionKey;
    expect(store.getEntity<Record<string, unknown>>(safetyKey)?.value).toMatchObject({
      status: 'pending',
      compensatesActionKey: seeded.sourceActionKey,
    });
    expect(store.listReleaseControlOperations(10)[0]?.result).toMatchObject({
      compensation: 'none',
      compensationActionKeys: [],
    });

    const replay = await new ReleaseGateControl(config(false, 'none'), seeded.github, store).revoke(seeded.revokeInput);
    expect(replay).toMatchObject({
      compensation: 'pending',
      compensationActionKeys: [safetyKey],
      idempotentReplay: true,
    });
    expect(store.getEntity<Record<string, unknown>>(safetyKey)?.value.compensationFor).toBe(
      seeded.revokeInput.idempotencyKey,
    );
    expect(store.listReleaseControlOperations(10)[0]?.result.compensationActionKeys).toEqual([safetyKey]);
    store.close();
  });

  it('links completed startup safety work and corrects a legacy compensation-none revoke audit', async () => {
    const seeded = await legacyNoneRevokeState('after-completion');
    const store = new SqliteShepherdStore(seeded.path);
    expect(await new ShepherdEngine(config(false, 'none'), seeded.github, store).drainActions()).toBe(1);
    const safetyKey = seeded.safetyActionKey;
    expect(store.getEntity<Record<string, unknown>>(safetyKey)?.value.status).toBe('completed');
    expect(store.listReleaseControlOperations(10)[0]?.result.compensation).toBe('none');
    const mutationCount = seeded.github.mutations.length;

    await expect(
      new ReleaseGateControl(config(false, 'none'), seeded.github, store).revoke(seeded.revokeInput),
    ).resolves.toMatchObject({
      compensation: 'completed',
      compensationActionKeys: [safetyKey],
      idempotentReplay: true,
    });
    expect(seeded.github.mutations).toHaveLength(mutationCount);
    expect(store.listReleaseControlOperations(10)[0]?.result).toMatchObject({
      compensation: 'completed',
      compensationActionKeys: [safetyKey],
    });
    store.close();
  });

  it('reconciles a legacy compensation-none revoke for persistent auto-merge safety work', async () => {
    const seeded = await legacyNoneRevokeState('legacy-auto-merge', 'auto-merge');
    const store = new SqliteShepherdStore(seeded.path);
    await expect(
      new ReleaseGateControl(config(false, 'none'), seeded.github, store).revoke(seeded.revokeInput),
    ).resolves.toMatchObject({
      compensation: 'completed',
      compensationActionKeys: [seeded.safetyActionKey],
      idempotentReplay: true,
    });
    expect(seeded.github.mutations.at(-1)).toEqual({
      type: seeded.compensationType,
      pr: { repo: 'acme/api', number: 7 },
    });
    expect(store.listReleaseControlOperations(10)[0]?.result).toMatchObject({
      compensation: 'completed',
      compensationActionKeys: [seeded.safetyActionKey],
    });
    store.close();
  });
});
