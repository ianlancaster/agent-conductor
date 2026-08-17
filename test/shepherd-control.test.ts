import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { parseShepherdConfig, type ShepherdConfig } from '../src/shepherd/config.js';
import { ReleaseGateControl, TrackedPullRequestControl } from '../src/shepherd/control.js';
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
    return {
      headSha: this.details.headSha,
      autoMergeEnabled: this.details.autoMergeRequest !== null,
      queued: this.queued,
    };
  }

  async mutate(_mutation: GitHubMutation): Promise<void> {
    if (this.mutationError !== undefined) throw this.mutationError;
    this.mutations.push(structuredClone(_mutation));
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
    'rejects a gated claim that would inherit existing %s state',
    async (state) => {
      const store = new SqliteShepherdStore(':memory:');
      const github = new FakeGitHub();
      github.details = {
        ...pullRequest(),
        headSha,
        autoMergeRequest: state === 'auto-merge' ? { mergeMethod: 'SQUASH' } : null,
      };
      github.queued = state === 'merge-queue';
      await expect(
        new TrackedPullRequestControl(config(true, 'exact-head-attestation'), github, store).claim(
          input(`claim-existing-${state}`),
        ),
      ).rejects.toThrow(state === 'auto-merge' ? /persistent auto-merge/ : /merge queue/);
      expect(store.listTrackedPullRequests()).toEqual([]);
      store.close();
    },
  );

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
});
