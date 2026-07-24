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
] as const;

export type ShepherdEventType = (typeof SHEPHERD_EVENT_TYPES)[number];
export type AutomationMode = 'off' | 'notify' | 'execute';
export type MergeMethod = 'squash' | 'merge' | 'rebase';
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
  | { type: 'update-branch'; pr: PullRequestRef }
  | { type: 'post-reviewer-comment'; pr: PullRequestRef; reviewer: string; body: string };

export interface GitHubProvider {
  discover(kind: DiscoveryKind, githubUser: string): Promise<DiscoveryResult<PullRequestSummary>>;
  getPullRequest(pr: PullRequestRef): Promise<PullRequestDetails>;
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
