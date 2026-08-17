import type { ShepherdConfig } from './config.js';
import { buildEvent } from './events.js';
import { ShepherdMutationMutex } from './mutex.js';
import { patternMatches, repositoryInScope } from './scope.js';
import { elapsedHours } from './time.js';
import type {
  Comment,
  DiscoveryKind,
  EntityUpdate,
  GitHubMutation,
  GitHubProvider,
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
  receivedReviewThreads?: Record<string, ReceivedReviewThreadState>;
  sources?: { authored: boolean; trackedGeneration?: number };
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

interface InboxState {
  details: PullRequestDetails;
  disposition: 'waiting' | 'dispatched' | 'auto-approved' | 'already-reviewed';
}

type InboxCompletionOutcome = 'bot-auto-approved' | 'already-reviewed';

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
}

export interface PollSummary {
  discovered: number;
  emitted: number;
  mutations: number;
  warnings: string[];
}

function prKey(kind: string, pr: PullRequestRef): string {
  return `${kind}:${pr.repo.toLowerCase()}#${String(pr.number)}`;
}

function latestReviews(reviews: Review[]): Review[] {
  const latest = new Map<string, Review>();
  for (const review of reviews) {
    const key = review.author.toLowerCase();
    const previous = latest.get(key);
    if (previous === undefined || review.submittedAt > previous.submittedAt) latest.set(key, review);
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

  constructor(
    private readonly config: ShepherdConfig,
    private readonly github: GitHubProvider,
    private readonly store: ShepherdStore,
    private readonly clock: () => Date = () => new Date(),
    mutationMutex?: ShepherdMutationMutex,
  ) {
    this.mutationMutex = mutationMutex;
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
        if (entity.value.status === 'cancelled') {
          this.store.ensureActionSafetyCompensation(entity.key, recoveredAt);
        }
      }
    }
    for (const entity of this.store.listEntities<ActionState>('action')) {
      if (entity.value.status !== 'pending') continue;
      if (
        entity.value.nextAttemptAt !== undefined &&
        new Date(entity.value.nextAttemptAt).getTime() > this.clock().getTime()
      ) {
        continue;
      }
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
        } else if (
          entity.value.mutation.type === 'merge-exact-head' ||
          entity.value.mutation.type === 'enqueue-exact-head'
        ) {
          const mutated = await this.releaseMutex().runExclusive(async (lease) => {
            const details = await this.github.getPullRequest(entity.value.mutation.pr);
            if (!this.gatedActionStillApplicable(entity.value, details)) {
              this.cancelAction(entity.key, entity.value, 'exact-head release gate is no longer applicable');
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
        if (entity.value.mutation.type === 'update-branch' && attempts >= 5) {
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
    if (supportsReleaseGate(this.store)) {
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
      throw new Error('The Shepherd store does not support exact-head release gates.');
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
    if (action.mutation.type === 'merge-exact-head' || action.mutation.type === 'enqueue-exact-head') {
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

  private gatedActionStillApplicable(action: ActionState, details: PullRequestDetails): boolean {
    if (
      action.trackedGeneration === undefined ||
      action.attestationHeadSha === undefined ||
      action.attestationId === undefined ||
      !this.config.features.trackedPRs.enabled ||
      this.config.features.trackedPRs.releaseGate !== 'exact-head-attestation' ||
      !supportsReleaseGate(this.store)
    )
      return false;
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
    const directBehind = this.config.github.mode === 'direct' && details.mergeStateStatus === 'BEHIND';
    return (
      details.mergeable === 'MERGEABLE' &&
      !directBehind &&
      this.checksReady(details) &&
      !reviews.some((review) => review.state === 'CHANGES_REQUESTED') &&
      reviews.filter((review) => review.state === 'APPROVED').length >= this.config.reviews.requiredApprovals
    );
  }

  private async poll(): Promise<PollSummary> {
    const summary: PollSummary = { discovered: 0, emitted: 0, mutations: 0, warnings: [] };
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

  private async runFeature(name: DiscoveryKind, run: () => Promise<void>, summary: PollSummary): Promise<void> {
    try {
      await run();
    } catch (error) {
      const detail = `${name}: ${error instanceof Error ? error.message : String(error)}`;
      summary.warnings.push(detail);
      this.store.logHealth('feature-poll-failed', detail);
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
          const baseline = isBaseline || (previous === undefined && tracked?.baselinePending === true);
          const { state, events, actions, nudges } = this.evaluateAuthored(
            details,
            previous,
            baseline,
            tracked !== undefined,
            authoredKeys.has(key),
            tracked?.generation,
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
              const fallback = this.evaluateAuthored(details, previous, isBaseline, false, true);
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

  private evaluateAuthored(
    details: PullRequestDetails,
    previous: AuthoredState | undefined,
    baseline: boolean,
    tracked = false,
    authored = true,
    trackedGeneration?: number,
  ): { state: AuthoredState; events: ShepherdEvent[]; actions: EntityUpdate[]; nudges: EntityUpdate[] } {
    const now = this.clock();
    const events: ShepherdEvent[] = [];
    const actions: EntityUpdate[] = [];
    const nudges: EntityUpdate[] = [];
    const pr: PullRequestRef = { repo: details.repo, number: details.number };
    const previousDetails = previous?.details;
    const botAttempts = { ...(previous?.botAttempts ?? {}) };
    let staleCycle = previous?.staleCycle ?? 0;
    let conflictCycle = previous?.conflictCycle ?? 0;
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

      const approvals = reviews.filter((review) => review.state === 'APPROVED');
      const changesRequested = reviews.filter((review) => review.state === 'CHANGES_REQUESTED');
      const oldReviews = latestReviews(previousDetails?.reviews ?? []);
      const oldApprovals = oldReviews.filter((review) => review.state === 'APPROVED');
      const checksReady = this.checksReady(details);
      const previousChecksReady = previousDetails !== undefined && this.checksReady(previousDetails);
      const directBehind =
        this.config.github.mode === 'direct' &&
        details.mergeStateStatus === 'BEHIND' &&
        details.mergeable === 'MERGEABLE';
      const mergeReady = details.mergeable === 'MERGEABLE' && !directBehind;
      const releaseReady =
        mergeReady &&
        checksReady &&
        changesRequested.length === 0 &&
        approvals.length >= this.config.reviews.requiredApprovals;
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
      if (releaseReady && details.autoMergeRequest === null) {
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
          } else {
            const mutation: GitHubMutation =
              this.config.github.mode === 'merge-queue'
                ? { type: 'enqueue-exact-head', pr, headSha: details.headSha }
                : {
                    type: 'merge-exact-head',
                    pr,
                    headSha: details.headSha,
                    mergeMethod: this.config.github.mergeMethod,
                  };
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
              mutation,
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
        receivedReviewThreads: receivedReviewFeedback.threads,
        sources: { authored, ...(trackedGeneration === undefined ? {} : { trackedGeneration }) },
      },
      events: baseline ? [] : events,
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

    for (const thread of [...details.reviewThreads].sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    )) {
      const oldThread = previousThreads[thread.id];
      const newlyPresent = oldThread?.present !== true;
      let createdCycle = oldThread?.createdCycle ?? 0;
      let outdatedCycle = oldThread?.outdatedCycle ?? 0;
      let resolvedCycle = oldThread?.resolvedCycle ?? 0;
      if (!baseline && newlyPresent) {
        createdCycle += 1;
        createdTransitions.push({ threadId: thread.id, cycle: createdCycle });
      }

      const seen = new Set(oldThread?.seenCommentIds ?? []);
      const replies = [...thread.comments]
        .sort((left, right) => {
          const byTime = left.createdAt.localeCompare(right.createdAt);
          return byTime === 0 ? (left.id < right.id ? -1 : left.id > right.id ? 1 : 0) : byTime;
        })
        .filter((comment) => comment.id !== thread.rootCommentId && !seen.has(comment.id));
      if (!baseline && replies.length > 0) newReplies.set(thread.id, replies);

      if (!baseline && oldThread?.present === true && !oldThread.isOutdated && thread.isOutdated) {
        outdatedCycle += 1;
        outdatedTransitions.push({ threadId: thread.id, cycle: outdatedCycle });
      }
      if (!baseline && oldThread?.present === true && !oldThread.isResolved && thread.isResolved) {
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
    const affectedThreads = details.reviewThreads.filter(
      (thread) => affectedThreadIds.has(thread.id) || newReviewIds.has(thread.reviewId),
    );
    const contextReviewIds = new Set([...newReviewIds, ...affectedThreads.map((thread) => thread.reviewId)]);
    const contextReviews = sortedReviews(details.reviews.filter((review) => contextReviewIds.has(review.id)));
    const primaryReview = newReviews.length === 1 ? newReviews[0] : undefined;
    const occurredAt =
      reasons.length === 1 && reasons[0] === 'review-submitted' && primaryReview !== undefined
        ? primaryReview.submittedAt
        : this.clock().toISOString();
    const identity =
      reasons.length === 1 && reasons[0] === 'review-submitted' && primaryReview !== undefined
        ? { reviewId: primaryReview.id, state: primaryReview.state }
        : {
            reviewIds: newReviews.map((review) => review.id),
            createdTransitions: createdTransitions.map(({ threadId, cycle }) => `${threadId}:${String(cycle)}`).sort(),
            replyIds: [...newReplies.values()]
              .flat()
              .map(({ id }) => id)
              .sort(),
            outdatedTransitions: outdatedTransitions
              .map(({ threadId, cycle }) => `${threadId}:${String(cycle)}`)
              .sort(),
            resolvedTransitions: resolvedTransitions
              .map(({ threadId, cycle }) => `${threadId}:${String(cycle)}`)
              .sort(),
            ...(primaryReview === undefined ? {} : { reviewId: primaryReview.id, state: primaryReview.state }),
          };
    return {
      threads: nextThreads,
      event: buildEvent(
        this.config,
        'review-feedback',
        details,
        identity,
        {
          title: details.title,
          url: details.url,
          triggeringReasons: reasons,
          reviews: contextReviews.map((review) => ({
            id: review.id,
            author: review.author,
            state: review.state,
            body: review.body,
            submittedAt: review.submittedAt,
            commitSha: review.commitSha,
          })),
          affectedThreads: affectedThreads.map((thread) =>
            this.receivedReviewThreadFacts(thread, newReplies.get(thread.id) ?? []),
          ),
          ...(primaryReview === undefined ? {} : { reviewer: primaryReview.author, body: primaryReview.body }),
        },
        occurredAt,
      ),
    };
  }

  private receivedReviewThreadFacts(thread: ReviewThread, replies: ReviewThreadComment[]): Record<string, unknown> {
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
              body: root.body,
              createdAt: root.createdAt,
              updatedAt: root.updatedAt,
              url: root.url,
            },
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

  private addDecision(
    type: 'auto-merge-decision' | 'branch-update-decision',
    mode: 'off' | 'notify' | 'execute',
    pr: PullRequestRef,
    identity: Record<string, unknown>,
    facts: Record<string, unknown>,
    mutation: GitHubMutation,
    events: ShepherdEvent[],
    actions: EntityUpdate[],
    actionContext: Pick<ActionState, 'trackedGeneration' | 'attestationHeadSha' | 'attestationId'> = {},
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

  private checksReady(details: PullRequestDetails): boolean {
    return this.relevantChecks(details).every(
      (check) => check.bucket !== 'fail' && check.bucket !== 'cancel' && check.bucket !== 'pending',
    );
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
                  { headSha: details.headSha, requestUpdatedAt: details.updatedAt },
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
                    { headSha: details.headSha, requestUpdatedAt: details.updatedAt, outcome },
                    { outcome, title: details.title, url: details.url },
                    this.clock().toISOString(),
                  ),
                );
              }
            }
          }
          summary.emitted += this.store.commit(
            [{ key, kind: 'review-inbox', value: { details, disposition } satisfies InboxState }],
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
        if (!repositoryInScope(entity.value.details.repo, this.config.github)) {
          this.store.commit([], [], undefined, [entity.key]);
          continue;
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
                  entity.value.details,
                  {
                    headSha: entity.value.details.headSha,
                    requestUpdatedAt: entity.value.details.updatedAt,
                    outcome,
                  },
                  { outcome, title: entity.value.details.title, url: entity.value.details.url },
                  this.clock().toISOString(),
                ),
              ];
        summary.emitted += this.store.commit([], events, this.recipient(), [entity.key]).length;
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
          if (details.state !== 'OPEN') {
            this.store.commit([], [], undefined, [key]);
            return;
          }

          const active = this.activeFollowUp(details);
          if (active.reviews.length === 0) {
            this.store.commit([], [], undefined, [key]);
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
            [{ key, kind: 'review-follow-up', value: state }],
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
        .filter((entity) => !observed.has(entity.key))
        .map((entity) => entity.key);
      this.store.commit([], [], undefined, missing);
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

  private trackedStore(): TrackedPullRequestStore {
    if (!supportsTrackedPullRequests(this.store)) {
      throw new Error('features.trackedPRs requires a tracked pull-request store capability.');
    }
    return this.store;
  }

  private async runItem(
    feature: DiscoveryKind,
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
