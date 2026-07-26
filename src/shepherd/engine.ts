import type { ShepherdConfig } from './config.js';
import { buildEvent } from './events.js';
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
  Review,
  ShepherdEvent,
  ShepherdStore,
} from './types.js';

interface AuthoredState {
  details: PullRequestDetails;
  lastObservedAt: string;
  botAttempts: Record<string, number>;
  staleCycle: number;
  conflictCycle: number;
}

interface InboxState {
  details: PullRequestDetails;
  disposition: 'waiting' | 'dispatched' | 'auto-approved' | 'already-reviewed';
}

type InboxCompletionOutcome = 'bot-auto-approved' | 'already-reviewed';

interface FollowUpState {
  reviewId: string;
  reviewedHeadSha: string;
  notifiedHeadSha: string | null;
  details: PullRequestDetails;
}

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

function inboxCompletionOutcome(disposition: InboxState['disposition']): InboxCompletionOutcome | undefined {
  if (disposition === 'auto-approved') return 'bot-auto-approved';
  if (disposition === 'already-reviewed') return 'already-reviewed';
  return undefined;
}

export class ShepherdEngine {
  private pollInFlight: Promise<PollSummary> | undefined;

  constructor(
    private readonly config: ShepherdConfig,
    private readonly github: GitHubProvider,
    private readonly store: ShepherdStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  pollOnce(): Promise<PollSummary> {
    if (this.pollInFlight !== undefined) return this.pollInFlight;
    this.pollInFlight = this.poll().finally(() => {
      this.pollInFlight = undefined;
    });
    return this.pollInFlight;
  }

  async drainActions(): Promise<number> {
    let completed = 0;
    for (const entity of this.store.listEntities<ActionState>('action')) {
      if (entity.value.status !== 'pending') continue;
      if (
        entity.value.nextAttemptAt !== undefined &&
        new Date(entity.value.nextAttemptAt).getTime() > this.clock().getTime()
      ) {
        continue;
      }
      if (!repositoryInScope(entity.value.mutation.pr.repo, this.config.github)) {
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
    this.store.commit(
      [
        {
          key,
          kind: 'action',
          value: { ...action, status: 'cancelled', completedAt: this.clock().toISOString() },
        },
      ],
      [],
    );
    this.store.logHealth('github-mutation-cancelled', `${key}: ${reason}`);
  }

  private actionStillApplicable(action: ActionState): boolean {
    if (action.mutation.type === 'post-reviewer-comment') return true;
    const authored = this.store.getEntity<AuthoredState>(prKey('authored', action.mutation.pr))?.value;
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

  private async poll(): Promise<PollSummary> {
    const summary: PollSummary = { discovered: 0, emitted: 0, mutations: 0, warnings: [] };
    if (this.config.features.authoredPRs.enabled) {
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
    const discovery = await this.discover('authored', summary);
    const isBaseline = this.isBaseline('authored');
    const observed = new Set<string>();

    for (const item of discovery.items) {
      if (item.isDraft) continue;
      observed.add(prKey('authored', item));
      await this.runItem(
        'authored',
        item,
        async () => {
          const details = await this.github.getPullRequest(item);
          if (!repositoryInScope(details.repo, this.config.github)) return;
          const key = prKey('authored', details);
          observed.add(key);
          const previous = this.store.getEntity<AuthoredState>(key)?.value;
          const { state, events, actions, nudges } = this.evaluateAuthored(details, previous, isBaseline);
          const inserted = this.store.commit(
            [{ key, kind: 'authored', value: state }, ...actions, ...nudges],
            events,
            this.recipient(),
            details.state === 'OPEN' ? [] : this.relatedEntityKeys(details, key),
          );
          summary.emitted += inserted.length;
        },
        summary,
      );
    }

    if (discovery.exhaustive) await this.cleanupMissingAuthored(observed, summary, isBaseline);
    if (!this.store.hasCompletedBootstrap('authored')) this.store.markBootstrapComplete('authored');
  }

  private evaluateAuthored(
    details: PullRequestDetails,
    previous: AuthoredState | undefined,
    baseline: boolean,
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
      const oldReviewIds = new Set(previousDetails?.reviews.map((review) => review.id) ?? []);
      for (const review of reviews.filter(
        (item) =>
          (item.state === 'CHANGES_REQUESTED' || (item.state === 'COMMENTED' && item.body.trim().length > 0)) &&
          !oldReviewIds.has(item.id),
      )) {
        events.push(
          buildEvent(
            this.config,
            'review-feedback',
            pr,
            { reviewId: review.id, state: review.state },
            {
              reviewer: review.author,
              body: review.body,
              title: details.title,
              url: details.url,
            },
            review.submittedAt,
          ),
        );
      }

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
      if (
        mergeReady &&
        checksReady &&
        changesRequested.length === 0 &&
        approvals.length >= this.config.reviews.requiredApprovals &&
        (oldReviews.some((review) => review.state === 'CHANGES_REQUESTED') ||
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
          previousDetails?.headSha !== details.headSha)
      ) {
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
        if (details.autoMergeRequest === null) {
          this.addDecision(
            'auto-merge-decision',
            this.config.automation.autoMerge,
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
      state: { details, lastObservedAt: now.toISOString(), botAttempts, staleCycle, conflictCycle },
      events: baseline ? [] : events,
      actions: baseline ? [] : actions,
      nudges: baseline ? [] : nudges,
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
  ): void {
    if (mode === 'off') return;
    const event = buildEvent(this.config, type, pr, identity, { mode, ...facts }, this.clock().toISOString());
    events.push(event);
    if (mode === 'execute') {
      const expectedHeadSha = typeof identity.headSha === 'string' ? identity.headSha : undefined;
      actions.push({
        key: `action:${event.id}`,
        kind: 'action',
        value: { status: 'pending', mutation, expectedHeadSha } satisfies ActionState,
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

  private async cleanupMissingAuthored(observed: Set<string>, summary: PollSummary, baseline: boolean): Promise<void> {
    for (const entity of this.store.listEntities<AuthoredState>('authored')) {
      if (observed.has(entity.key)) continue;
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
          const ourReviews = details.reviews
            .filter((review) => review.author.toLowerCase() === this.config.profile.githubUser.toLowerCase())
            .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));
          const ours = ourReviews.find((review) => review.state === 'CHANGES_REQUESTED');
          const laterApproval = ourReviews.find((review) => review.state === 'APPROVED');
          if (ours === undefined || (laterApproval !== undefined && laterApproval.submittedAt > ours.submittedAt)) {
            this.store.commit([], [], undefined, [key]);
            return;
          }
          const previous = this.store.getEntity<FollowUpState>(key)?.value;
          const reviewedCommit = [...details.commits]
            .filter((commit) => commit.committedAt <= ours.submittedAt)
            .sort((left, right) => right.committedAt.localeCompare(left.committedAt))[0];
          const reviewedHeadSha =
            previous?.reviewId === ours.id ? previous.reviewedHeadSha : (reviewedCommit?.sha ?? details.headSha);
          const changed = details.headSha !== reviewedHeadSha && previous?.notifiedHeadSha !== details.headSha;
          const events =
            !baseline && changed
              ? [
                  buildEvent(
                    this.config,
                    'scoped-re-review',
                    details,
                    { reviewId: ours.id, headSha: details.headSha },
                    {
                      previousReviewAt: ours.submittedAt,
                      reviewedHeadSha,
                      currentHeadSha: details.headSha,
                      title: details.title,
                      url: details.url,
                    },
                    this.clock().toISOString(),
                  ),
                ]
              : [];
          const state: FollowUpState = {
            reviewId: ours.id,
            reviewedHeadSha,
            notifiedHeadSha: changed ? details.headSha : (previous?.notifiedHeadSha ?? null),
            details,
          };
          summary.emitted += this.store.commit(
            [{ key, kind: 'review-follow-up', value: state }],
            events,
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
      .filter((entity) => samePr(entity.value.mutation.pr))
      .map((entity) => entity.key);
    const nudges = this.store
      .listEntities<NudgeState>('nudge')
      .filter((entity) => samePr(entity.value.details))
      .map((entity) => entity.key);
    return [authoredKey, ...actions, ...nudges];
  }
}
