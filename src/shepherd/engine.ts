import { createHash } from 'node:crypto';
import type { ShepherdConfig } from './config.js';
import { TrackedPullRequestControl } from './control.js';
import { buildEvent, eventId } from './events.js';
import { ShepherdMutationMutex } from './mutex.js';
import { patternMatches, repositoryInScope } from './scope.js';
import { elapsedHours } from './time.js';
import type {
  Comment,
  DiscoveryKind,
  EntityUpdate,
  GitHubMutation,
  GitHubProvider,
  HeadCheckSnapshot,
  MergeAutomationState,
  MergeQueueFailureAttribution,
  MergeQueueRemoval,
  PullRequestDetails,
  PullRequestRef,
  ReleaseGateStore,
  Review,
  ReviewThread,
  ReviewThreadComment,
  ShepherdEvent,
  ShepherdStore,
  TrackedPullRequest,
  TrackedPullRequestStore,
} from './types.js';

interface AuthoredState {
  details: PullRequestDetails;
  lastObservedAt: string;
  botAttempts: Record<string, number>;
  staleCycle: number;
  conflictCycle: number;
  readyForReviewCycle?: number;
  receivedReviewThreads?: Record<string, ReceivedReviewThreadState>;
  mergeQueueRetry?: MergeQueueRetryState;
  syncAfterRejectHead?: SyncAfterRejectHeadState;
  sources?: { authored: boolean; trackedGeneration?: number };
}

interface SyncAfterRejectHeadState {
  rejectedHeadSha: string;
  currentHeadSha: string;
  removalId: string;
  actionKey: string;
  priorCheckIds: string[];
  priorApprovalIds: string[];
  validation?: SyncAfterRejectValidationState;
}

interface SyncAfterRejectValidationState {
  actionKey: string;
  triggerComment: string;
  requiredCheck: string;
  priorCheckIds: string[];
}

interface MergeQueueRetryState {
  headSha: string;
  scope: string;
  attempts: number;
  lastActionKey?: string;
  observedQueued: boolean;
  exhausted: boolean;
  fence?: MergeQueueFence;
}

interface MergeQueueFence {
  repo: string;
  prNumber: number;
  headSha: string;
  trackedGeneration?: number;
  removalId: string;
  removalReason: string;
  classification: 'code-failure' | 'provider-evidence-ambiguous' | 'non-retryable-removal';
  createdAt: string;
  syncActionKey?: string;
}

interface ReceivedReviewThreadState {
  present: boolean;
  rootCommentId: string;
  seenCommentIds: string[];
  createdCycle: number;
  outdatedCycle: number;
  resolvedCycle: number;
  isOutdated: boolean;
  isResolved: boolean;
}

type ReceivedReviewReason =
  'review-submitted' | 'thread-created' | 'thread-replied' | 'thread-outdated' | 'thread-resolved';

interface ReceivedReviewRenderLimits {
  textBytes: number;
  reviews: number;
  threads: number;
  replies: number;
}

interface InboxState {
  details: PullRequestDetails;
  disposition: 'waiting' | 'dispatched' | 'auto-approved' | 'already-reviewed';
}

type InboxCompletionOutcome = 'bot-auto-approved' | 'already-reviewed';

const REVIEW_INBOX_EVENT_TYPES = ['review-dispatch', 'review-completed', 'scoped-re-review'] as const;
type ReviewLane = 'review-inbox' | 'review-follow-up';

interface ReviewExclusionState {
  excluded: boolean;
  cycle: number;
  details: PullRequestDetails;
}

interface FollowUpThreadState {
  rootCommentId: string;
  isOutdated: boolean;
  isResolved: boolean;
  seenCommentIds: string[];
  outdatedCycle: number;
  resolvedCycle: number;
}

interface FollowUpState {
  /** Legacy single-review cursor retained while upgrading persisted V2 entities. */
  reviewId?: string;
  trackedReviewIds?: string[];
  reviewedHeadSha: string;
  notifiedHeadSha: string | null;
  reviewRequested?: boolean;
  reviewRequestCycle?: number;
  threads?: Record<string, FollowUpThreadState>;
  details: PullRequestDetails;
}

type FollowUpReason = 'head-changed' | 'thread-replied' | 'thread-outdated' | 'thread-resolved' | 'review-requested';

interface NudgeState {
  reviewer: string;
  fixPushedAt: string;
  commentPostedAt: string | null;
  escalationReferenceAt?: string | null;
  lastEscalatedAt: string | null;
  escalationCount: number;
  details: PullRequestDetails;
}

interface ActionState {
  status: 'pending' | 'completed' | 'cancelled' | 'failed';
  mutation: GitHubMutation;
  expectedHeadSha?: string;
  attempts?: number;
  nextAttemptAt?: string;
  relatedNudgeKey?: string;
  relatedNudgeHeadSha?: string;
  completedAt?: string;
  trackedGeneration?: number;
  attestationHeadSha?: string;
  attestationId?: string;
  compensationFor?: string;
  compensatesActionKey?: string;
  enqueueAttempt?: number;
  queueScope?: string;
  queueObservationHeadSha?: string;
  syncAfterRejectRemovalId?: string;
  syncAfterRejectRemovedAt?: string;
  syncAfterRejectQueueStackAttribution?: MergeQueueFailureAttribution;
  syncAfterRejectHeadSha?: string;
  syncAfterRejectResultHeadSha?: string;
  syncAfterRejectPriorCheckIds?: string[];
  syncAfterRejectPriorApprovalIds?: string[];
  syncAfterRejectActionKey?: string;
  syncAfterRejectValidationActionKey?: string;
  syncAfterRejectValidationTriggerComment?: string;
  syncAfterRejectValidationRequiredCheck?: string;
  syncAfterRejectValidationPriorCheckIds?: string[];
}

type MergeQueueActionContext = Pick<
  ActionState,
  | 'trackedGeneration'
  | 'attestationHeadSha'
  | 'attestationId'
  | 'syncAfterRejectHeadSha'
  | 'syncAfterRejectPriorCheckIds'
  | 'syncAfterRejectPriorApprovalIds'
  | 'syncAfterRejectActionKey'
  | 'syncAfterRejectValidationActionKey'
  | 'syncAfterRejectValidationTriggerComment'
  | 'syncAfterRejectValidationRequiredCheck'
  | 'syncAfterRejectValidationPriorCheckIds'
>;

const MERGE_QUEUE_MAX_ATTEMPTS = 5;
const MERGE_QUEUE_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
const RETRYABLE_QUEUE_REMOVAL_REASONS = new Set(['checks_timed_out', 'stack_invalidated']);
const SYNC_AFTER_REJECT_RECENT_MS = 24 * 60 * 60_000;

export interface PollSummary {
  discovered: number;
  emitted: number;
  mutations: number;
  warnings: string[];
}

function normalizedQueueRemovalReason(reason: string | null): string {
  return (reason ?? '')
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '');
}

function mergeQueueRetryDisposition(removal: MergeQueueRemoval | undefined):
  | {
      retryable: true;
      classification: 'provider-confirmed-transient';
      fenceClassification: 'non-retryable-removal';
    }
  | {
      retryable: false;
      classification: 'code-failure-fenced' | 'provider-evidence-ambiguous-fenced' | 'non-retryable-removal-fenced';
      fenceClassification: MergeQueueFence['classification'];
    } {
  if (removal === undefined) {
    return {
      retryable: false,
      classification: 'provider-evidence-ambiguous-fenced',
      fenceClassification: 'provider-evidence-ambiguous',
    };
  }
  const reason = normalizedQueueRemovalReason(removal.reason);
  if (reason === 'failed_checks') {
    const mergeGroupRuns = removal.evidence?.workflowRuns.filter((run) => run.event === 'merge_group') ?? [];
    if (mergeGroupRuns.some((run) => run.conclusion === 'FAILURE')) {
      return {
        retryable: false,
        classification: 'code-failure-fenced',
        fenceClassification: 'code-failure',
      };
    }
    if (
      mergeGroupRuns.length > 0 &&
      mergeGroupRuns.every((run) =>
        ['CANCELLED', 'STALE', 'STARTUP_FAILURE', 'TIMED_OUT'].includes(run.conclusion ?? ''),
      )
    ) {
      return {
        retryable: true,
        classification: 'provider-confirmed-transient',
        fenceClassification: 'non-retryable-removal',
      };
    }
    return {
      retryable: false,
      classification: 'provider-evidence-ambiguous-fenced',
      fenceClassification: 'provider-evidence-ambiguous',
    };
  }
  if (RETRYABLE_QUEUE_REMOVAL_REASONS.has(reason)) {
    return {
      retryable: true,
      classification: 'provider-confirmed-transient',
      fenceClassification: 'non-retryable-removal',
    };
  }
  return {
    retryable: false,
    classification: reason === '' ? 'provider-evidence-ambiguous-fenced' : 'non-retryable-removal-fenced',
    fenceClassification: reason === '' ? 'provider-evidence-ambiguous' : 'non-retryable-removal',
  };
}

function syncAfterRejectRemovalTimeReason(createdAt: string, now: Date): string | undefined {
  const removedAt = new Date(createdAt).getTime();
  const ageMs = now.getTime() - removedAt;
  if (!Number.isFinite(removedAt) || ageMs < 0) return 'invalid-removal-time';
  if (ageMs > SYNC_AFTER_REJECT_RECENT_MS) return 'removal-is-not-recent';
  return undefined;
}

function syncAfterRejectAttributionReason(removal: MergeQueueRemoval | undefined): string | undefined {
  if (removal === undefined) return 'missing-removal-evidence';
  if (normalizedQueueRemovalReason(removal.reason) !== 'failed_checks') return 'removal-was-not-failed-checks';
  if (removal.evidence?.status !== 'complete') return 'ambiguous-provider-evidence';
  if (removal.evidence.queueStack.attribution === 'upstream-queued-pr') {
    return 'failure-belongs-to-upstream-queued-pr';
  }
  if (['ambiguous', 'unavailable'].includes(removal.evidence.queueStack.attribution)) {
    return 'ambiguous-queue-stack-attribution';
  }
  return undefined;
}

function syncAfterRejectEvidenceReason(removal: MergeQueueRemoval | undefined, now: Date): string | undefined {
  const attributionReason = syncAfterRejectAttributionReason(removal);
  if (attributionReason !== undefined || removal === undefined) return attributionReason;
  return syncAfterRejectRemovalTimeReason(removal.createdAt, now);
}

function prKey(kind: string, pr: PullRequestRef): string {
  return `${kind}:${pr.repo.toLowerCase()}#${String(pr.number)}`;
}

function latestReviews(reviews: Review[]): Review[] {
  const latest = new Map<string, Review>();
  for (const review of reviews) {
    const key = review.author.toLowerCase();
    const previous = latest.get(key);
    if (
      previous === undefined ||
      review.submittedAt > previous.submittedAt ||
      (review.submittedAt === previous.submittedAt && review.id > previous.id)
    ) {
      latest.set(key, review);
    }
  }
  return [...latest.values()];
}

function sortedComments(comments: Comment[]): Comment[] {
  return [...comments].sort((left, right) =>
    left.createdAt === right.createdAt
      ? left.id.localeCompare(right.id)
      : left.createdAt.localeCompare(right.createdAt),
  );
}

function sortedReviews(reviews: Review[]): Review[] {
  return [...reviews].sort((left, right) => {
    const byTime = left.submittedAt.localeCompare(right.submittedAt);
    return byTime === 0 ? left.id.localeCompare(right.id) : byTime;
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function excerpt(body: string, limit = 240): string {
  const compact = body.replace(/\s+/g, ' ').trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
}

const RECEIVED_REVIEW_EVENT_MAX_BYTES = 64 * 1024;
const RECEIVED_REVIEW_TEXT_MAX_BYTES = 4 * 1024;
const RECEIVED_REVIEW_GUIDANCE_MAX_BYTES = 4 * 1024;
const RECEIVED_REVIEW_TRANSITION_MAX_ITEMS = 25;

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function boundedText(value: string, maxBytes: number): { value: string; originalBytes: number; truncated: boolean } {
  const originalBytes = utf8Bytes(value);
  if (originalBytes <= maxBytes) return { value, originalBytes, truncated: false };
  if (maxBytes < 3) return { value: '', originalBytes, truncated: true };
  const kept: string[] = [];
  let keptBytes = 0;
  for (const character of value) {
    const characterBytes = utf8Bytes(character);
    if (keptBytes + characterBytes + 3 > maxBytes) break;
    kept.push(character);
    keptBytes += characterBytes;
  }
  return { value: `${kept.join('')}…`, originalBytes, truncated: true };
}

function boundedTransitionList(
  pr: PullRequestRef,
  field: string,
  values: string[],
): Record<string, string[] | string | number | boolean> {
  if (values.length <= RECEIVED_REVIEW_TRANSITION_MAX_ITEMS) return { [field]: values };
  return {
    [field]: values.slice(0, RECEIVED_REVIEW_TRANSITION_MAX_ITEMS),
    [`${field}Truncated`]: true,
    [`${field}Count`]: values.length,
    [`${field}Digest`]: eventId('review-feedback', pr, { field, values }),
  };
}

function inboxCompletionOutcome(disposition: InboxState['disposition']): InboxCompletionOutcome | undefined {
  if (disposition === 'auto-approved') return 'bot-auto-approved';
  if (disposition === 'already-reviewed') return 'already-reviewed';
  return undefined;
}

function supportsTrackedPullRequests(store: ShepherdStore): store is TrackedPullRequestStore {
  const candidate = store as Partial<TrackedPullRequestStore>;
  return (
    typeof candidate.getTrackedPullRequest === 'function' &&
    typeof candidate.listTrackedPullRequests === 'function' &&
    typeof candidate.commitTrackedObservation === 'function'
  );
}

function supportsReleaseGate(store: ShepherdStore): store is ReleaseGateStore {
  const candidate = store as Partial<ReleaseGateStore>;
  return (
    supportsTrackedPullRequests(store) &&
    typeof candidate.getReleaseGateStatus === 'function' &&
    typeof candidate.getReleaseAttestation === 'function' &&
    typeof candidate.getReleaseControlResult === 'function' &&
    typeof candidate.listReleaseControlOperations === 'function' &&
    typeof candidate.countReleaseControlOperations === 'function' &&
    typeof candidate.canUnclaimReleaseGate === 'function' &&
    typeof candidate.attestRelease === 'function' &&
    typeof candidate.revokeRelease === 'function' &&
    typeof candidate.reconcileReleaseCompensation === 'function' &&
    typeof candidate.completeReleaseCompensation === 'function' &&
    typeof candidate.prepareActionCancellation === 'function' &&
    typeof candidate.ensureActionSafetyCompensation === 'function' &&
    typeof candidate.tryAcquireMutationLock === 'function' &&
    typeof candidate.getMutationLock === 'function' &&
    typeof candidate.renewMutationLock === 'function' &&
    typeof candidate.tryTakeoverMutationLock === 'function' &&
    typeof candidate.releaseMutationLock === 'function'
  );
}

export class ShepherdEngine {
  private pollInFlight: Promise<PollSummary> | undefined;
  private mutationMutex: ShepherdMutationMutex | undefined;
  private readonly ignoredReviewInboxHeadPatterns: RegExp[];

  constructor(
    private readonly config: ShepherdConfig,
    private readonly github: GitHubProvider,
    private readonly store: ShepherdStore,
    private readonly clock: () => Date = () => new Date(),
    mutationMutex?: ShepherdMutationMutex,
  ) {
    this.mutationMutex = mutationMutex;
    this.ignoredReviewInboxHeadPatterns = config.features.reviewInbox.ignoredHeadPatterns.map(
      (pattern) => new RegExp(pattern, 'i'),
    );
  }

  pollOnce(): Promise<PollSummary> {
    if (this.pollInFlight !== undefined) return this.pollInFlight;
    this.pollInFlight = this.poll().finally(() => {
      this.pollInFlight = undefined;
    });
    return this.pollInFlight;
  }

  async drainActions(): Promise<number> {
    let completed = 0;
    if (supportsReleaseGate(this.store)) {
      const recoveredAt = this.clock().toISOString();
      for (const entity of this.store.listEntities<ActionState>('action')) {
        const queueAttemptWithoutCompensation =
          entity.value.mutation.type === 'enqueue-provider-ready' ||
          (entity.value.mutation.type === 'enqueue-exact-head' && entity.value.trackedGeneration === undefined);
        if (entity.value.status === 'cancelled' && !queueAttemptWithoutCompensation) {
          this.store.ensureActionSafetyCompensation(entity.key, recoveredAt);
        }
      }
    }
    for (const entity of this.store.listEntities<ActionState>('action')) {
      if (entity.value.status !== 'pending') continue;
      const safetyCompensation =
        entity.value.mutation.type === 'dequeue' || entity.value.mutation.type === 'disable-auto-merge';
      if (!safetyCompensation && !repositoryInScope(entity.value.mutation.pr.repo, this.config.github)) {
        this.cancelAction(entity.key, entity.value, 'repository is outside configured scope');
        continue;
      }
      if (!this.actionStillApplicable(entity.value)) {
        this.cancelAction(entity.key, entity.value, 'pull request state no longer satisfies the action preconditions');
        continue;
      }
      if (entity.value.relatedNudgeKey !== undefined && entity.value.relatedNudgeHeadSha !== undefined) {
        const nudge = this.store.getEntity<NudgeState>(entity.value.relatedNudgeKey);
        if (nudge?.value.details.headSha !== entity.value.relatedNudgeHeadSha) {
          this.cancelAction(entity.key, entity.value, 'reviewer nudge was superseded');
          continue;
        }
      }
      if (
        entity.value.nextAttemptAt !== undefined &&
        new Date(entity.value.nextAttemptAt).getTime() > this.clock().getTime()
      ) {
        continue;
      }
      try {
        if (entity.value.mutation.type === 'enable-auto-merge' && supportsReleaseGate(this.store)) {
          const mutated = await this.releaseMutex().runExclusive(async (lease) => {
            if (!this.actionStillApplicable(entity.value)) {
              this.cancelAction(entity.key, entity.value, 'ownership changed before persistent auto-merge');
              return false;
            }
            lease.assertOwned();
            await this.github.mutate(entity.value.mutation);
            lease.assertOwned();
            this.completeAction(entity.key, entity.value, this.clock().toISOString());
            return true;
          });
          if (mutated) completed += 1;
          continue;
        } else if (entity.value.mutation.type === 'enqueue-provider-ready') {
          const mutated = await this.releaseMutex().runExclusive(async (lease) => {
            if (!this.providerReadyActionContextStillApplicable(entity.value)) {
              this.cancelAction(entity.key, entity.value, 'tracked provider-ready ownership changed');
              return false;
            }
            if (this.github.getMergeAutomationState === undefined) {
              this.cancelAction(entity.key, entity.value, 'provider cannot observe merge-queue action availability');
              return false;
            }
            const automation = await this.github.getMergeAutomationState(entity.value.mutation.pr);
            if (!automation.queued && automation.enqueueAvailable !== true) {
              this.cancelAction(entity.key, entity.value, 'provider no longer exposes Add to merge queue');
              return false;
            }
            lease.assertOwned();
            await this.github.mutate(entity.value.mutation);
            lease.assertOwned();
            this.completeAction(entity.key, entity.value, this.clock().toISOString());
            return true;
          });
          if (mutated) completed += 1;
          continue;
        } else if (entity.value.mutation.type === 'sync-branch-exact-head') {
          const mutated = await this.releaseMutex().runExclusive(async (lease) => {
            const details = await this.github.getPullRequest(entity.value.mutation.pr);
            const automation = await this.mergeAutomationSnapshot(details);
            if (!this.syncAfterRejectActionStillApplicable(entity.key, entity.value, details, automation)) {
              this.cancelAction(entity.key, entity.value, 'sync-after-reject evidence is no longer applicable');
              return false;
            }
            lease.assertOwned();
            await this.github.mutate(entity.value.mutation);
            lease.assertOwned();
            const current = await this.github.getPullRequest(entity.value.mutation.pr);
            if (current.state !== 'OPEN') {
              throw new Error('GitHub pull request closed while confirming the conditional branch sync.');
            }
            this.completeAction(
              entity.key,
              { ...entity.value, syncAfterRejectResultHeadSha: current.headSha },
              this.clock().toISOString(),
            );
            return true;
          });
          if (mutated) completed += 1;
          continue;
        } else if (entity.value.mutation.type === 'post-pr-comment-exact-head') {
          const mutation = entity.value.mutation;
          const mutated = await this.releaseMutex().runExclusive(async (lease) => {
            const details = await this.github.getPullRequest(mutation.pr);
            const automation = await this.mergeAutomationSnapshot(details);
            if (!this.postSyncValidationActionStillApplicable(entity.key, entity.value, details, automation)) {
              this.cancelAction(entity.key, entity.value, 'post-sync validation trigger is no longer applicable');
              return false;
            }
            lease.assertOwned();
            await this.github.mutate(mutation);
            lease.assertOwned();
            const current = await this.github.getPullRequest(mutation.pr);
            if (current.headSha.toLowerCase() !== mutation.headSha.toLowerCase()) {
              throw new Error('GitHub head changed while posting the post-sync validation trigger.');
            }
            this.completeAction(entity.key, entity.value, this.clock().toISOString());
            return true;
          });
          if (mutated) completed += 1;
          continue;
        } else if (
          entity.value.mutation.type === 'merge-exact-head' ||
          entity.value.mutation.type === 'enqueue-exact-head'
        ) {
          const mutateExactHead = async (assertOwned: () => void): Promise<boolean> => {
            const details = await this.github.getPullRequest(entity.value.mutation.pr);
            const applicable =
              entity.value.syncAfterRejectHeadSha !== undefined &&
              entity.value.trackedGeneration !== undefined &&
              supportsTrackedPullRequests(this.store) &&
              this.store.getTrackedPullRequest(entity.value.mutation.pr)?.releaseGate === 'provider-action-ready'
                ? await this.providerReadySyncEnqueueStillApplicable(entity.value, details)
                : entity.value.trackedGeneration === undefined && entity.value.mutation.type === 'enqueue-exact-head'
                  ? this.actionStillApplicable(entity.value) &&
                    (await this.authoredQueueActionStillApplicable(entity.value, details))
                  : await this.gatedActionStillApplicable(entity.value, details);
            if (!applicable) {
              this.cancelAction(entity.key, entity.value, 'exact-head mutation is no longer applicable');
              return false;
            }
            assertOwned();
            await this.github.mutate(entity.value.mutation);
            assertOwned();
            this.completeAction(entity.key, entity.value, this.clock().toISOString());
            return true;
          };
          const mutated = supportsReleaseGate(this.store)
            ? await this.releaseMutex().runExclusive((lease) => mutateExactHead(() => lease.assertOwned()))
            : await mutateExactHead(() => undefined);
          if (mutated) completed += 1;
          continue;
        } else if (entity.value.mutation.type === 'dequeue' || entity.value.mutation.type === 'disable-auto-merge') {
          await this.releaseMutex().runExclusive(async (lease) => {
            lease.assertOwned();
            await this.github.mutate(entity.value.mutation);
            lease.assertOwned();
            const completedAt = this.clock().toISOString();
            if (entity.value.compensationFor !== undefined) {
              this.releaseStore().completeReleaseCompensation(entity.value.compensationFor, entity.key, completedAt);
            } else {
              this.completeAction(entity.key, entity.value, completedAt);
            }
          });
          completed += 1;
          continue;
        }
        await this.github.mutate(entity.value.mutation);
        const completedAt = this.clock().toISOString();
        const updates: EntityUpdate[] = [
          {
            key: entity.key,
            kind: 'action',
            value: { ...entity.value, status: 'completed', completedAt },
          },
        ];
        if (entity.value.relatedNudgeKey !== undefined) {
          const nudge = this.store.getEntity<NudgeState>(entity.value.relatedNudgeKey);
          if (nudge !== undefined) {
            updates.push({
              key: nudge.key,
              kind: 'nudge',
              value: { ...nudge.value, commentPostedAt: completedAt, escalationReferenceAt: completedAt },
            });
          }
        }
        this.store.commit(updates, []);
        completed += 1;
      } catch (error) {
        const attempts = (entity.value.attempts ?? 0) + 1;
        const message = error instanceof Error ? error.message : String(error);
        this.store.logHealth('github-mutation-failed', `${entity.key}: ${message.slice(0, 500)}`);
        if (
          (entity.value.mutation.type === 'enqueue-exact-head' ||
            entity.value.mutation.type === 'enqueue-provider-ready' ||
            entity.value.mutation.type === 'post-pr-comment-exact-head') &&
          attempts >= 5
        ) {
          this.store.commit(
            [
              {
                key: entity.key,
                kind: 'action',
                value: { ...entity.value, status: 'failed', attempts, completedAt: this.clock().toISOString() },
              },
            ],
            [],
          );
        } else if (
          (entity.value.mutation.type === 'update-branch' || entity.value.mutation.type === 'sync-branch-exact-head') &&
          attempts >= 5
        ) {
          const event = buildEvent(
            this.config,
            'branch-update-failed',
            entity.value.mutation.pr,
            { action: entity.key },
            { attempts, error: message.slice(0, 300) },
            this.clock().toISOString(),
          );
          this.store.commit(
            [
              {
                key: entity.key,
                kind: 'action',
                value: { ...entity.value, status: 'failed', attempts, completedAt: this.clock().toISOString() },
              },
            ],
            [event],
            this.recipient(),
          );
        } else {
          const delayMs = Math.min(300_000, 1_000 * 2 ** Math.min(attempts - 1, 8));
          this.store.commit(
            [
              {
                key: entity.key,
                kind: 'action',
                value: {
                  ...entity.value,
                  attempts,
                  nextAttemptAt: new Date(this.clock().getTime() + delayMs).toISOString(),
                },
              },
            ],
            [],
          );
        }
      }
    }
    return completed;
  }

  private cancelAction(key: string, action: ActionState, reason: string): void {
    const occurredAt = this.clock().toISOString();
    const queueAttemptWithoutCompensation =
      action.mutation.type === 'enqueue-provider-ready' ||
      (action.mutation.type === 'enqueue-exact-head' && action.trackedGeneration === undefined);
    if (supportsReleaseGate(this.store) && !queueAttemptWithoutCompensation) {
      this.store.prepareActionCancellation(key, occurredAt);
    } else {
      this.store.commit(
        [
          {
            key,
            kind: 'action',
            value: { ...action, status: 'cancelled', completedAt: occurredAt },
          },
        ],
        [],
      );
    }
    this.store.logHealth('github-mutation-cancelled', `${key}: ${reason}`);
  }

  private completeAction(key: string, action: ActionState, completedAt: string): void {
    this.store.commit(
      [{ key, kind: 'action', value: { ...action, status: 'completed', completedAt } satisfies ActionState }],
      [],
    );
  }

  private releaseStore(): ReleaseGateStore {
    if (!supportsReleaseGate(this.store))
      throw new Error('The Shepherd store does not support durable release mutations.');
    return this.store;
  }

  private releaseMutex(): ShepherdMutationMutex {
    this.mutationMutex ??= new ShepherdMutationMutex(this.releaseStore(), this.clock);
    return this.mutationMutex;
  }

  private actionStillApplicable(action: ActionState): boolean {
    if (action.mutation.type === 'dequeue' || action.mutation.type === 'disable-auto-merge') {
      return supportsReleaseGate(this.store);
    }
    if (action.mutation.type === 'enqueue-provider-ready') {
      return this.providerReadyActionContextStillApplicable(action);
    }
    if (action.mutation.type === 'sync-branch-exact-head') {
      const authored = this.store.getEntity<AuthoredState>(prKey('authored', action.mutation.pr))?.value;
      return (
        authored !== undefined &&
        this.syncAfterRejectOwnershipStillApplicable(action, authored) &&
        authored.details.state === 'OPEN' &&
        authored.details.headSha.toLowerCase() === action.mutation.headSha.toLowerCase() &&
        this.syncAfterRejectActionFenceMatches(action)
      );
    }
    if (action.mutation.type === 'post-pr-comment-exact-head') {
      const authored = this.store.getEntity<AuthoredState>(prKey('authored', action.mutation.pr))?.value;
      return (
        authored?.details.state === 'OPEN' &&
        authored.details.headSha.toLowerCase() === action.mutation.headSha.toLowerCase() &&
        authored.syncAfterRejectHead?.validation?.actionKey === action.syncAfterRejectValidationActionKey &&
        action.syncAfterRejectValidationActionKey !== undefined
      );
    }
    if (
      action.mutation.type === 'enqueue-exact-head' &&
      action.syncAfterRejectHeadSha !== undefined &&
      action.trackedGeneration !== undefined &&
      supportsTrackedPullRequests(this.store)
    ) {
      const tracked = this.store.getTrackedPullRequest(action.mutation.pr);
      const authored = this.store.getEntity<AuthoredState>(prKey('authored', action.mutation.pr))?.value;
      return (
        this.config.automation.syncAfterReject &&
        this.config.automation.autoMerge === 'execute' &&
        this.config.features.trackedPRs.enabled &&
        tracked?.status === 'active' &&
        tracked.generation === action.trackedGeneration &&
        tracked.releaseGate === 'provider-action-ready' &&
        authored?.details.state === 'OPEN' &&
        authored.details.headSha.toLowerCase() === action.syncAfterRejectHeadSha.toLowerCase()
      );
    }
    if (action.mutation.type === 'merge-exact-head' || action.trackedGeneration !== undefined) {
      return (
        this.config.features.trackedPRs.enabled &&
        this.config.features.trackedPRs.releaseGate === 'exact-head-attestation' &&
        supportsReleaseGate(this.store)
      );
    }
    const authored = this.store.getEntity<AuthoredState>(prKey('authored', action.mutation.pr))?.value;
    if (supportsReleaseGate(this.store)) {
      const tracked = this.store.getTrackedPullRequest(action.mutation.pr);
      if (tracked?.status === 'active' && tracked.releaseGate === 'exact-head-attestation') return false;
    }
    if (authored?.sources?.authored === false && authored.sources.trackedGeneration !== undefined) {
      if (!this.config.features.trackedPRs.enabled || !supportsTrackedPullRequests(this.store)) return false;
      const tracked = this.store.getTrackedPullRequest(action.mutation.pr);
      if (tracked?.status !== 'active' || tracked.generation !== authored.sources.trackedGeneration) return false;
      if (action.mutation.type === 'enable-auto-merge') return false;
    }
    if (action.mutation.type === 'post-reviewer-comment') return true;
    if (authored?.details.state !== 'OPEN') return false;
    const details = authored.details;
    if (action.expectedHeadSha !== undefined && details.headSha !== action.expectedHeadSha) return false;
    if (action.mutation.type === 'update-branch') {
      return (
        this.config.github.mode === 'direct' &&
        details.mergeStateStatus === 'BEHIND' &&
        details.mergeable === 'MERGEABLE'
      );
    }
    const reviews = latestReviews(details.reviews);
    const approvals = reviews.filter((review) => review.state === 'APPROVED');
    const changesRequested = reviews.some((review) => review.state === 'CHANGES_REQUESTED');
    const directBehind = this.config.github.mode === 'direct' && details.mergeStateStatus === 'BEHIND';
    return (
      details.autoMergeRequest === null &&
      details.mergeable === 'MERGEABLE' &&
      !directBehind &&
      this.checksReady(details) &&
      !changesRequested &&
      approvals.length >= this.config.reviews.requiredApprovals
    );
  }

  private syncAfterRejectOwnershipStillApplicable(action: ActionState, authored: AuthoredState): boolean {
    if (
      !this.config.automation.syncAfterReject ||
      this.config.automation.autoMerge !== 'execute' ||
      this.config.github.mode !== 'merge-queue'
    ) {
      return false;
    }
    if (authored.sources?.authored !== false) return true;
    if (
      action.trackedGeneration === undefined ||
      !this.config.features.trackedPRs.enabled ||
      !supportsTrackedPullRequests(this.store)
    ) {
      return false;
    }
    const tracked = this.store.getTrackedPullRequest(action.mutation.pr);
    return tracked?.status === 'active' && tracked.generation === action.trackedGeneration;
  }

  private syncAfterRejectActionFenceMatches(action: ActionState): boolean {
    if (
      action.mutation.type !== 'sync-branch-exact-head' ||
      action.syncAfterRejectRemovalId === undefined ||
      action.syncAfterRejectRemovedAt === undefined ||
      syncAfterRejectRemovalTimeReason(action.syncAfterRejectRemovedAt, this.clock()) !== undefined
    ) {
      return false;
    }
    const fence = this.recoverMergeQueueFence(action.mutation.pr, action.mutation.headSha);
    return fence?.removalId === action.syncAfterRejectRemovalId && fence.syncActionKey !== undefined;
  }

  private syncAfterRejectActionStillApplicable(
    key: string,
    action: ActionState,
    details: PullRequestDetails,
    automation: MergeAutomationState | undefined,
  ): boolean {
    if (
      action.mutation.type !== 'sync-branch-exact-head' ||
      action.syncAfterRejectRemovalId === undefined ||
      details.state !== 'OPEN' ||
      details.headSha.toLowerCase() !== action.mutation.headSha.toLowerCase() ||
      automation === undefined ||
      automation.queued ||
      automation.headSha.toLowerCase() !== action.mutation.headSha.toLowerCase() ||
      automation.latestQueueRemoval?.id !== action.syncAfterRejectRemovalId ||
      syncAfterRejectEvidenceReason(automation.latestQueueRemoval, this.clock()) !== undefined
    ) {
      return false;
    }
    const authored = this.store.getEntity<AuthoredState>(prKey('authored', action.mutation.pr))?.value;
    if (authored === undefined || !this.syncAfterRejectOwnershipStillApplicable(action, authored)) return false;
    const fence = this.recoverMergeQueueFence(action.mutation.pr, action.mutation.headSha);
    return fence?.removalId === action.syncAfterRejectRemovalId && fence.syncActionKey === key;
  }

  private syncAfterRejectValidationObligationApplies(
    syncState: Pick<SyncAfterRejectHeadState, 'rejectedHeadSha' | 'currentHeadSha' | 'removalId' | 'actionKey'>,
    removal?: MergeQueueRemoval,
  ): boolean {
    const syncAction = this.store.getEntity<ActionState>(syncState.actionKey)?.value;
    if (
      syncAction?.mutation.type !== 'sync-branch-exact-head' ||
      syncAction.mutation.headSha.toLowerCase() !== syncState.rejectedHeadSha.toLowerCase() ||
      syncAction.syncAfterRejectRemovalId !== syncState.removalId
    ) {
      return false;
    }
    const attribution = syncAction.syncAfterRejectQueueStackAttribution;
    if (
      attribution === undefined
        ? removal?.id !== syncState.removalId || syncAfterRejectAttributionReason(removal) !== undefined
        : attribution !== 'branch-local' && attribution !== 'current-main-interaction'
    ) {
      return false;
    }
    if (syncState.currentHeadSha.toLowerCase() !== syncState.rejectedHeadSha.toLowerCase()) return true;
    return (
      syncAction.status === 'completed' &&
      syncAction.syncAfterRejectResultHeadSha?.toLowerCase() === syncState.currentHeadSha.toLowerCase()
    );
  }

  private postSyncValidationActionStillApplicable(
    key: string,
    action: ActionState,
    details: PullRequestDetails,
    automation: MergeAutomationState | undefined,
  ): boolean {
    const validationConfig = this.config.automation.syncAfterRejectValidation;
    if (
      action.mutation.type !== 'post-pr-comment-exact-head' ||
      action.syncAfterRejectActionKey === undefined ||
      action.syncAfterRejectValidationActionKey !== key ||
      action.syncAfterRejectValidationTriggerComment === undefined ||
      action.syncAfterRejectValidationRequiredCheck === undefined ||
      action.syncAfterRejectValidationPriorCheckIds === undefined ||
      validationConfig?.triggerComment !== action.syncAfterRejectValidationTriggerComment ||
      validationConfig?.requiredCheck !== action.syncAfterRejectValidationRequiredCheck ||
      action.mutation.body !== action.syncAfterRejectValidationTriggerComment ||
      !Number.isFinite(new Date(action.mutation.notBefore).getTime()) ||
      details.state !== 'OPEN' ||
      details.headSha.toLowerCase() !== action.mutation.headSha.toLowerCase() ||
      automation?.queued !== false ||
      automation?.headSha.toLowerCase() !== action.mutation.headSha.toLowerCase()
    ) {
      return false;
    }
    const authored = this.store.getEntity<AuthoredState>(prKey('authored', action.mutation.pr))?.value;
    const syncState = authored?.syncAfterRejectHead;
    const validationState = syncState?.validation;
    return (
      authored !== undefined &&
      this.syncAfterRejectOwnershipStillApplicable(action, authored) &&
      syncState?.actionKey === action.syncAfterRejectActionKey &&
      syncState.currentHeadSha.toLowerCase() === action.mutation.headSha.toLowerCase() &&
      validationState?.actionKey === key &&
      validationState.triggerComment === action.syncAfterRejectValidationTriggerComment &&
      validationState.requiredCheck === action.syncAfterRejectValidationRequiredCheck &&
      validationState.priorCheckIds.join('\u0000') === action.syncAfterRejectValidationPriorCheckIds.join('\u0000') &&
      this.syncAfterRejectValidationObligationApplies(syncState, automation?.latestQueueRemoval)
    );
  }

  private providerReadyActionContextStillApplicable(action: ActionState): boolean {
    if (
      action.mutation.type !== 'enqueue-provider-ready' ||
      action.trackedGeneration === undefined ||
      !this.config.features.trackedPRs.enabled ||
      this.config.features.trackedPRs.releaseGate !== 'provider-action-ready' ||
      !supportsTrackedPullRequests(this.store) ||
      !supportsReleaseGate(this.store)
    ) {
      return false;
    }
    const tracked = this.store.getTrackedPullRequest(action.mutation.pr);
    return (
      tracked?.status === 'active' &&
      tracked.generation === action.trackedGeneration &&
      tracked.releaseGate === 'provider-action-ready'
    );
  }

  private async authoredQueueActionStillApplicable(action: ActionState, details: PullRequestDetails): Promise<boolean> {
    if (action.mutation.type !== 'enqueue-exact-head' || this.config.github.mode !== 'merge-queue') return false;
    if (
      action.syncAfterRejectHeadSha !== undefined &&
      (action.syncAfterRejectPriorCheckIds === undefined || action.syncAfterRejectPriorApprovalIds === undefined)
    ) {
      return false;
    }
    if (details.state !== 'OPEN' || details.headSha !== action.mutation.headSha || details.autoMergeRequest !== null) {
      return false;
    }
    const reviews = latestReviews(details.reviews);
    const approvals = reviews.filter(
      (review) =>
        review.state === 'APPROVED' &&
        (action.syncAfterRejectHeadSha === undefined ||
          (review.commitSha?.toLowerCase() === details.headSha.toLowerCase() &&
            !action.syncAfterRejectPriorApprovalIds?.includes(review.id))),
    );
    return (
      details.mergeable === 'MERGEABLE' &&
      this.checksReady(details, action.syncAfterRejectPriorCheckIds) &&
      (await this.postSyncValidationActionReady(action, details)) &&
      !reviews.some((review) => review.state === 'CHANGES_REQUESTED') &&
      approvals.length >= this.config.reviews.requiredApprovals
    );
  }

  private async providerReadySyncEnqueueStillApplicable(
    action: ActionState,
    details: PullRequestDetails,
  ): Promise<boolean> {
    if (
      action.mutation.type !== 'enqueue-exact-head' ||
      action.trackedGeneration === undefined ||
      action.syncAfterRejectHeadSha?.toLowerCase() !== details.headSha.toLowerCase() ||
      !this.config.automation.syncAfterReject ||
      this.config.automation.autoMerge !== 'execute' ||
      !this.config.features.trackedPRs.enabled ||
      !supportsTrackedPullRequests(this.store) ||
      this.github.getMergeAutomationState === undefined
    ) {
      return false;
    }
    const tracked = this.store.getTrackedPullRequest(action.mutation.pr);
    if (
      tracked?.status !== 'active' ||
      tracked.generation !== action.trackedGeneration ||
      tracked.releaseGate !== 'provider-action-ready' ||
      !(await this.authoredQueueActionStillApplicable(action, details))
    ) {
      return false;
    }
    const automation = await this.github.getMergeAutomationState(action.mutation.pr);
    return (
      automation.headSha.toLowerCase() === details.headSha.toLowerCase() &&
      (automation.queued || automation.enqueueAvailable === true)
    );
  }

  private async gatedActionStillApplicable(action: ActionState, details: PullRequestDetails): Promise<boolean> {
    if (
      action.trackedGeneration === undefined ||
      action.attestationHeadSha === undefined ||
      action.attestationId === undefined ||
      !this.config.features.trackedPRs.enabled ||
      this.config.features.trackedPRs.releaseGate !== 'exact-head-attestation' ||
      !supportsReleaseGate(this.store)
    )
      return false;
    if (
      action.syncAfterRejectHeadSha !== undefined &&
      (action.syncAfterRejectPriorCheckIds === undefined || action.syncAfterRejectPriorApprovalIds === undefined)
    ) {
      return false;
    }
    const tracked = this.store.getTrackedPullRequest(action.mutation.pr);
    if (
      tracked?.status !== 'active' ||
      tracked.generation !== action.trackedGeneration ||
      tracked.releaseGate !== 'exact-head-attestation' ||
      details.state !== 'OPEN' ||
      details.headSha !== action.attestationHeadSha ||
      this.store.getReleaseGateStatus(details, tracked.generation, details.headSha) !== 'applicable' ||
      this.store.getReleaseAttestation(details, tracked.generation, details.headSha)?.idempotencyKey !==
        action.attestationId
    )
      return false;
    const reviews = latestReviews(details.reviews);
    const approvals = reviews.filter(
      (review) =>
        review.state === 'APPROVED' &&
        (action.syncAfterRejectHeadSha === undefined ||
          (review.commitSha?.toLowerCase() === details.headSha.toLowerCase() &&
            !action.syncAfterRejectPriorApprovalIds?.includes(review.id))),
    );
    const directBehind = this.config.github.mode === 'direct' && details.mergeStateStatus === 'BEHIND';
    return (
      details.mergeable === 'MERGEABLE' &&
      !directBehind &&
      this.checksReady(details, action.syncAfterRejectPriorCheckIds) &&
      (await this.postSyncValidationActionReady(action, details)) &&
      !reviews.some((review) => review.state === 'CHANGES_REQUESTED') &&
      approvals.length >= this.config.reviews.requiredApprovals
    );
  }

  private async postSyncValidationActionReady(action: ActionState, details: PullRequestDetails): Promise<boolean> {
    const actionKey = action.syncAfterRejectValidationActionKey;
    const requiredCheck = action.syncAfterRejectValidationRequiredCheck;
    const triggerComment = action.syncAfterRejectValidationTriggerComment;
    const priorCheckIds = action.syncAfterRejectValidationPriorCheckIds;
    const hasAnyValidationField =
      actionKey !== undefined ||
      requiredCheck !== undefined ||
      triggerComment !== undefined ||
      priorCheckIds !== undefined;
    if (!hasAnyValidationField) return true;
    const configured = this.config.automation.syncAfterRejectValidation;
    if (
      !this.config.automation.syncAfterReject ||
      this.config.automation.autoMerge !== 'execute' ||
      actionKey === undefined ||
      requiredCheck === undefined ||
      triggerComment === undefined ||
      priorCheckIds === undefined ||
      configured?.requiredCheck !== requiredCheck ||
      configured?.triggerComment !== triggerComment ||
      this.store.getEntity<ActionState>(actionKey)?.value.status !== 'completed' ||
      this.github.getCheckRunsForHead === undefined
    ) {
      return false;
    }
    const authored = this.store.getEntity<AuthoredState>(prKey('authored', action.mutation.pr))?.value;
    const validation = authored?.syncAfterRejectHead?.validation;
    if (
      authored?.syncAfterRejectHead?.currentHeadSha.toLowerCase() !== details.headSha.toLowerCase() ||
      validation?.actionKey !== actionKey ||
      validation.requiredCheck !== requiredCheck ||
      validation.triggerComment !== triggerComment
    ) {
      return false;
    }
    const snapshot = await this.github.getCheckRunsForHead(details, details.headSha);
    if (!snapshot.exhaustive || snapshot.headSha.toLowerCase() !== details.headSha.toLowerCase()) return false;
    const prior = new Set(priorCheckIds);
    const fresh = snapshot.checks.filter((check) => check.name === requiredCheck && !prior.has(check.id));
    return fresh.some((check) => check.bucket === 'pass' && check.state.toUpperCase() === 'SUCCESS');
  }

  private async poll(): Promise<PollSummary> {
    const summary: PollSummary = { discovered: 0, emitted: 0, mutations: 0, warnings: [] };
    if (this.config.features.trackedPRs.enabled && this.config.features.trackedPRs.selectors.length > 0) {
      await this.runFeature('tracked-selectors', () => this.pollTrackedSelectors(summary), summary);
    }
    if (this.config.features.authoredPRs.enabled || this.config.features.trackedPRs.enabled) {
      await this.runFeature('authored', () => this.pollAuthored(summary), summary);
    }
    if (this.config.features.reviewInbox.enabled) {
      await this.runFeature('review-inbox', () => this.pollInbox(summary), summary);
    }
    if (this.config.features.reviewFollowUp.enabled) {
      await this.runFeature('review-follow-up', () => this.pollFollowUps(summary), summary);
    }
    if (this.config.features.reviewerNudge.enabled) {
      await this.runFeature('reviewer-nudge', () => this.pollNudges(summary), summary);
    }
    summary.mutations = await this.drainActions();
    return summary;
  }

  private async runFeature(
    name: DiscoveryKind | 'tracked-selectors',
    run: () => Promise<void>,
    summary: PollSummary,
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      const detail = `${name}: ${error instanceof Error ? error.message : String(error)}`;
      summary.warnings.push(detail);
      this.store.logHealth('feature-poll-failed', detail);
    }
  }

  private async pollTrackedSelectors(summary: PollSummary): Promise<void> {
    if (this.github.discoverTrackedPullRequests === undefined) {
      throw new Error('The GitHub provider does not support configured tracked pull-request selectors.');
    }
    const store = this.trackedStore();
    const discovery = await this.github.discoverTrackedPullRequests(this.config.features.trackedPRs.selectors);
    if (discovery.warning !== undefined) {
      summary.warnings.push(discovery.warning);
      this.store.logHealth('github-coverage-warning', `tracked-selectors: ${discovery.warning}`);
    }
    const control = new TrackedPullRequestControl(this.config, this.github, store, this.clock, this.mutationMutex);
    for (const candidate of discovery.items
      .filter((item) => repositoryInScope(item.repo, this.config.github))
      .sort((left, right) => {
        const leftKey = `${left.repo.toLowerCase()}#${String(left.number).padStart(12, '0')}`;
        const rightKey = `${right.repo.toLowerCase()}#${String(right.number).padStart(12, '0')}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      })) {
      // Any durable row is authoritative. In particular, an explicit unclaim is a tombstone and
      // selectors must not immediately reclaim it; only a later explicit claim starts a generation.
      if (store.getTrackedPullRequest(candidate) !== undefined) continue;
      await this.runItem(
        'tracked-selectors',
        candidate,
        async () => {
          const matches = [...candidate.matches].sort((left, right) => {
            const leftKey = `${left.selectorId}\u0000${left.type}\u0000${left.value}`;
            const rightKey = `${right.selectorId}\u0000${right.type}\u0000${right.value}`;
            return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
          });
          const identity = JSON.stringify({ repo: candidate.repo.toLowerCase(), number: candidate.number, matches });
          const digest = createHash('sha256').update(identity).digest('hex');
          const result = await control.claimIfUntracked({
            repo: candidate.repo,
            number: candidate.number,
            actor: `selector:${matches[0]?.selectorId ?? 'configured'}`,
            evidence: {
              summary: 'Matched configured tracked pull-request selector.',
              selectors: matches,
              references: [candidate.url],
            },
            idempotencyKey: `selector-claim:${digest}`,
          });
          if (result.outcome === 'claimed' || result.outcome === 'reclaimed') {
            const claimedDetails = store.getEntity<AuthoredState>(prKey('authored', candidate))?.value.details;
            if (!(this.config.features.trackedPRs.suppressDraftEvents && claimedDetails?.isDraft === true)) {
              summary.emitted += 1;
            }
          }
        },
        summary,
      );
    }
  }

  private async discover(
    kind: DiscoveryKind,
    summary: PollSummary,
  ): Promise<Awaited<ReturnType<GitHubProvider['discover']>>> {
    const result = await this.github.discover(kind, this.config.profile.githubUser);
    if (result.warning !== undefined) {
      summary.warnings.push(result.warning);
      this.store.logHealth('github-coverage-warning', `${kind}: ${result.warning}`);
    }
    result.items = result.items.filter((item) => repositoryInScope(item.repo, this.config.github));
    summary.discovered += result.items.length;
    return result;
  }

  private async pollAuthored(summary: PollSummary): Promise<void> {
    const discovery = this.config.features.authoredPRs.enabled
      ? await this.discover('authored', summary)
      : { items: [], exhaustive: true };
    const isBaseline = this.isBaseline('authored');
    const observed = new Set<string>();
    const activeTracked = this.config.features.trackedPRs.enabled
      ? this.trackedStore()
          .listTrackedPullRequests('active')
          .filter((tracked) => repositoryInScope(tracked.repo, this.config.github))
      : [];
    const trackedByKey = new Map(activeTracked.map((tracked) => [prKey('authored', tracked), tracked]));
    const candidates = new Map<string, PullRequestRef>();
    const authoredKeys = new Set<string>();

    for (const item of discovery.items) {
      const key = prKey('authored', item);
      if (item.isDraft && !trackedByKey.has(key)) continue;
      candidates.set(key, item);
      authoredKeys.add(key);
    }
    for (const tracked of activeTracked) candidates.set(prKey('authored', tracked), tracked);
    summary.discovered += [...candidates.keys()].filter(
      (key) => !discovery.items.some((item) => prKey('authored', item) === key),
    ).length;

    for (const [candidateKey, item] of candidates) {
      observed.add(candidateKey);
      await this.runItem(
        'authored',
        item,
        async () => {
          const details = await this.github.getPullRequest(item);
          if (!repositoryInScope(details.repo, this.config.github)) return;
          const key = prKey('authored', details);
          observed.add(key);
          const previous = this.store.getEntity<AuthoredState>(key)?.value;
          const tracked = trackedByKey.get(key);
          const mergeAutomation = await this.mergeAutomationSnapshot(
            details,
            tracked?.releaseGate !== 'provider-action-ready',
          );
          const postSyncChecks = await this.postSyncValidationSnapshot(details, previous, mergeAutomation);
          const baseline = isBaseline || (previous === undefined && tracked?.baselinePending === true);
          const { state, events, actions, nudges } = this.evaluateAuthored(
            details,
            previous,
            baseline,
            tracked,
            authoredKeys.has(key),
            mergeAutomation,
            postSyncChecks,
          );
          if (tracked !== undefined) {
            const result = this.trackedStore().commitTrackedObservation(
              details,
              tracked.generation,
              [{ key, kind: 'authored', value: state }, ...actions, ...nudges],
              events,
              this.recipient(),
              details.state === 'OPEN' ? [] : this.relatedEntityKeys(details, key),
              details.state === 'OPEN' ? undefined : details.state,
            );
            summary.emitted += result.inserted.length;
            if (!result.applied && authoredKeys.has(key)) {
              const currentTracked = this.trackedStore().getTrackedPullRequest(details);
              if (currentTracked?.status === 'active') return;
              const fallback = this.evaluateAuthored(
                details,
                previous,
                isBaseline,
                undefined,
                true,
                mergeAutomation,
                postSyncChecks,
              );
              const fallbackResult = this.trackedStore().commitAuthoredObservationAfterTrackedRelease(
                details,
                tracked.generation,
                [{ key, kind: 'authored', value: fallback.state }, ...fallback.actions, ...fallback.nudges],
                fallback.events,
                this.recipient(),
                details.state === 'OPEN' ? [] : this.relatedEntityKeys(details, key),
              );
              summary.emitted += fallbackResult.inserted.length;
            }
          } else {
            summary.emitted += this.store.commit(
              [{ key, kind: 'authored', value: state }, ...actions, ...nudges],
              events,
              this.recipient(),
              details.state === 'OPEN' ? [] : this.relatedEntityKeys(details, key),
            ).length;
          }
        },
        summary,
      );
    }

    if (this.config.features.authoredPRs.enabled && discovery.exhaustive) {
      await this.cleanupMissingAuthored(observed, summary, isBaseline, trackedByKey);
    }
    this.cleanupReleasedTrackedLifecycle();
    if (!this.store.hasCompletedBootstrap('authored')) this.store.markBootstrapComplete('authored');
  }

  private cleanupReleasedTrackedLifecycle(): void {
    for (const entity of this.store.listEntities<AuthoredState>('authored')) {
      const sources = entity.value.sources;
      if (sources?.authored !== false || sources.trackedGeneration === undefined) continue;
      const tracked = this.trackedStore().getTrackedPullRequest(entity.value.details);
      if (tracked?.status === 'active' && tracked.generation === sources.trackedGeneration) continue;
      this.store.commit([], [], undefined, this.relatedEntityKeys(entity.value.details, entity.key));
    }
  }

  private async mergeAutomationSnapshot(
    details: PullRequestDetails,
    requireMatchingHead = true,
  ): Promise<MergeAutomationState | undefined> {
    if (this.config.github.mode !== 'merge-queue') return undefined;
    if (this.github.getMergeAutomationState === undefined) return undefined;
    const state = await this.github.getMergeAutomationState(details);
    if (requireMatchingHead && state.headSha.toLowerCase() !== details.headSha.toLowerCase()) {
      throw new Error(
        `GitHub head changed while observing merge-queue state for ${details.repo}#${String(details.number)}.`,
      );
    }
    return state;
  }

  private async postSyncValidationSnapshot(
    details: PullRequestDetails,
    previous: AuthoredState | undefined,
    automation: MergeAutomationState | undefined,
  ): Promise<HeadCheckSnapshot | undefined> {
    const configured =
      this.config.automation.syncAfterReject &&
      this.config.automation.autoMerge === 'execute' &&
      this.config.automation.syncAfterRejectValidation !== null;
    const existing = previous?.syncAfterRejectHead;
    const previousFence = previous?.mergeQueueRetry?.fence;
    const fenceState =
      previousFence?.syncActionKey === undefined
        ? undefined
        : {
            rejectedHeadSha: previousFence.headSha,
            currentHeadSha: details.headSha,
            removalId: previousFence.removalId,
            actionKey: previousFence.syncActionKey,
          };
    const existingState = existing === undefined ? undefined : { ...existing, currentHeadSha: details.headSha };
    const applies =
      (existingState !== undefined &&
        this.syncAfterRejectValidationObligationApplies(existingState, automation?.latestQueueRemoval)) ||
      (fenceState !== undefined &&
        this.syncAfterRejectValidationObligationApplies(fenceState, automation?.latestQueueRemoval));
    if (!configured || !applies) return undefined;
    if (this.github.getCheckRunsForHead === undefined) {
      throw new Error('The GitHub provider cannot observe exact-head check runs for post-sync validation.');
    }
    const snapshot = await this.github.getCheckRunsForHead(details, details.headSha);
    if (snapshot.headSha.toLowerCase() !== details.headSha.toLowerCase()) {
      throw new Error(
        `GitHub returned post-sync checks for ${snapshot.headSha}, expected ${details.headSha} for ${details.repo}#${String(details.number)}.`,
      );
    }
    if (!snapshot.exhaustive) {
      throw new Error(
        `GitHub returned incomplete post-sync checks for ${details.repo}#${String(details.number)}@${details.headSha}.`,
      );
    }
    return snapshot;
  }

  private evaluateAuthored(
    details: PullRequestDetails,
    previous: AuthoredState | undefined,
    baseline: boolean,
    trackedClaim?: TrackedPullRequest,
    authored = true,
    mergeAutomation?: MergeAutomationState,
    postSyncChecks?: HeadCheckSnapshot,
  ): { state: AuthoredState; events: ShepherdEvent[]; actions: EntityUpdate[]; nudges: EntityUpdate[] } {
    const now = this.clock();
    const events: ShepherdEvent[] = [];
    const actions: EntityUpdate[] = [];
    const nudges: EntityUpdate[] = [];
    const pr: PullRequestRef = { repo: details.repo, number: details.number };
    const previousDetails = previous?.details;
    const tracked = trackedClaim !== undefined;
    const trackedGeneration = trackedClaim?.generation;
    const botAttempts = { ...(previous?.botAttempts ?? {}) };
    let staleCycle = previous?.staleCycle ?? 0;
    let conflictCycle = previous?.conflictCycle ?? 0;
    let readyForReviewCycle = previous?.readyForReviewCycle ?? 0;
    let mergeQueueRetry = previous?.mergeQueueRetry?.headSha === details.headSha ? previous.mergeQueueRetry : undefined;
    const validationConfig = this.config.automation.syncAfterRejectValidation;
    const previousSyncState = previous?.syncAfterRejectHead;
    let syncAfterRejectHead =
      previousSyncState?.currentHeadSha.toLowerCase() === details.headSha.toLowerCase() &&
      (validationConfig === null ||
        this.syncAfterRejectValidationObligationApplies(previousSyncState, mergeAutomation?.latestQueueRemoval))
        ? previousSyncState
        : undefined;
    let mayStartPostSyncValidation = false;
    const previousSyncFence = previous?.mergeQueueRetry?.fence;
    const reboundSyncState =
      previousSyncState === undefined
        ? undefined
        : { ...previousSyncState, currentHeadSha: details.headSha, validation: undefined };
    if (
      validationConfig !== null &&
      reboundSyncState !== undefined &&
      this.syncAfterRejectValidationObligationApplies(reboundSyncState, mergeAutomation?.latestQueueRemoval)
    ) {
      syncAfterRejectHead ??= {
        ...reboundSyncState,
        priorCheckIds: (previousDetails?.checks ?? []).map((check) => check.id).sort(),
        priorApprovalIds: latestReviews(previousDetails?.reviews ?? [])
          .filter((review) => review.state === 'APPROVED')
          .map((review) => review.id)
          .sort(),
      };
      mayStartPostSyncValidation = syncAfterRejectHead.validation === undefined;
    } else if (previousSyncFence?.syncActionKey !== undefined && previousDetails !== undefined) {
      const syncAction = this.store.getEntity<ActionState>(previousSyncFence.syncActionKey)?.value;
      const fenceState = {
        rejectedHeadSha: previousSyncFence.headSha,
        currentHeadSha: details.headSha,
        removalId: previousSyncFence.removalId,
        actionKey: previousSyncFence.syncActionKey,
      };
      if (
        previousSyncFence.headSha.toLowerCase() === previousDetails.headSha.toLowerCase() &&
        (validationConfig === null
          ? syncAction?.status === 'completed' &&
            syncAction.syncAfterRejectResultHeadSha?.toLowerCase() === details.headSha.toLowerCase()
          : this.syncAfterRejectValidationObligationApplies(fenceState, mergeAutomation?.latestQueueRemoval))
      ) {
        syncAfterRejectHead = {
          rejectedHeadSha: previousSyncFence.headSha,
          currentHeadSha: details.headSha,
          removalId: previousSyncFence.removalId,
          actionKey: previousSyncFence.syncActionKey,
          priorCheckIds: previousDetails.checks.map((check) => check.id).sort(),
          priorApprovalIds: latestReviews(previousDetails.reviews)
            .filter((review) => review.state === 'APPROVED')
            .map((review) => review.id)
            .sort(),
        };
        mayStartPostSyncValidation = validationConfig !== null;
      }
    }
    if (
      !baseline &&
      mayStartPostSyncValidation &&
      syncAfterRejectHead !== undefined &&
      syncAfterRejectHead.validation === undefined &&
      validationConfig !== null
    ) {
      if (postSyncChecks === undefined) {
        throw new Error(
          `Missing exact-head check snapshot for post-sync validation on ${details.repo}#${String(details.number)}.`,
        );
      }
      const identity = createHash('sha256')
        .update(
          [
            details.repo.toLowerCase(),
            String(details.number),
            syncAfterRejectHead.actionKey,
            details.headSha.toLowerCase(),
            validationConfig.triggerComment,
            validationConfig.requiredCheck,
          ].join('\u0000'),
        )
        .digest('hex')
        .slice(0, 24);
      const actionKey = `${prKey('action:post-sync-validation', pr)}:${identity}`;
      const validation: SyncAfterRejectValidationState = {
        actionKey,
        triggerComment: validationConfig.triggerComment,
        requiredCheck: validationConfig.requiredCheck,
        priorCheckIds: postSyncChecks.checks
          .filter((check) => check.name === validationConfig.requiredCheck)
          .map((check) => check.id)
          .sort(),
      };
      syncAfterRejectHead = { ...syncAfterRejectHead, validation };
      if (this.store.getEntity<ActionState>(actionKey) === undefined) {
        actions.push({
          key: actionKey,
          kind: 'action',
          value: {
            status: 'pending',
            mutation: {
              type: 'post-pr-comment-exact-head',
              pr,
              headSha: details.headSha,
              body: validationConfig.triggerComment,
              notBefore: now.toISOString(),
            },
            expectedHeadSha: details.headSha,
            syncAfterRejectActionKey: syncAfterRejectHead.actionKey,
            syncAfterRejectValidationActionKey: actionKey,
            syncAfterRejectValidationTriggerComment: validation.triggerComment,
            syncAfterRejectValidationRequiredCheck: validation.requiredCheck,
            syncAfterRejectValidationPriorCheckIds: validation.priorCheckIds,
            ...(trackedGeneration === undefined ? {} : { trackedGeneration }),
          } satisfies ActionState,
        });
      }
    }
    const receivedReviewFeedback = this.receivedReviewFeedback(details, previous, baseline);
    if (baseline) {
      const threshold = this.config.features.staleThresholdHours;
      const staleHours = (now.getTime() - new Date(details.updatedAt).getTime()) / 3_600_000;
      staleCycle = threshold === 0 ? 1 : Math.max(0, Math.floor(staleHours / threshold));
      if (details.mergeable === 'CONFLICTING') conflictCycle += 1;
    }

    if (!baseline && details.state === 'MERGED') {
      events.push(
        buildEvent(
          this.config,
          'merged',
          pr,
          { mergedAt: details.mergedAt, headSha: details.headSha },
          {
            title: details.title,
            url: details.url,
            mergedAt: details.mergedAt,
          },
          details.mergedAt ?? now.toISOString(),
        ),
      );
    } else if (!baseline && details.state === 'OPEN') {
      if (trackedClaim !== undefined && previousDetails?.isDraft === true && !details.isDraft) {
        readyForReviewCycle += 1;
        events.push(
          buildEvent(
            this.config,
            'ready-for-review',
            pr,
            {
              generation: trackedClaim.generation,
              readyForReviewCycle,
              headSha: details.headSha,
            },
            {
              title: details.title,
              url: details.url,
              headRefName: details.headRefName,
              headSha: details.headSha,
              claimActor: trackedClaim.actor,
              claimEvidence: trackedClaim.evidence,
            },
            now.toISOString(),
          ),
        );
      }
      if (tracked && previousDetails !== undefined && previousDetails.headSha !== details.headSha) {
        events.push(
          buildEvent(
            this.config,
            'head-changed',
            pr,
            { previousHeadSha: previousDetails.headSha, headSha: details.headSha },
            { title: details.title, url: details.url },
            now.toISOString(),
          ),
        );
      }
      const failed = this.relevantChecks(details).filter(
        (check) => check.bucket === 'fail' || check.bucket === 'cancel',
      );
      if (failed.length > 0) {
        const signature = [...new Set(failed.map((check) => check.name))].sort().join(',');
        const previousFailed =
          previousDetails === undefined
            ? ''
            : [
                ...new Set(
                  this.relevantChecks(previousDetails)
                    .filter((check) => check.bucket === 'fail' || check.bucket === 'cancel')
                    .map((check) => check.name),
                ),
              ]
                .sort()
                .join(',');
        if (signature !== previousFailed || details.headSha !== previousDetails?.headSha) {
          events.push(
            buildEvent(
              this.config,
              'ci-failed',
              pr,
              { headSha: details.headSha, checks: signature },
              {
                title: details.title,
                failedChecks: failed.map((check) => check.name),
                url: details.url,
              },
              now.toISOString(),
            ),
          );
        }
      }

      const reviews = latestReviews(details.reviews);
      if (receivedReviewFeedback.event !== undefined) events.push(receivedReviewFeedback.event);

      const approvals = reviews.filter(
        (review) =>
          review.state === 'APPROVED' &&
          (syncAfterRejectHead === undefined ||
            (review.commitSha?.toLowerCase() === details.headSha.toLowerCase() &&
              !syncAfterRejectHead.priorApprovalIds.includes(review.id))),
      );
      const changesRequested = reviews.filter((review) => review.state === 'CHANGES_REQUESTED');
      const oldReviews = latestReviews(previousDetails?.reviews ?? []);
      const oldApprovals = oldReviews.filter((review) => review.state === 'APPROVED');
      const checksReady = this.checksReady(details, syncAfterRejectHead?.priorCheckIds);
      const postSyncValidationReady = this.postSyncValidationReady(syncAfterRejectHead, postSyncChecks);
      const previousChecksReady = previousDetails !== undefined && this.checksReady(previousDetails);
      const directBehind =
        this.config.github.mode === 'direct' &&
        details.mergeStateStatus === 'BEHIND' &&
        details.mergeable === 'MERGEABLE';
      const mergeReady = details.mergeable === 'MERGEABLE' && !directBehind;
      const releaseReady =
        mergeReady &&
        checksReady &&
        postSyncValidationReady &&
        changesRequested.length === 0 &&
        approvals.length >= this.config.reviews.requiredApprovals;
      const syncActionContext: MergeQueueActionContext =
        syncAfterRejectHead === undefined
          ? {}
          : {
              syncAfterRejectHeadSha: details.headSha,
              syncAfterRejectPriorCheckIds: syncAfterRejectHead.priorCheckIds,
              syncAfterRejectPriorApprovalIds: syncAfterRejectHead.priorApprovalIds,
              syncAfterRejectActionKey: syncAfterRejectHead.actionKey,
              ...(syncAfterRejectHead.validation === undefined
                ? {}
                : {
                    syncAfterRejectValidationActionKey: syncAfterRejectHead.validation.actionKey,
                    syncAfterRejectValidationTriggerComment: syncAfterRejectHead.validation.triggerComment,
                    syncAfterRejectValidationRequiredCheck: syncAfterRejectHead.validation.requiredCheck,
                    syncAfterRejectValidationPriorCheckIds: syncAfterRejectHead.validation.priorCheckIds,
                  }),
            };
      const readinessChanged =
        oldReviews.some((review) => review.state === 'CHANGES_REQUESTED') ||
        approvals
          .map((review) => review.id)
          .sort()
          .join(',') !==
          oldApprovals
            .map((review) => review.id)
            .sort()
            .join(',') ||
        !previousChecksReady ||
        previousDetails?.mergeable !== 'MERGEABLE' ||
        previousDetails?.headSha !== details.headSha;
      if (releaseReady && readinessChanged) {
        events.push(
          buildEvent(
            this.config,
            'approved',
            pr,
            {
              headSha: details.headSha,
              reviewIds: approvals.map((review) => review.id).sort(),
            },
            {
              approvals: approvals.length,
              feedback: approvals.filter((review) => review.body.trim().length > 20).map((review) => review.body),
              title: details.title,
              url: details.url,
            },
            now.toISOString(),
          ),
        );
      }
      const providerReadyClaim =
        trackedClaim?.status === 'active' &&
        trackedClaim.generation === trackedGeneration &&
        trackedClaim.releaseGate === 'provider-action-ready';
      if (providerReadyClaim) {
        if (mergeAutomation === undefined) {
          throw new Error('The GitHub provider cannot observe Add to merge queue availability.');
        }
        if (
          (mergeAutomation.queued || mergeAutomation.enqueueAvailable === true) &&
          (syncAfterRejectHead === undefined || releaseReady)
        ) {
          mergeQueueRetry = this.addMergeQueueDecision(
            this.config.automation.autoMerge,
            pr,
            details,
            mergeAutomation,
            mergeQueueRetry,
            {
              releaseGate: 'provider-action-ready',
              trackedGeneration: trackedClaim.generation,
            },
            {
              trackedGeneration: trackedClaim.generation,
              ...syncActionContext,
            },
            trackedClaim.generation,
            events,
            actions,
          );
        }
      } else if (releaseReady && details.autoMergeRequest === null) {
        const trackedClaim = tracked ? this.trackedStore().getTrackedPullRequest(pr) : undefined;
        if (
          trackedClaim?.status === 'active' &&
          trackedClaim.generation === trackedGeneration &&
          trackedClaim.releaseGate === 'exact-head-attestation'
        ) {
          const releaseStore = supportsReleaseGate(this.store) ? this.store : undefined;
          const gateStatus =
            this.config.features.trackedPRs.releaseGate !== 'exact-head-attestation' || releaseStore === undefined
              ? 'disabled'
              : releaseStore.getReleaseGateStatus(pr, trackedClaim.generation, details.headSha);
          const attestation =
            gateStatus === 'applicable'
              ? releaseStore?.getReleaseAttestation(pr, trackedClaim.generation, details.headSha)
              : undefined;
          if (gateStatus !== 'applicable' || attestation?.status !== 'active') {
            const blockedReason = gateStatus === 'applicable' ? 'missing' : gateStatus;
            events.push(
              buildEvent(
                this.config,
                'release-gate-blocked',
                pr,
                { generation: trackedClaim.generation, headSha: details.headSha, reason: blockedReason },
                { reason: blockedReason, title: details.title, url: details.url },
                now.toISOString(),
              ),
            );
          } else if (this.config.github.mode === 'merge-queue') {
            mergeQueueRetry = this.addMergeQueueDecision(
              this.config.automation.autoMerge,
              pr,
              details,
              mergeAutomation,
              mergeQueueRetry,
              {
                releaseGate: 'exact-head-attestation',
                attestationId: attestation.idempotencyKey,
              },
              {
                trackedGeneration: trackedClaim.generation,
                attestationHeadSha: details.headSha,
                attestationId: attestation.idempotencyKey,
                ...syncActionContext,
              },
              trackedClaim.generation,
              events,
              actions,
            );
          } else {
            this.addDecision(
              'auto-merge-decision',
              this.config.automation.autoMerge,
              pr,
              {
                headSha: details.headSha,
                mergeMethod: this.config.github.mergeMethod,
                releaseGate: 'exact-head-attestation',
                attestationId: attestation.idempotencyKey,
              },
              { mergeMethod: this.config.github.mergeMethod, title: details.title, url: details.url },
              {
                type: 'merge-exact-head',
                pr,
                headSha: details.headSha,
                mergeMethod: this.config.github.mergeMethod,
              },
              events,
              actions,
              {
                trackedGeneration: trackedClaim.generation,
                attestationHeadSha: details.headSha,
                attestationId: attestation.idempotencyKey,
              },
            );
          }
        } else {
          const autoMergeMode =
            tracked && !authored && this.config.automation.autoMerge === 'execute'
              ? 'notify'
              : this.config.automation.autoMerge;
          if (this.config.github.mode === 'merge-queue') {
            if (mergeAutomation === undefined) {
              this.addDecision(
                'auto-merge-decision',
                autoMergeMode,
                pr,
                { headSha: details.headSha, mergeMethod: this.config.github.mergeMethod },
                { mergeMethod: this.config.github.mergeMethod, title: details.title, url: details.url },
                { type: 'enable-auto-merge', pr, mergeMethod: this.config.github.mergeMethod },
                events,
                actions,
              );
            } else {
              mergeQueueRetry = this.addMergeQueueDecision(
                autoMergeMode,
                pr,
                details,
                mergeAutomation,
                mergeQueueRetry,
                {},
                syncActionContext,
                trackedGeneration,
                events,
                actions,
              );
            }
          } else {
            this.addDecision(
              'auto-merge-decision',
              autoMergeMode,
              pr,
              { headSha: details.headSha, mergeMethod: this.config.github.mergeMethod },
              { mergeMethod: this.config.github.mergeMethod, title: details.title, url: details.url },
              { type: 'enable-auto-merge', pr, mergeMethod: this.config.github.mergeMethod },
              events,
              actions,
            );
          }
        }
      }

      if (details.mergeable === 'CONFLICTING' && previousDetails?.mergeable !== 'CONFLICTING') {
        conflictCycle += 1;
        events.push(
          buildEvent(
            this.config,
            'conflict',
            pr,
            { headSha: details.headSha, conflictCycle },
            {
              title: details.title,
              url: details.url,
            },
            now.toISOString(),
          ),
        );
      }

      if (
        directBehind &&
        (previousDetails?.headSha !== details.headSha ||
          previousDetails.mergeStateStatus !== 'BEHIND' ||
          previousDetails.mergeable !== 'MERGEABLE')
      ) {
        if (this.config.automation.branchUpdate === 'off') {
          events.push(
            buildEvent(
              this.config,
              'branch-behind',
              pr,
              { headSha: details.headSha },
              { reason: 'readiness withheld; branchUpdate is off', title: details.title, url: details.url },
              now.toISOString(),
            ),
          );
        } else {
          this.addDecision(
            'branch-update-decision',
            this.config.automation.branchUpdate,
            pr,
            { headSha: details.headSha, mergeStateStatus: details.mergeStateStatus },
            { headSha: details.headSha, title: details.title, url: details.url },
            { type: 'update-branch', pr },
            events,
            actions,
          );
        }
      }

      this.addCommentEvents(details, previousDetails, botAttempts, events);

      const staleThreshold = this.config.features.staleThresholdHours;
      const staleHours = (now.getTime() - new Date(details.updatedAt).getTime()) / 3_600_000;
      const currentCycle = staleThreshold === 0 ? 1 : Math.max(0, Math.floor(staleHours / staleThreshold));
      if (currentCycle < staleCycle) staleCycle = currentCycle;
      if (currentCycle > staleCycle && currentCycle > 0) {
        staleCycle = currentCycle;
        events.push(
          buildEvent(
            this.config,
            'stale',
            pr,
            { headSha: details.headSha, anchor: details.updatedAt, staleCycle },
            {
              hoursStale: Math.floor(staleHours),
              title: details.title,
              url: details.url,
            },
            now.toISOString(),
          ),
        );
      }

      if (
        this.config.features.reviewerNudge.enabled &&
        previousDetails !== undefined &&
        previousDetails.headSha !== details.headSha
      ) {
        const requesting = latestReviews(previousDetails.reviews).filter(
          (review) => review.state === 'CHANGES_REQUESTED',
        );
        for (const review of requesting) {
          const key = `${prKey('nudge', pr)}:${review.author.toLowerCase()}`;
          const nudge: NudgeState = {
            reviewer: review.author,
            fixPushedAt: now.toISOString(),
            commentPostedAt: null,
            escalationReferenceAt: this.config.automation.reviewerComment === 'execute' ? null : now.toISOString(),
            lastEscalatedAt: null,
            escalationCount: 0,
            details,
          };
          nudges.push({ key, kind: 'nudge', value: nudge });
          this.addReviewerCommentDecision(pr, details, nudge, key, events, actions);
        }
      }
    }

    return {
      state: {
        details,
        lastObservedAt: now.toISOString(),
        botAttempts,
        staleCycle,
        conflictCycle,
        readyForReviewCycle,
        receivedReviewThreads: receivedReviewFeedback.threads,
        ...(mergeQueueRetry === undefined ? {} : { mergeQueueRetry }),
        ...(syncAfterRejectHead === undefined ? {} : { syncAfterRejectHead }),
        sources: { authored, ...(trackedGeneration === undefined ? {} : { trackedGeneration }) },
      },
      events:
        baseline || (tracked && details.isDraft && this.config.features.trackedPRs.suppressDraftEvents) ? [] : events,
      actions: baseline ? [] : actions,
      nudges: baseline ? [] : nudges,
    };
  }

  private receivedReviewFeedback(
    details: PullRequestDetails,
    previous: AuthoredState | undefined,
    baseline: boolean,
  ): { threads: Record<string, ReceivedReviewThreadState>; event?: ShepherdEvent } {
    const previousDetails = previous?.details;
    const previousThreads =
      previous?.receivedReviewThreads ??
      Object.fromEntries(
        (previousDetails?.reviewThreads ?? []).map((thread) => [
          thread.id,
          {
            present: true,
            rootCommentId: thread.rootCommentId,
            seenCommentIds: thread.comments.map((comment) => comment.id).sort(),
            createdCycle: 0,
            outdatedCycle: 0,
            resolvedCycle: 0,
            isOutdated: thread.isOutdated,
            isResolved: thread.isResolved,
          } satisfies ReceivedReviewThreadState,
        ]),
      );
    const nextThreads = Object.fromEntries(
      Object.entries(previousThreads).map(([threadId, thread]) => [threadId, { ...thread, present: false }]),
    );
    const createdTransitions: { threadId: string; cycle: number }[] = [];
    const outdatedTransitions: { threadId: string; cycle: number }[] = [];
    const resolvedTransitions: { threadId: string; cycle: number }[] = [];
    const newReplies = new Map<string, ReviewThreadComment[]>();
    const reviewsById = new Map(details.reviews.map((review) => [review.id, review]));
    const eligibleThreadIds = new Set<string>();

    for (const thread of [...details.reviewThreads].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    )) {
      const oldThread = previousThreads[thread.id];
      const review = reviewsById.get(thread.reviewId);
      const eligible =
        this.receivedFeedbackActor(thread.rootAuthor) &&
        (review === undefined || this.receivedFeedbackActor(review.author));
      if (eligible) eligibleThreadIds.add(thread.id);
      const newlyPresent = oldThread?.present !== true;
      let createdCycle = oldThread?.createdCycle ?? 0;
      let outdatedCycle = oldThread?.outdatedCycle ?? 0;
      let resolvedCycle = oldThread?.resolvedCycle ?? 0;
      if (!baseline && eligible && newlyPresent) {
        createdCycle += 1;
        createdTransitions.push({ threadId: thread.id, cycle: createdCycle });
      }

      const seen = new Set(oldThread?.seenCommentIds ?? []);
      const replies = [...thread.comments]
        .sort((left, right) => {
          const byTime = left.createdAt.localeCompare(right.createdAt);
          return byTime === 0 ? (left.id < right.id ? -1 : left.id > right.id ? 1 : 0) : byTime;
        })
        .filter(
          (comment) =>
            comment.id !== thread.rootCommentId && !seen.has(comment.id) && this.receivedFeedbackActor(comment.author),
        );
      if (!baseline && eligible && replies.length > 0) newReplies.set(thread.id, replies);

      if (!baseline && eligible && oldThread?.present === true && !oldThread.isOutdated && thread.isOutdated) {
        outdatedCycle += 1;
        outdatedTransitions.push({ threadId: thread.id, cycle: outdatedCycle });
      }
      if (!baseline && eligible && oldThread?.present === true && !oldThread.isResolved && thread.isResolved) {
        resolvedCycle += 1;
        resolvedTransitions.push({ threadId: thread.id, cycle: resolvedCycle });
      }
      nextThreads[thread.id] = {
        present: true,
        rootCommentId: thread.rootCommentId,
        seenCommentIds: [
          ...new Set([...(oldThread?.seenCommentIds ?? []), ...thread.comments.map(({ id }) => id)]),
        ].sort(),
        createdCycle,
        outdatedCycle,
        resolvedCycle,
        isOutdated: thread.isOutdated,
        isResolved: thread.isResolved,
      };
    }

    const oldReviewIds = new Set(previousDetails?.reviews.map((review) => review.id) ?? []);
    const newReviews = sortedReviews(
      latestReviews(details.reviews).filter(
        (review) =>
          this.receivedFeedbackActor(review.author) &&
          (review.state === 'CHANGES_REQUESTED' || (review.state === 'COMMENTED' && review.body.trim().length > 0)) &&
          !oldReviewIds.has(review.id),
      ),
    );
    const reasons: ReceivedReviewReason[] = [];
    if (!baseline && newReviews.length > 0) reasons.push('review-submitted');
    if (!baseline && createdTransitions.length > 0) reasons.push('thread-created');
    if (!baseline && newReplies.size > 0) reasons.push('thread-replied');
    if (!baseline && outdatedTransitions.length > 0) reasons.push('thread-outdated');
    if (!baseline && resolvedTransitions.length > 0) reasons.push('thread-resolved');
    if (reasons.length === 0 || details.state !== 'OPEN') return { threads: nextThreads };

    const affectedThreadIds = new Set([
      ...createdTransitions.map(({ threadId }) => threadId),
      ...newReplies.keys(),
      ...outdatedTransitions.map(({ threadId }) => threadId),
      ...resolvedTransitions.map(({ threadId }) => threadId),
    ]);
    const newReviewIds = new Set(newReviews.map((review) => review.id));
    const affectedThreads = details.reviewThreads
      .filter(
        (thread) =>
          eligibleThreadIds.has(thread.id) && (affectedThreadIds.has(thread.id) || newReviewIds.has(thread.reviewId)),
      )
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const contextReviewIds = new Set([...newReviewIds, ...affectedThreads.map((thread) => thread.reviewId)]);
    const contextReviews = sortedReviews(
      details.reviews.filter((review) => contextReviewIds.has(review.id) && this.receivedFeedbackActor(review.author)),
    );
    const primaryReview = newReviews.length === 1 ? newReviews[0] : undefined;
    const occurredAt = primaryReview?.submittedAt ?? this.clock().toISOString();
    const transitionFacts = {
      ...boundedTransitionList(details, 'reviewIds', newReviews.map((review) => review.id).sort()),
      ...boundedTransitionList(
        details,
        'createdTransitions',
        createdTransitions.map(({ threadId, cycle }) => `${threadId}:${String(cycle)}`).sort(),
      ),
      ...boundedTransitionList(
        details,
        'replyIds',
        [...newReplies.values()]
          .flat()
          .map(({ id }) => id)
          .sort(),
      ),
      ...boundedTransitionList(
        details,
        'outdatedTransitions',
        outdatedTransitions.map(({ threadId, cycle }) => `${threadId}:${String(cycle)}`).sort(),
      ),
      ...boundedTransitionList(
        details,
        'resolvedTransitions',
        resolvedTransitions.map(({ threadId, cycle }) => `${threadId}:${String(cycle)}`).sort(),
      ),
    };
    const identity =
      primaryReview === undefined ? transitionFacts : { reviewId: primaryReview.id, state: primaryReview.state };
    return {
      threads: nextThreads,
      event: this.buildReceivedReviewEvent(
        details,
        identity,
        transitionFacts,
        reasons,
        contextReviews,
        affectedThreads,
        newReplies,
        primaryReview,
        occurredAt,
      ),
    };
  }

  private receivedFeedbackActor(author: string): boolean {
    const normalized = author.toLowerCase();
    return (
      normalized !== this.config.profile.githubUser.toLowerCase() &&
      !this.config.reviews.ignoredActors.some((ignored) => ignored.toLowerCase() === normalized)
    );
  }

  private buildReceivedReviewEvent(
    details: PullRequestDetails,
    identity: Record<string, unknown>,
    transitionFacts: Record<string, unknown>,
    reasons: ReceivedReviewReason[],
    contextReviews: Review[],
    affectedThreads: ReviewThread[],
    newReplies: ReadonlyMap<string, ReviewThreadComment[]>,
    primaryReview: Review | undefined,
    occurredAt: string,
  ): ShepherdEvent {
    const orderedReviews =
      primaryReview === undefined
        ? contextReviews
        : [primaryReview, ...contextReviews.filter((review) => review.id !== primaryReview.id)];
    const totalReplies = [...newReplies.values()].reduce((total, replies) => total + replies.length, 0);
    const configuredGuidance = this.config.guidance['review-feedback'];
    const guidance =
      configuredGuidance === undefined
        ? undefined
        : boundedText(configuredGuidance, RECEIVED_REVIEW_GUIDANCE_MAX_BYTES);
    const eventConfig: ShepherdConfig =
      guidance?.truncated === true
        ? {
            ...this.config,
            guidance: { ...this.config.guidance, 'review-feedback': guidance.value },
          }
        : this.config;
    const minimumReviews = primaryReview === undefined ? 0 : 1;
    const minimumThreads = affectedThreads.length === 0 ? 0 : 1;
    const limits: ReceivedReviewRenderLimits = {
      textBytes: RECEIVED_REVIEW_TEXT_MAX_BYTES,
      reviews: orderedReviews.length,
      threads: affectedThreads.length,
      replies: totalReplies,
    };

    for (;;) {
      const event = buildEvent(
        eventConfig,
        'review-feedback',
        details,
        identity,
        this.receivedReviewFacts(
          details,
          transitionFacts,
          reasons,
          orderedReviews,
          affectedThreads,
          newReplies,
          primaryReview,
          limits,
          guidance,
        ),
        occurredAt,
      );
      if (utf8Bytes(JSON.stringify(event)) <= RECEIVED_REVIEW_EVENT_MAX_BYTES) return event;
      if (limits.textBytes > 256) {
        limits.textBytes = Math.max(256, Math.floor(limits.textBytes / 2));
      } else if (limits.threads > minimumThreads) {
        limits.threads = Math.max(minimumThreads, Math.floor(limits.threads / 2));
      } else if (limits.replies > 0) {
        limits.replies = Math.floor(limits.replies / 2);
      } else if (limits.reviews > minimumReviews) {
        limits.reviews = Math.max(minimumReviews, Math.floor(limits.reviews / 2));
      } else if (limits.threads > 0) {
        limits.threads = 0;
      } else if (limits.textBytes > 0) {
        limits.textBytes = 0;
      } else {
        throw new Error('Received review-feedback routing metadata exceeds the 64 KiB event ceiling.');
      }
    }
  }

  private receivedReviewFacts(
    details: PullRequestDetails,
    transitionFacts: Record<string, unknown>,
    reasons: ReceivedReviewReason[],
    orderedReviews: Review[],
    affectedThreads: ReviewThread[],
    newReplies: ReadonlyMap<string, ReviewThreadComment[]>,
    primaryReview: Review | undefined,
    limits: ReceivedReviewRenderLimits,
    guidance: ReturnType<typeof boundedText> | undefined,
  ): Record<string, unknown> {
    const selectedReviews = orderedReviews.slice(0, limits.reviews);
    const reviewFacts = selectedReviews.map((review) => this.receivedReviewFactsForReview(review, limits.textBytes));
    const selectedThreads = affectedThreads.slice(0, limits.threads);
    let remainingReplies = limits.replies;
    let includedReplies = 0;
    const threadFacts = selectedThreads.map((thread) => {
      const replies = newReplies.get(thread.id) ?? [];
      const included = replies.slice(0, remainingReplies);
      remainingReplies -= included.length;
      includedReplies += included.length;
      return this.receivedReviewThreadFacts(thread, included, replies.length - included.length, limits.textBytes);
    });
    const totalReplies = [...newReplies.values()].reduce((total, replies) => total + replies.length, 0);
    const textTruncated =
      reviewFacts.some((review) => review.bodyTruncated === true) ||
      threadFacts.some(
        (thread) =>
          (thread.rootComment as Record<string, unknown> | undefined)?.bodyTruncated === true ||
          (thread.newReplies as Record<string, unknown>[]).some((reply) => reply.bodyTruncated === true),
      ) ||
      (primaryReview !== undefined && boundedText(primaryReview.body, limits.textBytes).truncated);
    const transitionMetadataTruncated = Object.entries(transitionFacts).some(
      ([key, value]) => key.endsWith('Truncated') && value === true,
    );
    const aggregateTruncated =
      textTruncated ||
      transitionMetadataTruncated ||
      selectedReviews.length < orderedReviews.length ||
      selectedThreads.length < affectedThreads.length ||
      includedReplies < totalReplies ||
      guidance?.truncated === true;
    return {
      title: details.title,
      url: details.url,
      triggeringReasons: reasons,
      ...transitionFacts,
      reviews: reviewFacts,
      affectedThreads: threadFacts,
      payload: {
        maxEventBytes: RECEIVED_REVIEW_EVENT_MAX_BYTES,
        truncated: aggregateTruncated,
        textLimitBytes: limits.textBytes,
        reviewCount: orderedReviews.length,
        includedReviewCount: selectedReviews.length,
        omittedReviewCount: orderedReviews.length - selectedReviews.length,
        threadCount: affectedThreads.length,
        includedThreadCount: selectedThreads.length,
        omittedThreadCount: affectedThreads.length - selectedThreads.length,
        replyCount: totalReplies,
        includedReplyCount: includedReplies,
        omittedReplyCount: totalReplies - includedReplies,
        ...(transitionMetadataTruncated ? { transitionMetadataTruncated: true } : {}),
        ...(guidance?.truncated === true
          ? { guidanceTruncated: true, guidanceOriginalBytes: guidance.originalBytes }
          : {}),
      },
      ...(primaryReview === undefined
        ? {}
        : {
            reviewer: primaryReview.author,
            ...this.receivedReviewBodyFacts(primaryReview.body, limits.textBytes),
          }),
    };
  }

  private receivedReviewFactsForReview(review: Review, maxBodyBytes: number): Record<string, unknown> {
    return {
      id: review.id,
      author: review.author,
      state: review.state,
      ...this.receivedReviewBodyFacts(review.body, maxBodyBytes),
      submittedAt: review.submittedAt,
      commitSha: review.commitSha,
    };
  }

  private receivedReviewBodyFacts(body: string, maxBodyBytes: number): Record<string, unknown> {
    const bounded = boundedText(body, maxBodyBytes);
    return {
      body: bounded.value,
      ...(bounded.truncated ? { bodyTruncated: true, bodyOriginalBytes: bounded.originalBytes } : {}),
    };
  }

  private receivedReviewThreadFacts(
    thread: ReviewThread,
    replies: ReviewThreadComment[],
    omittedReplyCount: number,
    maxBodyBytes: number,
  ): Record<string, unknown> {
    const root = thread.comments.find((comment) => comment.id === thread.rootCommentId);
    return {
      threadId: thread.id,
      reviewId: thread.reviewId,
      threadUrl: thread.url,
      rootCommentId: thread.rootCommentId,
      rootAuthor: thread.rootAuthor,
      path: thread.path,
      originalLine: thread.originalLine,
      originalSide: thread.originalSide,
      currentLine: thread.currentLine,
      currentSide: thread.currentSide,
      isOutdated: thread.isOutdated,
      isResolved: thread.isResolved,
      rootComment:
        root === undefined
          ? undefined
          : {
              id: root.id,
              author: root.author,
              ...this.receivedReviewBodyFacts(root.body, maxBodyBytes),
              createdAt: root.createdAt,
              updatedAt: root.updatedAt,
              url: root.url,
            },
      newReplies: replies.map((reply) => ({
        id: reply.id,
        author: reply.author,
        ...this.receivedReviewBodyFacts(reply.body, maxBodyBytes),
        createdAt: reply.createdAt,
        updatedAt: reply.updatedAt,
        url: reply.url,
      })),
      ...(omittedReplyCount > 0 ? { omittedReplyCount } : {}),
    };
  }

  private addCommentEvents(
    details: PullRequestDetails,
    previous: PullRequestDetails | undefined,
    botAttempts: Record<string, number>,
    events: ShepherdEvent[],
  ): void {
    const oldIds = new Set(previous?.comments.map((comment) => comment.id) ?? []);
    const bots = new Map(this.config.reviews.bots.map((bot) => [bot.username.toLowerCase(), bot]));
    const ignored = new Set(this.config.reviews.ignoredActors.map((actor) => actor.toLowerCase()));
    for (const comment of sortedComments(details.comments).filter((item) => !oldIds.has(item.id))) {
      const bot = bots.get(comment.author.toLowerCase());
      if (bot !== undefined) {
        if (!bot.actionablePatterns.some((pattern) => patternMatches(comment.body, pattern))) continue;
        const attempt = botAttempts[bot.username.toLowerCase()] ?? 0;
        if (attempt >= bot.maxFeedbackAttempts) continue;
        botAttempts[bot.username.toLowerCase()] = attempt + 1;
        events.push(
          buildEvent(
            this.config,
            'bot-findings',
            details,
            { commentId: comment.id },
            {
              bot: comment.author,
              attempt: attempt + 1,
              body: comment.body,
              title: details.title,
              url: details.url,
            },
            comment.createdAt,
          ),
        );
        continue;
      }
      if (ignored.has(comment.author.toLowerCase()) || comment.body.trim().length <= 50) continue;
      if (this.config.reviews.ignoredCommentPatterns.some((pattern) => patternMatches(comment.body, pattern))) continue;
      events.push(
        buildEvent(
          this.config,
          'comment',
          details,
          { commentId: comment.id },
          {
            author: comment.author,
            body: comment.body,
            title: details.title,
            url: details.url,
          },
          comment.createdAt,
        ),
      );
    }
  }

  private addMergeQueueDecision(
    mode: 'off' | 'notify' | 'execute',
    pr: PullRequestRef,
    details: PullRequestDetails,
    automation: MergeAutomationState | undefined,
    previous: MergeQueueRetryState | undefined,
    identityContext: Record<string, unknown>,
    actionContext: MergeQueueActionContext,
    trackedGeneration: number | undefined,
    events: ShepherdEvent[],
    actions: EntityUpdate[],
  ): MergeQueueRetryState | undefined {
    if (automation === undefined) throw new Error('Merge-queue automation state was not observed.');
    const providerReady = identityContext.releaseGate === 'provider-action-ready';
    const baseScope =
      typeof identityContext.attestationId === 'string'
        ? identityContext.attestationId
        : providerReady && actionContext.trackedGeneration !== undefined
          ? `provider-action-ready:${String(actionContext.trackedGeneration)}`
          : 'authored';
    const previousFence = previous?.fence ?? this.recoverMergeQueueFence(pr, details.headSha);
    const completedFenceSync =
      previousFence?.syncActionKey === undefined
        ? false
        : this.store.getEntity<ActionState>(previousFence.syncActionKey)?.value.status === 'completed';
    const postSync = actionContext.syncAfterRejectHeadSha !== undefined || completedFenceSync;
    const scope = postSync ? `${baseScope}:sync-after-reject:${details.headSha.toLowerCase()}` : baseScope;
    const fence =
      !completedFenceSync && previousFence?.headSha.toLowerCase() === details.headSha.toLowerCase()
        ? previousFence
        : undefined;
    const recovered = previous?.scope === scope ? previous : this.recoverMergeQueueRetry(pr, details.headSha, scope);
    const retry = recovered === undefined ? undefined : { ...recovered, ...(fence === undefined ? {} : { fence }) };

    if (automation.queued) {
      return {
        headSha: details.headSha,
        scope,
        attempts: retry?.attempts ?? 0,
        ...(retry?.lastActionKey === undefined ? {} : { lastActionKey: retry.lastActionKey }),
        observedQueued: true,
        exhausted: retry?.exhausted ?? false,
        ...(fence === undefined ? {} : { fence }),
      };
    }
    if (providerReady ? automation.enqueueAvailable !== true : automation.autoMergeEnabled) return retry;

    if (fence !== undefined) {
      const removal = automation.latestQueueRemoval?.id === fence.removalId ? automation.latestQueueRemoval : undefined;
      const syncDecision = this.addSyncAfterRejectDecision(
        mode,
        pr,
        details,
        removal,
        fence.classification === 'code-failure',
        actionContext,
        events,
        actions,
      );
      const reconciledFence =
        fence.syncActionKey === undefined && syncDecision.actionKey !== undefined
          ? { ...fence, syncActionKey: syncDecision.actionKey }
          : fence;
      if (reconciledFence !== fence) {
        actions.push({
          key: `${prKey('merge-queue-fence', pr)}:${details.headSha.toLowerCase()}`,
          kind: 'merge-queue-fence',
          value: reconciledFence,
        });
      }
      return {
        headSha: details.headSha,
        scope,
        attempts: retry?.attempts ?? 0,
        ...(retry?.lastActionKey === undefined ? {} : { lastActionKey: retry.lastActionKey }),
        observedQueued: false,
        exhausted: true,
        fence: reconciledFence,
      };
    }

    if (retry === undefined) {
      return this.scheduleMergeQueueAttempt(
        mode,
        pr,
        details,
        scope,
        1,
        undefined,
        identityContext,
        actionContext,
        events,
        actions,
      );
    }

    const priorAction =
      retry.lastActionKey === undefined ? undefined : this.store.getEntity<ActionState>(retry.lastActionKey);
    if (priorAction === undefined) {
      if (!retry.observedQueued || retry.attempts > 0) return { ...retry, exhausted: true };
      return this.retryAfterQueueRemoval(
        mode,
        pr,
        details,
        automation,
        retry,
        undefined,
        identityContext,
        actionContext,
        trackedGeneration,
        events,
        actions,
      );
    }
    if (priorAction.value.status === 'pending') return retry;
    if (priorAction.value.status !== 'completed') return { ...retry, exhausted: true };
    return this.retryAfterQueueRemoval(
      mode,
      pr,
      details,
      automation,
      retry,
      priorAction.value.completedAt ?? priorAction.updatedAt,
      identityContext,
      actionContext,
      trackedGeneration,
      events,
      actions,
    );
  }

  private retryAfterQueueRemoval(
    mode: 'off' | 'notify' | 'execute',
    pr: PullRequestRef,
    details: PullRequestDetails,
    automation: MergeAutomationState,
    retry: MergeQueueRetryState,
    completedAt: string | undefined,
    identityContext: Record<string, unknown>,
    actionContext: MergeQueueActionContext,
    trackedGeneration: number | undefined,
    events: ShepherdEvent[],
    actions: EntityUpdate[],
  ): MergeQueueRetryState {
    const removal = automation.latestQueueRemoval;
    const removalAfterAttempt =
      removal !== undefined && (completedAt === undefined || removal.createdAt >= completedAt) ? removal : undefined;
    const anchor = removalAfterAttempt?.createdAt ?? completedAt ?? this.clock().toISOString();
    const delayIndex = Math.min(Math.max(retry.attempts, 1) - 1, MERGE_QUEUE_RETRY_DELAYS_MS.length - 1);
    const delayMs = MERGE_QUEUE_RETRY_DELAYS_MS[delayIndex] ?? MERGE_QUEUE_RETRY_DELAYS_MS.at(-1) ?? 60_000;
    const retryAt = new Date(new Date(anchor).getTime() + delayMs).toISOString();
    const confirmed = retry.observedQueued || removalAfterAttempt !== undefined;
    if (!confirmed && this.clock().getTime() < new Date(retryAt).getTime()) return retry;

    const disposition = mergeQueueRetryDisposition(removalAfterAttempt);
    const exhausted = retry.attempts >= MERGE_QUEUE_MAX_ATTEMPTS || disposition.retryable === false;
    const removalIdentity = removalAfterAttempt?.id ?? retry.lastActionKey ?? `${retry.scope}:observed-queue`;
    const syncDecision = this.addSyncAfterRejectDecision(
      mode,
      pr,
      details,
      removalAfterAttempt,
      disposition.classification === 'code-failure-fenced',
      actionContext,
      events,
      actions,
    );
    events.push(
      buildEvent(
        this.config,
        'merge-queue-evicted',
        pr,
        { headSha: details.headSha, attempt: retry.attempts, removalId: removalIdentity },
        {
          reason: removalAfterAttempt?.reason ?? 'queue-entry-absent-after-submission',
          ...(removalAfterAttempt === undefined ? {} : { removedAt: removalAfterAttempt.createdAt }),
          attempts: retry.attempts,
          retryExhausted: exhausted,
          retryEligibility: disposition.classification,
          syncAfterReject: syncDecision.reason,
          ...(removalAfterAttempt?.evidence === undefined ? {} : { providerEvidence: removalAfterAttempt.evidence }),
          ...(exhausted || mode !== 'execute' ? {} : { retryAt }),
          title: details.title,
          url: details.url,
        },
        removalAfterAttempt?.createdAt ?? this.clock().toISOString(),
      ),
    );
    if (disposition.retryable === false) {
      const fence: MergeQueueFence = {
        repo: pr.repo,
        prNumber: pr.number,
        headSha: details.headSha,
        ...(trackedGeneration === undefined ? {} : { trackedGeneration }),
        removalId: removalIdentity,
        removalReason: removalAfterAttempt?.reason ?? 'queue-entry-absent-after-submission',
        classification: disposition.fenceClassification,
        createdAt: removalAfterAttempt?.createdAt ?? this.clock().toISOString(),
        ...(syncDecision.actionKey === undefined ? {} : { syncActionKey: syncDecision.actionKey }),
      };
      actions.push({
        key: `${prKey('merge-queue-fence', pr)}:${details.headSha.toLowerCase()}`,
        kind: 'merge-queue-fence',
        value: fence,
      });
      return { ...retry, observedQueued: false, exhausted: true, fence };
    }
    if (exhausted || mode !== 'execute') return { ...retry, observedQueued: false, exhausted };
    return (
      this.scheduleMergeQueueAttempt(
        mode,
        pr,
        details,
        retry.scope,
        retry.attempts + 1,
        retryAt,
        identityContext,
        actionContext,
        events,
        actions,
      ) ?? { ...retry, observedQueued: false, exhausted: true }
    );
  }

  private addSyncAfterRejectDecision(
    mode: 'off' | 'notify' | 'execute',
    pr: PullRequestRef,
    details: PullRequestDetails,
    removal: MergeQueueRemoval | undefined,
    attributedCheckRejection: boolean,
    actionContext: MergeQueueActionContext,
    events: ShepherdEvent[],
    actions: EntityUpdate[],
  ): { reason: string; actionKey?: string } {
    let reason = !this.config.automation.syncAfterReject
      ? 'disabled'
      : mode !== 'execute' || this.config.automation.autoMerge !== 'execute'
        ? 'auto-merge-is-not-executing'
        : !supportsReleaseGate(this.store)
          ? 'durable-mutation-lock-unavailable'
          : !attributedCheckRejection
            ? 'removal-is-not-an-attributed-check-rejection'
            : syncAfterRejectEvidenceReason(removal, this.clock());
    const actionKey = `${prKey('action:sync-after-reject', pr)}:${details.headSha.toLowerCase()}`;
    if (reason === undefined && this.store.getEntity<ActionState>(actionKey) !== undefined) {
      reason = 'already-attempted-for-head';
    }
    if (reason !== undefined || removal === undefined) return { reason: reason ?? 'missing-removal-evidence' };

    events.push(
      buildEvent(
        this.config,
        'branch-update-decision',
        pr,
        { headSha: details.headSha, removalId: removal.id, reason: 'sync-after-reject' },
        {
          mode: 'execute',
          reason: 'sync-after-reject',
          removedAt: removal.createdAt,
          title: details.title,
          url: details.url,
        },
        this.clock().toISOString(),
      ),
    );
    actions.push({
      key: actionKey,
      kind: 'action',
      value: {
        status: 'pending',
        mutation: { type: 'sync-branch-exact-head', pr, headSha: details.headSha },
        expectedHeadSha: details.headSha,
        syncAfterRejectRemovalId: removal.id,
        syncAfterRejectRemovedAt: removal.createdAt,
        syncAfterRejectQueueStackAttribution: removal.evidence?.queueStack.attribution,
        ...actionContext,
      } satisfies ActionState,
    });
    return { reason: 'scheduled', actionKey };
  }

  private scheduleMergeQueueAttempt(
    mode: 'off' | 'notify' | 'execute',
    pr: PullRequestRef,
    details: PullRequestDetails,
    scope: string,
    attempt: number,
    nextAttemptAt: string | undefined,
    identityContext: Record<string, unknown>,
    actionContext: MergeQueueActionContext,
    events: ShepherdEvent[],
    actions: EntityUpdate[],
  ): MergeQueueRetryState | undefined {
    if (mode === 'off') return undefined;
    const event = buildEvent(
      this.config,
      'auto-merge-decision',
      pr,
      {
        headSha: details.headSha,
        mergeMethod: this.config.github.mergeMethod,
        enqueueAttempt: attempt,
        ...(actionContext.syncAfterRejectHeadSha === undefined ? {} : { syncAfterReject: true }),
        ...identityContext,
      },
      {
        mode,
        mergeMethod: this.config.github.mergeMethod,
        enqueueAttempt: attempt,
        title: details.title,
        url: details.url,
      },
      this.clock().toISOString(),
    );
    events.push(event);
    const key = `action:${event.id}`;
    if (mode === 'execute' && this.store.getEntity(key) === undefined) {
      actions.push({
        key,
        kind: 'action',
        value: {
          status: 'pending',
          mutation:
            identityContext.releaseGate === 'provider-action-ready' &&
            actionContext.syncAfterRejectHeadSha === undefined
              ? { type: 'enqueue-provider-ready', pr }
              : { type: 'enqueue-exact-head', pr, headSha: details.headSha },
          ...(identityContext.releaseGate === 'provider-action-ready' &&
          actionContext.syncAfterRejectHeadSha === undefined
            ? { queueObservationHeadSha: details.headSha }
            : { expectedHeadSha: details.headSha }),
          enqueueAttempt: attempt,
          queueScope: scope,
          ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
          ...actionContext,
        } satisfies ActionState,
      });
    }
    return mode === 'execute'
      ? {
          headSha: details.headSha,
          scope,
          attempts: attempt,
          lastActionKey: key,
          observedQueued: false,
          exhausted: false,
        }
      : undefined;
  }

  private recoverMergeQueueRetry(pr: PullRequestRef, headSha: string, scope: string): MergeQueueRetryState | undefined {
    const candidates = this.store
      .listEntities<ActionState>('action')
      .filter((entity) => {
        const mutation = entity.value.mutation;
        if (mutation.pr.number !== pr.number || mutation.pr.repo.toLowerCase() !== pr.repo.toLowerCase()) return false;
        if (!['pending', 'completed', 'failed', 'cancelled'].includes(entity.value.status)) return false;
        const actionHead =
          mutation.type === 'enqueue-exact-head'
            ? mutation.headSha
            : mutation.type === 'enqueue-provider-ready'
              ? entity.value.queueObservationHeadSha
              : entity.value.expectedHeadSha;
        if (actionHead?.toLowerCase() !== headSha.toLowerCase()) return false;
        if (
          mutation.type !== 'enqueue-exact-head' &&
          mutation.type !== 'enqueue-provider-ready' &&
          mutation.type !== 'enable-auto-merge'
        )
          return false;
        const actionScope = entity.value.queueScope ?? entity.value.attestationId ?? 'authored';
        return actionScope === scope;
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const latest = candidates[0];
    if (latest === undefined) return undefined;
    return {
      headSha,
      scope,
      attempts: latest.value.enqueueAttempt ?? 1,
      lastActionKey: latest.key,
      observedQueued: false,
      exhausted: latest.value.status === 'failed' || latest.value.status === 'cancelled',
    };
  }

  private recoverMergeQueueFence(pr: PullRequestRef, headSha: string): MergeQueueFence | undefined {
    return this.store
      .listEntities<MergeQueueFence>('merge-queue-fence')
      .filter(
        (entity) =>
          entity.value.prNumber === pr.number &&
          entity.value.repo.toLowerCase() === pr.repo.toLowerCase() &&
          entity.value.headSha.toLowerCase() === headSha.toLowerCase(),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.value;
  }

  private addDecision(
    type: 'auto-merge-decision' | 'branch-update-decision',
    mode: 'off' | 'notify' | 'execute',
    pr: PullRequestRef,
    identity: Record<string, unknown>,
    facts: Record<string, unknown>,
    mutation: GitHubMutation,
    events: ShepherdEvent[],
    actions: EntityUpdate[],
    actionContext: MergeQueueActionContext = {},
  ): void {
    if (mode === 'off') return;
    const event = buildEvent(this.config, type, pr, identity, { mode, ...facts }, this.clock().toISOString());
    events.push(event);
    if (mode === 'execute') {
      const expectedHeadSha = typeof identity.headSha === 'string' ? identity.headSha : undefined;
      const key = `action:${event.id}`;
      if (this.store.getEntity(key) !== undefined) return;
      actions.push({
        key,
        kind: 'action',
        value: { status: 'pending', mutation, expectedHeadSha, ...actionContext } satisfies ActionState,
      });
    }
  }

  private addReviewerCommentDecision(
    pr: PullRequestRef,
    details: PullRequestDetails,
    nudge: NudgeState,
    nudgeKey: string,
    events: ShepherdEvent[],
    actions: EntityUpdate[],
  ): void {
    const mode = this.config.automation.reviewerComment;
    if (mode === 'off') return;
    const body = `@${nudge.reviewer} — review feedback has been addressed and this pull request is ready for re-review.`;
    const event = buildEvent(
      this.config,
      'reviewer-comment-decision',
      pr,
      {
        headSha: details.headSha,
        reviewer: nudge.reviewer.toLowerCase(),
      },
      { mode, reviewer: nudge.reviewer, body, title: details.title, url: details.url },
      this.clock().toISOString(),
    );
    events.push(event);
    if (mode === 'execute') {
      const idempotentBody = `${body}\n\n<!-- pr-shepherd-action:${event.id} -->`;
      actions.push({
        key: `action:${event.id}`,
        kind: 'action',
        value: {
          status: 'pending',
          mutation: { type: 'post-reviewer-comment', pr, reviewer: nudge.reviewer, body: idempotentBody },
          relatedNudgeKey: nudgeKey,
          relatedNudgeHeadSha: details.headSha,
        } satisfies ActionState,
      });
    }
  }

  private relevantChecks(details: PullRequestDetails): PullRequestDetails['checks'] {
    return this.config.checks.required.length === 0
      ? details.checks.filter((check) => check.bucket !== 'skipping')
      : details.checks.filter((check) => this.config.checks.required.includes(check.name));
  }

  private checksReady(details: PullRequestDetails, priorCheckIds?: readonly string[]): boolean {
    const relevant = this.relevantChecks(details);
    if (priorCheckIds !== undefined) {
      const prior = new Set(priorCheckIds);
      const fresh = relevant.filter((check) => !prior.has(check.id));
      if (this.config.checks.required.length === 0 && fresh.length === 0) return false;
      const observed = new Set(fresh.map((check) => check.name));
      if (this.config.checks.required.some((required) => !observed.has(required))) return false;
    }
    return relevant.every(
      (check) => check.bucket !== 'fail' && check.bucket !== 'cancel' && check.bucket !== 'pending',
    );
  }

  private postSyncValidationReady(
    syncState: SyncAfterRejectHeadState | undefined,
    snapshot: HeadCheckSnapshot | undefined,
  ): boolean {
    if (syncState?.validation === undefined) return true;
    const validation = syncState.validation;
    const configured = this.config.automation.syncAfterRejectValidation;
    if (
      !this.config.automation.syncAfterReject ||
      this.config.automation.autoMerge !== 'execute' ||
      configured?.triggerComment !== validation.triggerComment ||
      configured?.requiredCheck !== validation.requiredCheck ||
      snapshot === undefined ||
      !snapshot.exhaustive ||
      snapshot.headSha.toLowerCase() !== syncState.currentHeadSha.toLowerCase()
    ) {
      return false;
    }
    const action = this.store.getEntity<ActionState>(validation.actionKey)?.value;
    if (action?.status !== 'completed') return false;
    const prior = new Set(validation.priorCheckIds);
    const fresh = snapshot.checks.filter((check) => check.name === validation.requiredCheck && !prior.has(check.id));
    return fresh.some((check) => check.bucket === 'pass' && check.state.toUpperCase() === 'SUCCESS');
  }

  private async cleanupMissingAuthored(
    observed: Set<string>,
    summary: PollSummary,
    baseline: boolean,
    activeTracked: ReadonlyMap<string, TrackedPullRequest>,
  ): Promise<void> {
    for (const entity of this.store.listEntities<AuthoredState>('authored')) {
      if (observed.has(entity.key) || activeTracked.has(entity.key)) continue;
      const previous = entity.value;
      let events: ShepherdEvent[] = [];
      try {
        const details = await this.github.getPullRequest(previous.details);
        if (!repositoryInScope(details.repo, this.config.github)) {
          this.store.commit([], [], undefined, this.relatedEntityKeys(details, entity.key));
          continue;
        }
        if (!baseline && details.state === 'MERGED') {
          events = [
            buildEvent(
              this.config,
              'merged',
              details,
              {
                mergedAt: details.mergedAt,
                headSha: details.headSha,
              },
              { title: details.title, url: details.url, mergedAt: details.mergedAt },
              details.mergedAt ?? this.clock().toISOString(),
            ),
          ];
        }
      } catch (error) {
        this.store.logHealth(
          'authored-cleanup-fetch-failed',
          `${entity.key}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      summary.emitted += this.store.commit(
        [],
        events,
        this.recipient(),
        this.relatedEntityKeys(previous.details, entity.key),
      ).length;
    }
  }

  private async pollInbox(summary: PollSummary): Promise<void> {
    const discovery = await this.discover('review-inbox', summary);
    const baseline = this.isBaseline('review-inbox');
    const observed = new Set<string>();
    for (const item of discovery.items) {
      const discoveredKey = prKey('inbox', item);
      observed.add(discoveredKey);
      const ineligible =
        (this.config.features.reviewInbox.ignoreDrafts && item.isDraft) ||
        this.config.features.reviewInbox.ignoredRepos.some((repo) => repo.toLowerCase() === item.repo.toLowerCase());
      const ageDays = (this.clock().getTime() - new Date(item.updatedAt).getTime()) / 86_400_000;
      if (
        (ineligible || ageDays > this.config.features.reviewInbox.maxAgeDays) &&
        this.store.getEntity<InboxState>(discoveredKey) === undefined
      )
        continue;
      await this.runItem(
        'review-inbox',
        item,
        async () => {
          const details = await this.github.getPullRequest(item);
          if (!repositoryInScope(details.repo, this.config.github)) return;
          const key = prKey('inbox', details);
          observed.add(key);
          if (this.reviewInboxHeadIgnored(details.headRefName)) {
            this.excludeReviewInboxLifecycle(details);
            return;
          }
          const reentry = this.reviewLaneReentry('review-inbox', details);
          const previous = this.store.getEntity<InboxState>(key)?.value;
          const disposition = this.inboxDisposition(details);
          const events: ShepherdEvent[] = [];
          if (!baseline && disposition !== previous?.disposition) {
            if (disposition === 'dispatched') {
              events.push(
                buildEvent(
                  this.config,
                  'review-dispatch',
                  details,
                  {
                    headSha: details.headSha,
                    requestUpdatedAt: details.updatedAt,
                    ...(reentry.cycle === undefined ? {} : { exclusionCycle: reentry.cycle }),
                  },
                  { title: details.title, url: details.url },
                  this.clock().toISOString(),
                ),
              );
            } else {
              const outcome = inboxCompletionOutcome(disposition);
              if (outcome !== undefined) {
                events.push(
                  buildEvent(
                    this.config,
                    'review-completed',
                    details,
                    {
                      headSha: details.headSha,
                      requestUpdatedAt: details.updatedAt,
                      outcome,
                      ...(reentry.cycle === undefined ? {} : { exclusionCycle: reentry.cycle }),
                    },
                    { outcome, title: details.title, url: details.url },
                    this.clock().toISOString(),
                  ),
                );
              }
            }
          }
          summary.emitted += this.store.commit(
            [...reentry.updates, { key, kind: 'review-inbox', value: { details, disposition } satisfies InboxState }],
            events,
            this.recipient(),
          ).length;
        },
        summary,
      );
    }
    if (discovery.exhaustive) {
      const missing = this.store.listEntities<InboxState>('review-inbox').filter((entity) => !observed.has(entity.key));
      for (const entity of missing) {
        await this.runItem(
          'review-inbox',
          entity.value.details,
          async () => {
            const details = await this.github.getPullRequest(entity.value.details);
            if (!repositoryInScope(details.repo, this.config.github)) {
              this.store.commit([], [], undefined, [entity.key]);
              return;
            }
            if (this.reviewInboxHeadIgnored(details.headRefName)) {
              this.excludeReviewInboxLifecycle(details);
              return;
            }
            const alreadyCompleted = inboxCompletionOutcome(entity.value.disposition) !== undefined;
            const outcome = 'assignment-ended';
            const events =
              baseline || alreadyCompleted
                ? []
                : [
                    buildEvent(
                      this.config,
                      'review-completed',
                      details,
                      {
                        headSha: details.headSha,
                        requestUpdatedAt: details.updatedAt,
                        outcome,
                      },
                      { outcome, title: details.title, url: details.url },
                      this.clock().toISOString(),
                    ),
                  ];
            summary.emitted += this.store.commit([], events, this.recipient(), [entity.key]).length;
          },
          summary,
        );
      }
    }
    if (!this.store.hasCompletedBootstrap('review-inbox')) this.store.markBootstrapComplete('review-inbox');
  }

  private inboxDisposition(details: PullRequestDetails): InboxState['disposition'] {
    if (
      details.reviews.some((review) => review.author.toLowerCase() === this.config.profile.githubUser.toLowerCase())
    ) {
      return 'already-reviewed';
    }
    const gates = this.config.reviews.bots.filter((bot) => bot.inboxGate);
    if (gates.length === 0) return 'dispatched';
    const latest = gates.map((bot) => ({
      bot,
      comment: sortedComments(
        details.comments.filter((comment) => comment.author.toLowerCase() === bot.username.toLowerCase()),
      ).at(-1),
    }));
    if (latest.some((entry) => entry.comment === undefined)) return 'waiting';
    return latest.every(
      ({ bot, comment }) =>
        comment !== undefined && bot.positivePatterns.some((pattern) => patternMatches(comment.body, pattern)),
    )
      ? 'auto-approved'
      : 'dispatched';
  }

  private async pollFollowUps(summary: PollSummary): Promise<void> {
    const discovery = await this.discover('review-follow-up', summary);
    const baseline = this.isBaseline('review-follow-up');
    const observed = new Set<string>();
    for (const item of discovery.items) {
      const discoveredKey = prKey('follow-up', item);
      observed.add(discoveredKey);
      if (item.isDraft && this.store.getEntity<FollowUpState>(discoveredKey) === undefined) continue;
      await this.runItem(
        'review-follow-up',
        item,
        async () => {
          const details = await this.github.getPullRequest(item);
          if (!repositoryInScope(details.repo, this.config.github)) return;
          const key = prKey('follow-up', details);
          observed.add(key);
          if (this.reviewInboxHeadIgnored(details.headRefName)) {
            this.excludeReviewInboxLifecycle(details);
            return;
          }
          const reentry = this.reviewLaneReentry('review-follow-up', details);
          if (details.state !== 'OPEN') {
            this.store.commit(reentry.updates, [], undefined, [key]);
            return;
          }

          const active = this.activeFollowUp(details);
          if (active.reviews.length === 0) {
            this.store.commit(reentry.updates, [], undefined, [key]);
            return;
          }

          const previous = this.store.getEntity<FollowUpState>(key)?.value;
          const trackedReviewIds = active.reviews.map((review) => review.id).sort();
          const previousReviewIds = [
            ...(previous?.trackedReviewIds ?? (previous?.reviewId === undefined ? [] : [previous.reviewId])),
          ].sort();
          const legacyReview =
            previous !== undefined && previous.trackedReviewIds === undefined && previous.reviewId !== undefined
              ? previous.details.reviews.find((review) => review.id === previous.reviewId)
              : undefined;
          const continuingLegacyLifecycle =
            legacyReview !== undefined &&
            active.reviews.some(
              (review) =>
                review.author.toLowerCase() === legacyReview.author.toLowerCase() &&
                review.state === legacyReview.state &&
                review.submittedAt === legacyReview.submittedAt,
            );
          const sameLifecycle =
            previous !== undefined && (sameStrings(previousReviewIds, trackedReviewIds) || continuingLegacyLifecycle);
          const reviewedHeadSha = sameLifecycle
            ? previous.reviewedHeadSha
            : this.reviewedHead(details, active.reviews.at(-1));
          const requested = details.requestedReviewers.some(
            (reviewer) => reviewer.login.toLowerCase() === this.config.profile.githubUser.toLowerCase(),
          );
          const previousThreads = sameLifecycle ? (previous.threads ?? {}) : {};
          const nextThreads: Record<string, FollowUpThreadState> = {};
          const newReplies = new Map<string, ReviewThreadComment[]>();
          const outdatedTransitions: { threadId: string; cycle: number }[] = [];
          const resolvedTransitions: { threadId: string; cycle: number }[] = [];

          for (const thread of active.threads) {
            const oldThread = previousThreads[thread.id];
            let outdatedCycle = oldThread?.outdatedCycle ?? 0;
            let resolvedCycle = oldThread?.resolvedCycle ?? 0;
            if (sameLifecycle && oldThread !== undefined) {
              const seen = new Set(oldThread.seenCommentIds ?? []);
              const replies = thread.comments.filter(
                (comment) =>
                  !seen.has(comment.id) &&
                  comment.id !== thread.rootCommentId &&
                  !this.ignoredFollowUpReply(comment.author),
              );
              if (replies.length > 0) newReplies.set(thread.id, replies);
              if (!oldThread.isOutdated && thread.isOutdated) {
                outdatedCycle += 1;
                outdatedTransitions.push({ threadId: thread.id, cycle: outdatedCycle });
              }
              if (!oldThread.isResolved && thread.isResolved) {
                resolvedCycle += 1;
                resolvedTransitions.push({ threadId: thread.id, cycle: resolvedCycle });
              }
            }
            nextThreads[thread.id] = {
              rootCommentId: thread.rootCommentId,
              isOutdated: thread.isOutdated,
              isResolved: thread.isResolved,
              seenCommentIds: thread.comments.map((comment) => comment.id),
              outdatedCycle,
              resolvedCycle,
            };
          }

          const headChanged = details.headSha !== reviewedHeadSha && previous?.notifiedHeadSha !== details.headSha;
          let reviewRequestCycle = sameLifecycle ? (previous.reviewRequestCycle ?? 0) : 0;
          const reviewRequestedTransition = sameLifecycle && previous.reviewRequested === false && requested;
          if (reviewRequestedTransition) reviewRequestCycle += 1;

          const reasons: FollowUpReason[] = [];
          if (!baseline && headChanged) reasons.push('head-changed');
          if (!baseline && newReplies.size > 0) reasons.push('thread-replied');
          if (!baseline && outdatedTransitions.length > 0) reasons.push('thread-outdated');
          if (!baseline && resolvedTransitions.length > 0) reasons.push('thread-resolved');
          if (!baseline && reviewRequestedTransition) reasons.push('review-requested');

          const transitionedThreadIds = new Set([
            ...newReplies.keys(),
            ...outdatedTransitions.map((transition) => transition.threadId),
            ...resolvedTransitions.map((transition) => transition.threadId),
          ]);
          const includeAllThreads = reasons.includes('head-changed') || reasons.includes('review-requested');
          const affectedThreads = active.threads.filter(
            (thread) => includeAllThreads || transitionedThreadIds.has(thread.id),
          );
          const event =
            reasons.length === 0
              ? undefined
              : buildEvent(
                  this.config,
                  'scoped-re-review',
                  details,
                  {
                    reviewIds: trackedReviewIds,
                    headSha: reasons.includes('head-changed') ? details.headSha : undefined,
                    replyIds: [...newReplies.values()]
                      .flat()
                      .map((reply) => reply.id)
                      .sort(),
                    outdatedTransitions: outdatedTransitions
                      .map((transition) => `${transition.threadId}:${String(transition.cycle)}`)
                      .sort(),
                    resolvedTransitions: resolvedTransitions
                      .map((transition) => `${transition.threadId}:${String(transition.cycle)}`)
                      .sort(),
                    reviewRequestCycle: reviewRequestedTransition ? reviewRequestCycle : undefined,
                    ...(reentry.cycle === undefined ? {} : { exclusionCycle: reentry.cycle }),
                  },
                  {
                    title: details.title,
                    url: details.url,
                    triggeringReasons: reasons,
                    activeReviewIds: trackedReviewIds,
                    reviewedHeadSha,
                    currentHeadSha: details.headSha,
                    reviewRequested: requested,
                    affectedThreads: affectedThreads.map((thread) =>
                      this.followUpThreadFacts(thread, newReplies.get(thread.id) ?? []),
                    ),
                  },
                  this.clock().toISOString(),
                );
          const state: FollowUpState = {
            trackedReviewIds,
            reviewedHeadSha,
            notifiedHeadSha: headChanged ? details.headSha : sameLifecycle ? previous.notifiedHeadSha : null,
            reviewRequested: requested,
            reviewRequestCycle,
            threads: nextThreads,
            details,
          };
          summary.emitted += this.store.commit(
            [...reentry.updates, { key, kind: 'review-follow-up', value: state }],
            event === undefined ? [] : [event],
            this.recipient(),
          ).length;
        },
        summary,
      );
    }
    if (discovery.exhaustive) {
      const missing = this.store
        .listEntities<FollowUpState>('review-follow-up')
        .filter((entity) => !observed.has(entity.key));
      for (const entity of missing) {
        await this.runItem(
          'review-follow-up',
          entity.value.details,
          async () => {
            const details = await this.github.getPullRequest(entity.value.details);
            if (this.reviewInboxHeadIgnored(details.headRefName)) this.excludeReviewInboxLifecycle(details);
            else this.store.commit([], [], undefined, [entity.key]);
          },
          summary,
        );
      }
    }
    if (!this.store.hasCompletedBootstrap('review-follow-up')) this.store.markBootstrapComplete('review-follow-up');
  }

  private activeFollowUp(details: PullRequestDetails): { reviews: Review[]; threads: ReviewThread[] } {
    const reviewer = this.config.profile.githubUser.toLowerCase();
    const ours = sortedReviews(details.reviews.filter((review) => review.author.toLowerCase() === reviewer));
    const latestApproval = ours.filter((review) => review.state === 'APPROVED').at(-1);
    const candidateReviews = ours.filter(
      (review) => latestApproval === undefined || review.submittedAt > latestApproval.submittedAt,
    );
    const threadsByReview = new Map<string, ReviewThread[]>();
    for (const thread of details.reviewThreads) {
      if (thread.rootAuthor.toLowerCase() !== reviewer) continue;
      const existing = threadsByReview.get(thread.reviewId) ?? [];
      existing.push(thread);
      threadsByReview.set(thread.reviewId, existing);
    }
    const reviews = candidateReviews.filter(
      (review) =>
        review.state === 'CHANGES_REQUESTED' ||
        (review.state === 'COMMENTED' && (threadsByReview.get(review.id)?.length ?? 0) > 0),
    );
    const reviewIds = new Set(reviews.map((review) => review.id));
    return {
      reviews,
      threads: details.reviewThreads.filter(
        (thread) => reviewIds.has(thread.reviewId) && thread.rootAuthor.toLowerCase() === reviewer,
      ),
    };
  }

  private reviewedHead(details: PullRequestDetails, review: Review | undefined): string {
    if (review === undefined) return details.headSha;
    if (review.commitSha !== undefined) return review.commitSha;
    const reviewedCommit = [...details.commits]
      .filter((commit) => commit.committedAt <= review.submittedAt)
      .sort((left, right) => right.committedAt.localeCompare(left.committedAt))[0];
    return reviewedCommit?.sha ?? details.headSha;
  }

  private ignoredFollowUpReply(author: string): boolean {
    const normalized = author.toLowerCase();
    return (
      normalized === this.config.profile.githubUser.toLowerCase() ||
      this.config.reviews.ignoredActors.some((ignored) => ignored.toLowerCase() === normalized)
    );
  }

  private followUpThreadFacts(thread: ReviewThread, replies: ReviewThreadComment[]): Record<string, unknown> {
    const root = thread.comments.find((comment) => comment.id === thread.rootCommentId);
    return {
      threadId: thread.id,
      threadUrl: thread.url,
      rootCommentId: thread.rootCommentId,
      reviewId: thread.reviewId,
      path: thread.path,
      originalLine: thread.originalLine,
      originalSide: thread.originalSide,
      currentLine: thread.currentLine,
      currentSide: thread.currentSide,
      rootFinding: root === undefined ? undefined : excerpt(root.body),
      isOutdated: thread.isOutdated,
      isResolved: thread.isResolved,
      newReplies: replies.map((reply) => ({
        id: reply.id,
        author: reply.author,
        body: reply.body,
        createdAt: reply.createdAt,
        updatedAt: reply.updatedAt,
        url: reply.url,
      })),
    };
  }

  private async pollNudges(summary: PollSummary): Promise<void> {
    const discovery = await this.discover('reviewer-nudge', summary);
    const open = new Set(discovery.items.map((item) => `${item.repo.toLowerCase()}#${String(item.number)}`));
    const baseline = this.isBaseline('reviewer-nudge');
    for (const entity of this.store.listEntities<NudgeState>('nudge')) {
      const nudge = entity.value;
      try {
        const key = `${nudge.details.repo.toLowerCase()}#${String(nudge.details.number)}`;
        if (discovery.exhaustive && !open.has(key)) {
          this.store.commit([], [], undefined, [entity.key]);
          continue;
        }
        const details = await this.github.getPullRequest(nudge.details);
        if (!repositoryInScope(details.repo, this.config.github)) {
          this.store.commit([], [], undefined, [entity.key]);
          continue;
        }
        const escalationReference = nudge.commentPostedAt ?? nudge.escalationReferenceAt;
        const response = details.reviews.some(
          (review) =>
            review.author.toLowerCase() === nudge.reviewer.toLowerCase() &&
            escalationReference !== null &&
            escalationReference !== undefined &&
            review.submittedAt > escalationReference,
        );
        if (response || details.state !== 'OPEN') {
          this.store.commit([], [], undefined, [entity.key]);
          continue;
        }
        if (escalationReference === null || escalationReference === undefined) continue;
        const config = this.config.features.reviewerNudge;
        const reference = nudge.lastEscalatedAt ?? escalationReference;
        const hours = elapsedHours(reference, this.clock(), config.businessDaysOnly, config.timezone);
        const allowed = config.maxEscalations === null || nudge.escalationCount < config.maxEscalations;
        if (baseline && allowed && hours >= config.escalateAfterHours) {
          this.store.commit(
            [
              {
                key: entity.key,
                kind: 'nudge',
                value: { ...nudge, details, lastEscalatedAt: this.clock().toISOString() },
              },
            ],
            [],
          );
          continue;
        }
        if (!baseline && allowed && hours >= config.escalateAfterHours) {
          const nextCount = nudge.escalationCount + 1;
          const event = buildEvent(
            this.config,
            'reviewer-escalation',
            details,
            {
              reviewer: nudge.reviewer.toLowerCase(),
              headSha: details.headSha,
              escalationCount: nextCount,
            },
            {
              reviewer: nudge.reviewer,
              hours: Math.floor(hours),
              escalationCount: nextCount,
              title: details.title,
              url: details.url,
            },
            this.clock().toISOString(),
          );
          const updated: NudgeState = {
            ...nudge,
            details,
            lastEscalatedAt: this.clock().toISOString(),
            escalationCount: nextCount,
          };
          summary.emitted += this.store.commit(
            [{ key: entity.key, kind: 'nudge', value: updated }],
            [event],
            this.recipient(),
          ).length;
        }
      } catch (error) {
        const detail = `reviewer-nudge ${nudge.details.repo}#${String(nudge.details.number)}: ${error instanceof Error ? error.message : String(error)}`;
        summary.warnings.push(detail);
        this.store.logHealth('feature-item-failed', detail);
      }
    }
    if (!this.store.hasCompletedBootstrap('reviewer-nudge')) this.store.markBootstrapComplete('reviewer-nudge');
  }

  private isBaseline(kind: DiscoveryKind): boolean {
    return this.config.polling.bootstrap === 'baseline-only' && !this.store.hasCompletedBootstrap(kind);
  }

  private recipient(): string {
    return this.config.delivery.type === 'conductor' ? this.config.delivery.coordinatorSession : 'stdout';
  }

  private reviewInboxHeadIgnored(headRefName: string): boolean {
    return this.ignoredReviewInboxHeadPatterns.some((pattern) => pattern.test(headRefName));
  }

  private excludeReviewInboxLifecycle(pr: PullRequestDetails): void {
    this.store.suppressOutbox?.(
      pr,
      REVIEW_INBOX_EVENT_TYPES,
      `suppressed by features.reviewInbox.ignoredHeadPatterns for head ${pr.headRefName}`,
    );
    const updates = (['review-inbox', 'review-follow-up'] as const).map((lane) => {
      const key = prKey(`exclusion-${lane}`, pr);
      const previous = this.store.getEntity<ReviewExclusionState>(key)?.value;
      return {
        key,
        kind: 'review-exclusion',
        value: {
          excluded: true,
          cycle: previous?.excluded === true ? previous.cycle : (previous?.cycle ?? 0) + 1,
          details: pr,
        } satisfies ReviewExclusionState,
      };
    });
    this.store.commit(updates, [], undefined, [prKey('inbox', pr), prKey('follow-up', pr)]);
  }

  private reviewLaneReentry(lane: ReviewLane, pr: PullRequestDetails): { updates: EntityUpdate[]; cycle?: number } {
    const key = prKey(`exclusion-${lane}`, pr);
    const previous = this.store.getEntity<ReviewExclusionState>(key)?.value;
    if (previous?.excluded !== true) return { updates: [] };
    return {
      updates: [
        {
          key,
          kind: 'review-exclusion',
          value: { ...previous, excluded: false, details: pr } satisfies ReviewExclusionState,
        },
      ],
      cycle: previous.cycle,
    };
  }

  private trackedStore(): TrackedPullRequestStore {
    if (!supportsTrackedPullRequests(this.store)) {
      throw new Error('features.trackedPRs requires a tracked pull-request store capability.');
    }
    return this.store;
  }

  private async runItem(
    feature: DiscoveryKind | 'tracked-selectors',
    pr: PullRequestRef,
    run: () => Promise<void>,
    summary: PollSummary,
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      const detail = `${feature} ${pr.repo}#${String(pr.number)}: ${error instanceof Error ? error.message : String(error)}`;
      summary.warnings.push(detail);
      this.store.logHealth('feature-item-failed', detail);
    }
  }

  private relatedEntityKeys(pr: PullRequestRef, authoredKey: string): string[] {
    const samePr = (candidate: PullRequestRef): boolean =>
      candidate.number === pr.number && candidate.repo.toLowerCase() === pr.repo.toLowerCase();
    const actions = this.store
      .listEntities<ActionState>('action')
      .filter(
        (entity) =>
          samePr(entity.value.mutation.pr) &&
          !(entity.value.compensationFor !== undefined && entity.value.status === 'pending'),
      )
      .map((entity) => entity.key);
    const nudges = this.store
      .listEntities<NudgeState>('nudge')
      .filter((entity) => samePr(entity.value.details))
      .map((entity) => entity.key);
    return [authoredKey, ...actions, ...nudges];
  }
}
