export const SHEPHERD_EVENT_TYPES = [
  'ci-failed',
  'review-feedback',
  'bot-findings',
  'comment',
  'approved',
  'conflict',
  'merged',
  'stale',
  'review-dispatch',
  'review-completed',
  'scoped-re-review',
  'reviewer-escalation',
  'auto-merge-decision',
  'branch-update-decision',
  'branch-behind',
  'branch-update-failed',
  'reviewer-comment-decision',
  'tracked-pr-claimed',
  'tracked-pr-unclaimed',
  'head-changed',
  'release-attested',
  'release-revoked',
  'release-gate-blocked',
] as const;

export type ShepherdEventType = (typeof SHEPHERD_EVENT_TYPES)[number];
export type AutomationMode = 'off' | 'notify' | 'execute';
export type MergeMethod = 'squash' | 'merge' | 'rebase';
export type ReleaseGate = 'none' | 'exact-head-attestation';
export type DiscoveryKind = 'authored' | 'review-inbox' | 'review-follow-up' | 'reviewer-nudge';

export interface PullRequestRef {
  repo: string;
  number: number;
}

export interface PullRequestSummary extends PullRequestRef {
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
}

export interface CheckRun {
  id: string;
  name: string;
  state: string;
  bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';
  workflow: string;
}

export interface Review {
  id: string;
  author: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  body: string;
  submittedAt: string;
  /** Head commit GitHub associated with this review, when the provider exposes it. */
  commitSha?: string;
}

export interface Comment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface Commit {
  sha: string;
  committedAt: string;
  message: string;
}

export type ReviewThreadSide = 'LEFT' | 'RIGHT';

export interface ReviewThreadComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface ReviewThread {
  id: string;
  rootCommentId: string;
  reviewId: string;
  rootAuthor: string;
  path: string;
  originalLine: number | null;
  originalSide: ReviewThreadSide | null;
  currentLine: number | null;
  currentSide: ReviewThreadSide | null;
  url: string;
  isOutdated: boolean;
  isResolved: boolean;
  comments: ReviewThreadComment[];
}

export interface RequestedReviewer {
  login: string;
}

export interface PullRequestDetails extends PullRequestSummary {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  headSha: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string;
  autoMergeRequest: { mergeMethod: string } | null;
  mergedAt: string | null;
  closedAt: string | null;
  checks: CheckRun[];
  reviews: Review[];
  reviewThreads: ReviewThread[];
  requestedReviewers: RequestedReviewer[];
  comments: Comment[];
  commits: Commit[];
}

export interface DiscoveryResult<T> {
  items: T[];
  exhaustive: boolean;
  warning?: string;
}

export type GitHubMutation =
  | { type: 'enable-auto-merge'; pr: PullRequestRef; mergeMethod: MergeMethod }
  | { type: 'merge-exact-head'; pr: PullRequestRef; headSha: string; mergeMethod: MergeMethod }
  | { type: 'enqueue-exact-head'; pr: PullRequestRef; headSha: string }
  | { type: 'dequeue'; pr: PullRequestRef }
  | { type: 'disable-auto-merge'; pr: PullRequestRef }
  | { type: 'update-branch'; pr: PullRequestRef }
  | { type: 'post-reviewer-comment'; pr: PullRequestRef; reviewer: string; body: string };

export interface GitHubProvider {
  discover(kind: DiscoveryKind, githubUser: string): Promise<DiscoveryResult<PullRequestSummary>>;
  getPullRequest(pr: PullRequestRef): Promise<PullRequestDetails>;
  getMergeAutomationState?(pr: PullRequestRef): Promise<{
    headSha: string;
    autoMergeEnabled: boolean;
    queued: boolean;
  }>;
  mutate(mutation: GitHubMutation): Promise<void>;
}

export interface ShepherdEvent {
  id: string;
  type: ShepherdEventType;
  repo: string;
  prNumber: number;
  occurredAt: string;
  source: Record<string, unknown>;
  message: string;
}

export interface OutboxItem {
  id: number;
  eventId: string;
  recipient: string;
  idempotencyKey: string;
  message: string;
  attempts: number;
  nextAttemptAt: string;
}

export interface CoordinatorReceipt {
  messageId: number;
  recipient: string;
  status: 'delivered' | 'queued';
  deduplicated: boolean;
}

export class PermanentDeliveryError extends Error {}
export class IdempotencyConflictError extends Error {}

export interface CoordinatorSink {
  send(item: OutboxItem): Promise<CoordinatorReceipt | undefined>;
}

export interface StoredEntity<T = unknown> {
  key: string;
  kind: string;
  value: T;
  updatedAt: string;
}

export interface EntityUpdate {
  key: string;
  kind: string;
  value: unknown;
}

export type TrackedPullRequestStatus = 'active' | 'unclaimed' | 'terminal';

export interface TrackedPullRequest extends PullRequestRef {
  status: TrackedPullRequestStatus;
  generation: number;
  actor: string;
  evidence: unknown;
  claimedAt: string;
  updatedAt: string;
  unclaimedAt: string | null;
  terminalState: 'CLOSED' | 'MERGED' | null;
  baselinePending: boolean;
  releaseGate: ReleaseGate;
}

export type TrackedControlOperationType = 'claim' | 'unclaim';
export type TrackedControlOutcome =
  | 'claimed'
  | 'reclaimed'
  | 'already-claimed'
  | 'unclaimed'
  | 'already-unclaimed'
  | 'rejected-closed'
  | 'rejected-merged';

export interface TrackedControlResult extends PullRequestRef {
  operation: TrackedControlOperationType;
  outcome: TrackedControlOutcome;
  generation: number | null;
  idempotentReplay: boolean;
}

export interface TrackedControlRequest extends PullRequestRef {
  operation: TrackedControlOperationType;
  actor: string;
  evidence: unknown;
  idempotencyKey: string;
  requestHash: string;
  occurredAt: string;
  releaseGate?: ReleaseGate;
}

export interface ReleaseAttestation extends PullRequestRef {
  idempotencyKey: string;
  generation: number;
  headSha: string;
  status: 'active' | 'revoked';
  actor: string;
  evidence: unknown;
  attestedAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
}

export type ReleaseGateStatus = 'applicable' | 'missing' | 'stale' | 'revoked';

export interface ReleaseControlResult extends PullRequestRef {
  operation: 'attest' | 'revoke';
  outcome: 'attested' | 'already-attested' | 'revoked' | 'already-revoked';
  generation: number;
  headSha: string | null;
  idempotentReplay: boolean;
  compensation: 'none' | 'completed' | 'pending';
  compensationActionKeys: string[];
}

export interface ReleaseControlRequest extends PullRequestRef {
  operation: 'attest' | 'revoke';
  actor: string;
  evidence: unknown;
  reason?: string;
  headSha?: string;
  idempotencyKey: string;
  requestHash: string;
  occurredAt: string;
}

export interface ReleaseControlAuditRecord extends PullRequestRef {
  idempotencyKey: string;
  operation: ReleaseControlRequest['operation'];
  actor: string;
  evidence: unknown;
  reason: string | null;
  headSha: string | null;
  result: ReleaseControlResult;
  createdAt: string;
}

export interface TrackedControlAuditRecord extends PullRequestRef {
  idempotencyKey: string;
  operation: TrackedControlOperationType;
  actor: string;
  evidence: unknown;
  outcome: TrackedControlOutcome;
  result: TrackedControlResult;
  createdAt: string;
}

export interface TrackedClaimBaseline {
  details: PullRequestDetails;
  lastObservedAt: string;
  botAttempts: Record<string, number>;
  staleCycle: number;
  conflictCycle: number;
}

export interface TrackedObservationResult {
  inserted: ShepherdEvent[];
  applied: boolean;
}

export interface ShepherdStore {
  getEntity<T>(key: string): StoredEntity<T> | undefined;
  listEntities<T>(kind?: string): StoredEntity<T>[];
  commit(updates: EntityUpdate[], events: ShepherdEvent[], recipient?: string, deleteKeys?: string[]): ShepherdEvent[];
  deleteEntities(keys: string[]): void;
  hasCompletedBootstrap(kind: DiscoveryKind): boolean;
  markBootstrapComplete(kind: DiscoveryKind): void;
  claimOutbox(now: Date, limit?: number): OutboxItem[];
  completeOutbox(id: number, receipt?: CoordinatorReceipt): void;
  retryOutbox(id: number, nextAttemptAt: Date, error: string): void;
  parkOutbox(id: number, error: string): void;
  recoverInFlight(): void;
  listEvents(limit?: number): ShepherdEvent[];
  listOutbox(includeCompleted?: boolean): OutboxItem[];
  logHealth(event: string, detail?: string): void;
  close(): void;
}

export interface TrackedPullRequestStore extends ShepherdStore {
  getTrackedPullRequest(pr: PullRequestRef): TrackedPullRequest | undefined;
  listTrackedPullRequests(status?: TrackedPullRequestStatus): TrackedPullRequest[];
  getTrackedControlResult(request: TrackedControlRequest): TrackedControlResult | undefined;
  listTrackedControlOperations(limit: number, offset?: number): TrackedControlAuditRecord[];
  countTrackedControlOperations(): number;
  claimTrackedPullRequest(
    request: TrackedControlRequest,
    details: PullRequestDetails,
    baseline: TrackedClaimBaseline,
    event: ShepherdEvent | undefined,
    recipient?: string,
  ): TrackedControlResult;
  unclaimTrackedPullRequest(
    request: TrackedControlRequest,
    event: ShepherdEvent | undefined,
    recipient?: string,
  ): TrackedControlResult;
  commitTrackedObservation(
    pr: PullRequestRef,
    generation: number,
    updates: EntityUpdate[],
    events: ShepherdEvent[],
    recipient: string | undefined,
    deleteKeys: string[],
    terminalState: 'CLOSED' | 'MERGED' | undefined,
  ): TrackedObservationResult;
  commitAuthoredObservationAfterTrackedRelease(
    pr: PullRequestRef,
    observedGeneration: number,
    updates: EntityUpdate[],
    events: ShepherdEvent[],
    recipient: string | undefined,
    deleteKeys: string[],
  ): TrackedObservationResult;
}

export interface MutationMutexStore {
  tryAcquireMutationLock(owner: string, now: string, expiresAt: string): boolean;
  getMutationLock(): { owner: string; expiresAt: string } | undefined;
  renewMutationLock(owner: string, expiresAt: string): boolean;
  tryTakeoverMutationLock(owner: string, previousOwner: string, now: string, expiresAt: string): boolean;
  releaseMutationLock(owner: string): void;
}

export interface ReleaseGateStore extends TrackedPullRequestStore, MutationMutexStore {
  getReleaseGateStatus(pr: PullRequestRef, generation: number, headSha: string): ReleaseGateStatus;
  getReleaseAttestation(pr: PullRequestRef, generation: number, headSha: string): ReleaseAttestation | undefined;
  listReleaseControlOperations(limit: number, offset?: number): ReleaseControlAuditRecord[];
  countReleaseControlOperations(): number;
  canUnclaimReleaseGate(pr: PullRequestRef, generation: number): boolean;
  attestRelease(
    request: ReleaseControlRequest,
    generation: number,
    event: ShepherdEvent,
    recipient?: string,
  ): ReleaseControlResult;
  revokeRelease(
    request: ReleaseControlRequest,
    generation: number,
    event: ShepherdEvent | undefined,
    recipient?: string,
  ): ReleaseControlResult;
  getReleaseControlResult(request: ReleaseControlRequest): ReleaseControlResult | undefined;
  completeReleaseCompensation(
    idempotencyKey: string,
    actionKey: string,
    completedAt: string,
  ): ReleaseControlResult | undefined;
  prepareActionCancellation(actionKey: string, occurredAt: string): boolean;
  ensureActionSafetyCompensation(actionKey: string, occurredAt: string): string | undefined;
}
