import { createHash } from 'node:crypto';
import type { ShepherdConfig } from './config.js';
import { buildEvent } from './events.js';
import { ShepherdMutationMutex } from './mutex.js';
import { repositoryInScope } from './scope.js';
import type {
  GitHubProvider,
  GitHubMutation,
  PullRequestDetails,
  PullRequestRef,
  ReleaseControlRequest,
  ReleaseControlResult,
  ReleaseGateStore,
  TrackedControlOperationType,
  TrackedControlRequest,
  TrackedControlResult,
  TrackedPullRequest,
  TrackedPullRequestStore,
} from './types.js';

export interface TrackedControlInput extends PullRequestRef {
  actor: string;
  evidence: unknown;
  idempotencyKey: string;
}

const MAX_ACTOR_LENGTH = 200;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
export const MAX_TRACKED_EVIDENCE_BYTES = 16_384;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function validatedInput(
  operation: TrackedControlOperationType,
  input: TrackedControlInput,
  now: Date,
  releaseGate?: ShepherdConfig['features']['trackedPRs']['releaseGate'],
): TrackedControlRequest {
  const repo = input.repo.trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error('Repository must use the owner/name form.');
  if (!Number.isSafeInteger(input.number) || input.number <= 0)
    throw new Error('PR number must be a positive integer.');
  const actor = input.actor.trim();
  if (actor.length === 0 || actor.length > MAX_ACTOR_LENGTH) {
    throw new Error(`Actor must contain 1-${String(MAX_ACTOR_LENGTH)} characters.`);
  }
  const idempotencyKey = input.idempotencyKey.trim();
  if (idempotencyKey.length === 0 || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new Error(`Idempotency key must contain 1-${String(MAX_IDEMPOTENCY_KEY_LENGTH)} characters.`);
  }
  let evidenceJson: string;
  try {
    evidenceJson = JSON.stringify(input.evidence);
  } catch {
    throw new Error('Evidence must be JSON-serializable.');
  }
  if (evidenceJson === undefined) throw new Error('Evidence must be a JSON value.');
  if (Buffer.byteLength(evidenceJson, 'utf8') > MAX_TRACKED_EVIDENCE_BYTES) {
    throw new Error(`Evidence must not exceed ${String(MAX_TRACKED_EVIDENCE_BYTES)} UTF-8 bytes.`);
  }
  const evidence = JSON.parse(evidenceJson) as unknown;
  const identity = {
    operation,
    repo: repo.toLowerCase(),
    number: input.number,
    actor,
    evidence,
    ...(releaseGate === 'exact-head-attestation' ? { releaseGate } : {}),
  };
  return {
    operation,
    repo,
    number: input.number,
    actor,
    evidence,
    idempotencyKey,
    requestHash: createHash('sha256').update(canonical(identity)).digest('hex'),
    occurredAt: now.toISOString(),
    ...(releaseGate === undefined ? {} : { releaseGate }),
  };
}

export class TrackedPullRequestControl {
  private mutationMutex: ShepherdMutationMutex | undefined;

  constructor(
    private readonly config: ShepherdConfig,
    private readonly github: GitHubProvider,
    private readonly store: TrackedPullRequestStore,
    private readonly clock: () => Date = () => new Date(),
    mutationMutex?: ShepherdMutationMutex,
  ) {
    this.mutationMutex = mutationMutex;
  }

  async claim(input: TrackedControlInput): Promise<TrackedControlResult> {
    this.assertEnabled();
    const request = validatedInput('claim', input, this.clock(), this.config.features.trackedPRs.releaseGate);
    const replay = this.store.getTrackedControlResult(request);
    if (replay !== undefined) return replay;
    if (!repositoryInScope(request.repo, this.config.github)) {
      throw new Error(`Repository ${request.repo} is outside the configured GitHub scope.`);
    }
    const verifyAndClaim = async (): Promise<TrackedControlResult> => {
      let details: PullRequestDetails;
      try {
        details = await this.github.getPullRequest(request);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.store.logHealth(
          'tracked-pr-claim-verification-failed',
          `${request.repo}#${String(request.number)}: ${detail.slice(0, 500)}`,
        );
        throw new Error(
          `Unable to verify ${request.repo}#${String(request.number)}; no claim was recorded: ${detail}`,
          {
            cause: error,
          },
        );
      }
      if (details.number !== request.number || details.repo.toLowerCase() !== request.repo.toLowerCase()) {
        throw new Error(
          `GitHub returned a different pull request while verifying ${request.repo}#${String(request.number)}.`,
        );
      }
      if (request.releaseGate === 'exact-head-attestation') {
        if (this.github.getMergeAutomationState === undefined) {
          throw new Error('The GitHub provider cannot verify merge automation state for an exact-head gated claim.');
        }
        const automation = await this.github.getMergeAutomationState(request);
        if (automation.headSha.toLowerCase() !== details.headSha.toLowerCase()) {
          throw new Error('The pull request head changed during gated claim verification; retry the claim.');
        }
        if (automation.autoMergeEnabled || details.autoMergeRequest !== null) {
          throw new Error("Disable the pull request's existing persistent auto-merge before creating a gated claim.");
        }
        if (automation.queued) {
          throw new Error('Remove the pull request from the merge queue before creating a gated claim.');
        }
      }
      const event = buildEvent(
        this.config,
        'tracked-pr-claimed',
        request,
        { idempotencyKey: request.idempotencyKey },
        { actor: request.actor, evidence: request.evidence, title: details.title, url: details.url },
        request.occurredAt,
      );
      const now = this.clock();
      const threshold = this.config.features.staleThresholdHours;
      const staleHours = (now.getTime() - new Date(details.updatedAt).getTime()) / 3_600_000;
      return this.store.claimTrackedPullRequest(
        request,
        details,
        {
          details,
          lastObservedAt: request.occurredAt,
          botAttempts: {},
          staleCycle: threshold === 0 ? 1 : Math.max(0, Math.floor(staleHours / threshold)),
          conflictCycle: details.mergeable === 'CONFLICTING' ? 1 : 0,
        },
        event,
        this.recipient(),
      );
    };
    return request.releaseGate === 'exact-head-attestation'
      ? this.releaseMutex().runExclusive(verifyAndClaim)
      : verifyAndClaim();
  }

  unclaim(input: TrackedControlInput): TrackedControlResult {
    this.assertEnabled();
    const request = validatedInput('unclaim', input, this.clock());
    const replay = this.store.getTrackedControlResult(request);
    if (replay !== undefined) return replay;
    if (this.store.getTrackedPullRequest(request)?.releaseGate === 'exact-head-attestation') {
      throw new Error('Exact-head gated claims must be unclaimed with the asynchronous safe control path.');
    }
    return this.persistUnclaim(request);
  }

  async unclaimSafely(input: TrackedControlInput): Promise<TrackedControlResult> {
    this.assertEnabled();
    const request = validatedInput('unclaim', input, this.clock());
    const replay = this.store.getTrackedControlResult(request);
    if (replay !== undefined) return replay;
    const tracked = this.store.getTrackedPullRequest(request);
    if (tracked?.status !== 'active' || tracked.releaseGate !== 'exact-head-attestation') {
      return this.persistUnclaim(request);
    }
    const releaseStore = this.releaseStore();
    return this.releaseMutex().runExclusive(async () => {
      const current = releaseStore.getTrackedPullRequest(request);
      if (
        current?.status === 'active' &&
        current.releaseGate === 'exact-head-attestation' &&
        !releaseStore.canUnclaimReleaseGate(request, current.generation)
      ) {
        throw new Error('Revoke the exact-head release gate and complete any queue compensation before unclaiming.');
      }
      return this.persistUnclaim(request);
    });
  }

  private persistUnclaim(request: TrackedControlRequest): TrackedControlResult {
    const event = buildEvent(
      this.config,
      'tracked-pr-unclaimed',
      request,
      { idempotencyKey: request.idempotencyKey },
      { actor: request.actor, evidence: request.evidence },
      request.occurredAt,
    );
    return this.store.unclaimTrackedPullRequest(request, event, this.recipient());
  }

  list(): TrackedPullRequest[] {
    return this.store.listTrackedPullRequests();
  }

  private assertEnabled(): void {
    if (!this.config.features.trackedPRs.enabled) {
      throw new Error('Tracked PR controls require features.trackedPRs.enabled: true.');
    }
  }

  private recipient(): string {
    return this.config.delivery.type === 'conductor' ? this.config.delivery.coordinatorSession : 'stdout';
  }

  private releaseStore(): ReleaseGateStore {
    const candidate = this.store as Partial<ReleaseGateStore>;
    if (
      typeof candidate.canUnclaimReleaseGate !== 'function' ||
      typeof candidate.tryAcquireMutationLock !== 'function' ||
      typeof candidate.releaseMutationLock !== 'function'
    ) {
      throw new Error('The tracked pull-request store does not support safe exact-head gate release.');
    }
    return this.store as ReleaseGateStore;
  }

  private releaseMutex(): ShepherdMutationMutex {
    this.mutationMutex ??= new ShepherdMutationMutex(this.releaseStore(), this.clock);
    return this.mutationMutex;
  }
}

export interface ReleaseAttestInput extends TrackedControlInput {
  headSha: string;
}

export interface ReleaseRevokeInput extends TrackedControlInput {
  reason: string;
}

function validatedRelease(
  operation: ReleaseControlRequest['operation'],
  input: ReleaseAttestInput | ReleaseRevokeInput,
  now: Date,
): ReleaseControlRequest {
  const base = validatedInput(operation === 'attest' ? 'claim' : 'unclaim', input, now);
  const headSha = 'headSha' in input ? input.headSha.trim().toLowerCase() : undefined;
  if (headSha !== undefined && !/^[0-9a-f]{40,64}$/.test(headSha)) {
    throw new Error('Head SHA must be a 40-64 character hexadecimal Git object ID.');
  }
  const reason = 'reason' in input ? input.reason.trim() : undefined;
  if (operation === 'revoke' && (reason === undefined || reason.length === 0 || reason.length > 500)) {
    throw new Error('Revoke reason must contain 1-500 characters.');
  }
  const identity = {
    operation,
    repo: base.repo.toLowerCase(),
    number: base.number,
    actor: base.actor,
    evidence: base.evidence,
    ...(headSha === undefined ? {} : { headSha }),
    ...(reason === undefined ? {} : { reason }),
  };
  return {
    operation,
    repo: base.repo,
    number: base.number,
    actor: base.actor,
    evidence: base.evidence,
    idempotencyKey: base.idempotencyKey,
    requestHash: createHash('sha256').update(canonical(identity)).digest('hex'),
    occurredAt: base.occurredAt,
    ...(headSha === undefined ? {} : { headSha }),
    ...(reason === undefined ? {} : { reason }),
  };
}

export class ReleaseGateControl {
  private readonly mutex: ShepherdMutationMutex;

  constructor(
    private readonly config: ShepherdConfig,
    private readonly github: GitHubProvider,
    private readonly store: ReleaseGateStore,
    private readonly clock: () => Date = () => new Date(),
    mutex?: ShepherdMutationMutex,
  ) {
    this.mutex = mutex ?? new ShepherdMutationMutex(store, clock);
  }

  async attest(input: ReleaseAttestInput): Promise<ReleaseControlResult> {
    this.assertAttestEnabled();
    const request = validatedRelease('attest', input, this.clock());
    const replay = this.store.getReleaseControlResult(request);
    if (replay !== undefined) return replay;
    return this.mutex.runExclusive(async () => {
      const tracked = this.currentTracked(request);
      let details: PullRequestDetails;
      try {
        details = await this.github.getPullRequest(request);
      } catch (error) {
        throw new Error(
          `Unable to verify release head; no attestation was recorded: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      if (details.state !== 'OPEN') throw new Error(`Cannot attest a ${details.state.toLowerCase()} pull request.`);
      if (details.headSha.toLowerCase() !== request.headSha) {
        throw new Error(`Attestation head does not match the current GitHub head ${details.headSha}.`);
      }
      if (this.github.getMergeAutomationState === undefined) {
        throw new Error('The GitHub provider cannot verify merge automation state for an exact-head attestation.');
      }
      const automation = await this.github.getMergeAutomationState(request);
      if (automation.headSha.toLowerCase() !== request.headSha) {
        throw new Error('The pull request head changed during release attestation; retry with the current head.');
      }
      if (automation.autoMergeEnabled || automation.queued) {
        throw new Error(
          'Disable persistent auto-merge and remove the pull request from the merge queue before attesting.',
        );
      }
      const event = buildEvent(
        this.config,
        'release-attested',
        request,
        { generation: tracked.generation, headSha: request.headSha },
        { actor: request.actor, evidence: request.evidence, title: details.title, url: details.url },
        request.occurredAt,
      );
      return this.store.attestRelease(request, tracked.generation, event, this.recipient());
    });
  }

  async revoke(input: ReleaseRevokeInput): Promise<ReleaseControlResult> {
    const request = validatedRelease('revoke', input, this.clock());
    const replay = this.store.getReleaseControlResult(request);
    if (replay !== undefined) {
      return replay.compensation === 'pending'
        ? this.mutex.runExclusive(() => this.runCompensations(request, replay))
        : replay;
    }
    return this.mutex.runExclusive(async () => {
      const tracked = this.currentTracked(request);
      const event = buildEvent(
        this.config,
        'release-revoked',
        request,
        { generation: tracked.generation, idempotencyKey: request.idempotencyKey },
        { actor: request.actor, reason: request.reason, evidence: request.evidence },
        request.occurredAt,
      );
      return this.runCompensations(
        request,
        this.store.revokeRelease(request, tracked.generation, event, this.recipient()),
      );
    });
  }

  private async runCompensations(
    request: ReleaseControlRequest,
    initial: ReleaseControlResult,
  ): Promise<ReleaseControlResult> {
    let result = initial;
    if (result.compensation !== 'pending') return result;
    if (result.compensationActionKeys.length === 0) {
      throw new Error('Release compensation is pending without a durable action.');
    }
    for (const actionKey of result.compensationActionKeys) {
      const action = this.store.getEntity<{ status: string; mutation: GitHubMutation }>(actionKey);
      if (action === undefined || !['dequeue', 'disable-auto-merge'].includes(action.value.mutation.type)) {
        throw new Error(`Release compensation action ${actionKey} is missing or invalid.`);
      }
      if (action.value.status === 'completed') continue;
      try {
        await this.github.mutate(action.value.mutation);
        const updated = this.store.completeReleaseCompensation(
          request.idempotencyKey,
          actionKey,
          this.clock().toISOString(),
        );
        if (updated !== undefined) result = { ...updated, idempotentReplay: initial.idempotentReplay };
      } catch (error) {
        this.store.logHealth(
          'release-compensation-failed',
          `${request.repo}#${String(request.number)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return result;
  }

  private currentTracked(pr: PullRequestRef) {
    const tracked = this.store.getTrackedPullRequest(pr);
    if (tracked?.status !== 'active')
      throw new Error(`No active tracked claim exists for ${pr.repo}#${String(pr.number)}.`);
    if (tracked.releaseGate !== 'exact-head-attestation') {
      throw new Error(
        'The active claim is not configured for exact-head attestation. Unclaim and reclaim it after enabling the gate.',
      );
    }
    return tracked;
  }

  private assertAttestEnabled(): void {
    this.assertTrackedEnabled();
    if (this.config.features.trackedPRs.releaseGate !== 'exact-head-attestation') {
      throw new Error('Release controls require trackedPRs with releaseGate: exact-head-attestation.');
    }
  }

  private assertTrackedEnabled(): void {
    if (!this.config.features.trackedPRs.enabled) {
      throw new Error('Release controls require features.trackedPRs.enabled: true.');
    }
  }

  private recipient(): string {
    return this.config.delivery.type === 'conductor' ? this.config.delivery.coordinatorSession : 'stdout';
  }
}
