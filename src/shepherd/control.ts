import { createHash } from 'node:crypto';
import type { ShepherdConfig } from './config.js';
import { buildEvent } from './events.js';
import { repositoryInScope } from './scope.js';
import type {
  GitHubProvider,
  PullRequestDetails,
  PullRequestRef,
  ShepherdStore,
  TrackedControlOperationType,
  TrackedControlRequest,
  TrackedControlResult,
  TrackedPullRequest,
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
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function validatedInput(
  operation: TrackedControlOperationType,
  input: TrackedControlInput,
  now: Date,
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
  const identity = { operation, repo: repo.toLowerCase(), number: input.number, actor, evidence: input.evidence };
  return {
    operation,
    repo,
    number: input.number,
    actor,
    evidence: input.evidence,
    idempotencyKey,
    requestHash: createHash('sha256').update(canonical(identity)).digest('hex'),
    occurredAt: now.toISOString(),
  };
}

export class TrackedPullRequestControl {
  constructor(
    private readonly config: ShepherdConfig,
    private readonly github: GitHubProvider,
    private readonly store: ShepherdStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async claim(input: TrackedControlInput): Promise<TrackedControlResult> {
    this.assertEnabled();
    const request = validatedInput('claim', input, this.clock());
    const replay = this.store.getTrackedControlResult(request);
    if (replay !== undefined) return replay;
    if (!repositoryInScope(request.repo, this.config.github)) {
      throw new Error(`Repository ${request.repo} is outside the configured GitHub scope.`);
    }
    let details: PullRequestDetails;
    try {
      details = await this.github.getPullRequest(request);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.store.logHealth(
        'tracked-pr-claim-verification-failed',
        `${request.repo}#${String(request.number)}: ${detail.slice(0, 500)}`,
      );
      throw new Error(`Unable to verify ${request.repo}#${String(request.number)}; no claim was recorded: ${detail}`, {
        cause: error,
      });
    }
    if (details.number !== request.number || details.repo.toLowerCase() !== request.repo.toLowerCase()) {
      throw new Error(
        `GitHub returned a different pull request while verifying ${request.repo}#${String(request.number)}.`,
      );
    }
    const event = buildEvent(
      this.config,
      'tracked-pr-claimed',
      request,
      { idempotencyKey: request.idempotencyKey },
      { actor: request.actor, evidence: request.evidence, title: details.title, url: details.url },
      request.occurredAt,
    );
    return this.store.claimTrackedPullRequest(request, details.state, event, this.recipient());
  }

  unclaim(input: TrackedControlInput): TrackedControlResult {
    this.assertEnabled();
    const request = validatedInput('unclaim', input, this.clock());
    const replay = this.store.getTrackedControlResult(request);
    if (replay !== undefined) return replay;
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
}
