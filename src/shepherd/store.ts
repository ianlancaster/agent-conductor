import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { applyMigrations, openSqliteDatabase, withTransaction } from '../store/sqlite.js';
import { IdempotencyConflictError } from './types.js';
import type {
  CoordinatorReceipt,
  DiscoveryKind,
  EntityUpdate,
  OutboxItem,
  PullRequestDetails,
  PullRequestRef,
  ShepherdEvent,
  ShepherdEventType,
  StoredEntity,
  TrackedClaimBaseline,
  TrackedControlAuditRecord,
  TrackedControlRequest,
  TrackedControlResult,
  TrackedObservationResult,
  TrackedPullRequest,
  TrackedPullRequestStore,
  TrackedPullRequestStatus,
} from './types.js';

interface EntityRow {
  key: string;
  kind: string;
  value_json: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  type: ShepherdEventType;
  repo: string;
  pr_number: number;
  occurred_at: string;
  source_json: string;
  message: string;
}

interface OutboxRow {
  id: number;
  event_id: string;
  recipient: string;
  idempotency_key: string;
  message: string;
  attempts: number;
  next_attempt_at: string;
}

interface TrackedPullRequestRow {
  repo: string;
  pr_number: number;
  status: TrackedPullRequestStatus;
  generation: number;
  actor: string;
  evidence_json: string;
  claimed_at: string;
  updated_at: string;
  unclaimed_at: string | null;
  terminal_state: 'CLOSED' | 'MERGED' | null;
  baseline_pending: number;
}

interface TrackedControlOperationRow {
  idempotency_key: string;
  operation: TrackedControlAuditRecord['operation'];
  repo: string;
  pr_number: number;
  actor: string;
  evidence_json: string;
  request_hash: string;
  outcome: TrackedControlAuditRecord['outcome'];
  result_json: string;
  created_at: string;
}

const MIGRATIONS = [
  `
  CREATE TABLE shepherd_entities (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_shepherd_entities_kind ON shepherd_entities(kind, key);

  CREATE TABLE shepherd_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    occurred_at TEXT NOT NULL,
    source_json TEXT NOT NULL,
    message TEXT NOT NULL
  );
  CREATE INDEX idx_shepherd_events_time ON shepherd_events(occurred_at, id);

  CREATE TABLE shepherd_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE REFERENCES shepherd_events(id),
    recipient TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    claimed_at TEXT,
    completed_at TEXT,
    receipt_json TEXT,
    last_error TEXT
  );
  CREATE INDEX idx_shepherd_outbox_ready ON shepherd_outbox(status, next_attempt_at, id);

  CREATE TABLE shepherd_workspace (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );

  CREATE TABLE shepherd_health_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE shepherd_tracked_prs (
    repo_key TEXT NOT NULL,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'unclaimed', 'terminal')),
    generation INTEGER NOT NULL CHECK (generation > 0),
    actor TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    unclaimed_at TEXT,
    terminal_state TEXT CHECK (terminal_state IN ('CLOSED', 'MERGED')),
    baseline_pending INTEGER NOT NULL DEFAULT 1 CHECK (baseline_pending IN (0, 1)),
    PRIMARY KEY (repo_key, pr_number)
  );
  CREATE INDEX idx_shepherd_tracked_prs_status
    ON shepherd_tracked_prs(status, repo_key, pr_number);

  CREATE TABLE shepherd_control_operations (
    idempotency_key TEXT PRIMARY KEY,
    operation TEXT NOT NULL CHECK (operation IN ('claim', 'unclaim')),
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    actor TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    outcome TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_shepherd_control_operations_pr
    ON shepherd_control_operations(lower(repo), pr_number, created_at);
  `,
] as const;

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Corrupt Shepherd ${label} JSON.`);
  }
}

function eventFromRow(row: EventRow): ShepherdEvent {
  return {
    id: row.id,
    type: row.type,
    repo: row.repo,
    prNumber: row.pr_number,
    occurredAt: row.occurred_at,
    source: parseJson<Record<string, unknown>>(row.source_json, `event ${row.id}`),
    message: row.message,
  };
}

function outboxFromRow(row: OutboxRow): OutboxItem {
  return {
    id: row.id,
    eventId: row.event_id,
    recipient: row.recipient,
    idempotencyKey: row.idempotency_key,
    message: row.message,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
  };
}

function trackedFromRow(row: TrackedPullRequestRow): TrackedPullRequest {
  return {
    repo: row.repo,
    number: row.pr_number,
    status: row.status,
    generation: row.generation,
    actor: row.actor,
    evidence: parseJson<unknown>(row.evidence_json, `tracked PR ${row.repo}#${String(row.pr_number)}`),
    claimedAt: row.claimed_at,
    updatedAt: row.updated_at,
    unclaimedAt: row.unclaimed_at,
    terminalState: row.terminal_state,
    baselinePending: row.baseline_pending === 1,
  };
}

function repoKey(repo: string): string {
  return repo.toLowerCase();
}

export class SqliteShepherdStore implements TrackedPullRequestStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openSqliteDatabase(dbPath);
    try {
      applyMigrations(this.db, MIGRATIONS);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  getEntity<T>(key: string): StoredEntity<T> | undefined {
    const row = this.db.prepare('SELECT * FROM shepherd_entities WHERE key = ?').get(key) as EntityRow | undefined;
    if (row === undefined) return undefined;
    return {
      key: row.key,
      kind: row.kind,
      value: parseJson<T>(row.value_json, `entity ${key}`),
      updatedAt: row.updated_at,
    };
  }

  listEntities<T>(kind?: string): StoredEntity<T>[] {
    const rows = (kind === undefined
      ? this.db.prepare('SELECT * FROM shepherd_entities ORDER BY key').all()
      : this.db
          .prepare('SELECT * FROM shepherd_entities WHERE kind = ? ORDER BY key')
          .all(kind)) as unknown as EntityRow[];
    return rows.map((row) => ({
      key: row.key,
      kind: row.kind,
      value: parseJson<T>(row.value_json, `entity ${row.key}`),
      updatedAt: row.updated_at,
    }));
  }

  getTrackedPullRequest(pr: PullRequestRef): TrackedPullRequest | undefined {
    const row = this.db
      .prepare('SELECT * FROM shepherd_tracked_prs WHERE repo_key = ? AND pr_number = ?')
      .get(repoKey(pr.repo), pr.number) as TrackedPullRequestRow | undefined;
    return row === undefined ? undefined : trackedFromRow(row);
  }

  listTrackedPullRequests(status?: TrackedPullRequestStatus): TrackedPullRequest[] {
    const rows = (status === undefined
      ? this.db.prepare('SELECT * FROM shepherd_tracked_prs ORDER BY repo_key, pr_number').all()
      : this.db
          .prepare('SELECT * FROM shepherd_tracked_prs WHERE status = ? ORDER BY repo_key, pr_number')
          .all(status)) as unknown as TrackedPullRequestRow[];
    return rows.map(trackedFromRow);
  }

  getTrackedControlResult(request: TrackedControlRequest): TrackedControlResult | undefined {
    return this.controlReplay(request);
  }

  listTrackedControlOperations(limit: number, offset = 0): TrackedControlAuditRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM shepherd_control_operations ORDER BY created_at DESC, idempotency_key DESC LIMIT ? OFFSET ?',
      )
      .all(limit, offset) as unknown as TrackedControlOperationRow[];
    return rows.map((row) => ({
      idempotencyKey: row.idempotency_key,
      operation: row.operation,
      repo: row.repo,
      number: row.pr_number,
      actor: row.actor,
      evidence: parseJson<unknown>(row.evidence_json, `control operation ${row.idempotency_key} evidence`),
      outcome: row.outcome,
      result: parseJson<TrackedControlResult>(row.result_json, `control operation ${row.idempotency_key}`),
      createdAt: row.created_at,
    }));
  }

  countTrackedControlOperations(): number {
    const row = this.db.prepare('SELECT count(*) AS count FROM shepherd_control_operations').get() as {
      count: number;
    };
    return row.count;
  }

  claimTrackedPullRequest(
    request: TrackedControlRequest,
    details: PullRequestDetails,
    baseline: TrackedClaimBaseline,
    event: ShepherdEvent | undefined,
    recipient?: string,
  ): TrackedControlResult {
    return withTransaction(this.db, () => {
      const replay = this.controlReplay(request);
      if (replay !== undefined) return replay;
      const existing = this.trackedRow(request);
      const generation = existing?.generation ?? 0;
      if (details.state !== 'OPEN') {
        const result: TrackedControlResult = {
          operation: 'claim',
          outcome: details.state === 'MERGED' ? 'rejected-merged' : 'rejected-closed',
          repo: request.repo,
          number: request.number,
          generation: generation === 0 ? null : generation,
          idempotentReplay: false,
        };
        this.insertControlOperation(request, result);
        return result;
      }
      if (existing?.status === 'active') {
        const result: TrackedControlResult = {
          operation: 'claim',
          outcome: 'already-claimed',
          repo: existing.repo,
          number: existing.pr_number,
          generation: existing.generation,
          idempotentReplay: false,
        };
        this.insertControlOperation(request, result);
        return result;
      }
      const nextGeneration = generation + 1;
      this.db
        .prepare(
          `INSERT INTO shepherd_tracked_prs
            (repo_key, repo, pr_number, status, generation, actor, evidence_json, claimed_at, updated_at,
             unclaimed_at, terminal_state, baseline_pending)
           VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, NULL, NULL, 0)
           ON CONFLICT(repo_key, pr_number) DO UPDATE SET
             repo = excluded.repo, status = 'active', generation = excluded.generation,
             actor = excluded.actor, evidence_json = excluded.evidence_json, claimed_at = excluded.claimed_at,
             updated_at = excluded.updated_at, unclaimed_at = NULL, terminal_state = NULL, baseline_pending = 0`,
        )
        .run(
          repoKey(request.repo),
          request.repo,
          request.number,
          nextGeneration,
          request.actor,
          JSON.stringify(request.evidence),
          request.occurredAt,
          request.occurredAt,
        );
      const lifecycleKey = `authored:${repoKey(request.repo)}#${String(request.number)}`;
      const existingLifecycle = this.db.prepare('SELECT * FROM shepherd_entities WHERE key = ?').get(lifecycleKey) as
        EntityRow | undefined;
      const existingValue =
        existingLifecycle === undefined
          ? undefined
          : parseJson<Record<string, unknown>>(existingLifecycle.value_json, `entity ${lifecycleKey}`);
      const existingSources = existingValue?.sources;
      const authored =
        existingLifecycle !== undefined &&
        (typeof existingSources !== 'object' ||
          existingSources === null ||
          Array.isArray(existingSources) ||
          (existingSources as Record<string, unknown>).authored !== false);
      this.db
        .prepare(
          `INSERT INTO shepherd_entities (key, kind, value_json, updated_at) VALUES (?, 'authored', ?, ?)
           ON CONFLICT(key) DO UPDATE SET kind = 'authored', value_json = excluded.value_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          lifecycleKey,
          JSON.stringify({ ...baseline, sources: { authored, trackedGeneration: nextGeneration } }),
          request.occurredAt,
        );
      const result: TrackedControlResult = {
        operation: 'claim',
        outcome: existing === undefined ? 'claimed' : 'reclaimed',
        repo: request.repo,
        number: request.number,
        generation: nextGeneration,
        idempotentReplay: false,
      };
      this.insertControlOperation(request, result);
      if (event !== undefined) this.insertEvent(event, recipient, request.occurredAt);
      return result;
    });
  }

  unclaimTrackedPullRequest(
    request: TrackedControlRequest,
    event: ShepherdEvent | undefined,
    recipient?: string,
  ): TrackedControlResult {
    return withTransaction(this.db, () => {
      const replay = this.controlReplay(request);
      if (replay !== undefined) return replay;
      const existing = this.trackedRow(request);
      if (existing?.status !== 'active') {
        const result: TrackedControlResult = {
          operation: 'unclaim',
          outcome: 'already-unclaimed',
          repo: existing?.repo ?? request.repo,
          number: request.number,
          generation: existing?.generation ?? null,
          idempotentReplay: false,
        };
        this.insertControlOperation(request, result);
        return result;
      }
      this.db
        .prepare(
          `UPDATE shepherd_tracked_prs
           SET status = 'unclaimed', actor = ?, evidence_json = ?, updated_at = ?, unclaimed_at = ?,
             terminal_state = NULL, baseline_pending = 0
           WHERE repo_key = ? AND pr_number = ? AND status = 'active'`,
        )
        .run(
          request.actor,
          JSON.stringify(request.evidence),
          request.occurredAt,
          request.occurredAt,
          repoKey(request.repo),
          request.number,
        );
      this.releaseTrackedLifecycle(request, request.occurredAt);
      const result: TrackedControlResult = {
        operation: 'unclaim',
        outcome: 'unclaimed',
        repo: existing.repo,
        number: existing.pr_number,
        generation: existing.generation,
        idempotentReplay: false,
      };
      this.insertControlOperation(request, result);
      if (event !== undefined) this.insertEvent(event, recipient, request.occurredAt);
      return result;
    });
  }

  commit(
    updates: EntityUpdate[],
    events: ShepherdEvent[],
    recipient?: string,
    deleteKeys: string[] = [],
  ): ShepherdEvent[] {
    return withTransaction(this.db, () => this.commitWithin(updates, events, recipient, deleteKeys));
  }

  commitTrackedObservation(
    pr: PullRequestRef,
    generation: number,
    updates: EntityUpdate[],
    events: ShepherdEvent[],
    recipient: string | undefined,
    deleteKeys: string[],
    terminalState: 'CLOSED' | 'MERGED' | undefined,
  ): TrackedObservationResult {
    return withTransaction(this.db, () => {
      const claimed = this.db
        .prepare(
          `UPDATE shepherd_tracked_prs SET updated_at = updated_at
           WHERE repo_key = ? AND pr_number = ? AND status = 'active' AND generation = ?`,
        )
        .run(repoKey(pr.repo), pr.number, generation).changes;
      if (claimed !== 1) {
        return { inserted: [], applied: false };
      }
      const inserted = this.commitWithin(updates, events, recipient, deleteKeys);
      this.db
        .prepare(
          `UPDATE shepherd_tracked_prs
           SET baseline_pending = 0, status = ?, terminal_state = ?, updated_at = ?
           WHERE repo_key = ? AND pr_number = ? AND status = 'active' AND generation = ?`,
        )
        .run(
          terminalState === undefined ? 'active' : 'terminal',
          terminalState ?? null,
          new Date().toISOString(),
          repoKey(pr.repo),
          pr.number,
          generation,
        );
      return { inserted, applied: true };
    });
  }

  commitAuthoredObservationAfterTrackedRelease(
    pr: PullRequestRef,
    observedGeneration: number,
    updates: EntityUpdate[],
    events: ShepherdEvent[],
    recipient: string | undefined,
    deleteKeys: string[],
  ): TrackedObservationResult {
    return withTransaction(this.db, () => {
      // The durable tracked row is retained after release. Taking a write lock on it closes the
      // re-read/commit gap: a concurrent reclaim either wins first or installs its newer baseline
      // after this authored fallback commits.
      this.db
        .prepare(
          `UPDATE shepherd_tracked_prs SET updated_at = updated_at
           WHERE repo_key = ? AND pr_number = ? AND generation >= ?`,
        )
        .run(repoKey(pr.repo), pr.number, observedGeneration);
      const current = this.trackedRow(pr);
      if (current?.status === 'active') return { inserted: [], applied: false };
      return { inserted: this.commitWithin(updates, events, recipient, deleteKeys), applied: true };
    });
  }

  deleteEntities(keys: string[]): void {
    const remove = this.db.prepare('DELETE FROM shepherd_entities WHERE key = ?');
    withTransaction(this.db, () => {
      for (const key of keys) remove.run(key);
    });
  }

  hasCompletedBootstrap(kind: DiscoveryKind): boolean {
    return this.db.prepare('SELECT 1 FROM shepherd_workspace WHERE key = ?').get(`bootstrap:${kind}`) !== undefined;
  }

  markBootstrapComplete(kind: DiscoveryKind): void {
    this.db
      .prepare('INSERT OR REPLACE INTO shepherd_workspace (key, value_json) VALUES (?, ?)')
      .run(`bootstrap:${kind}`, JSON.stringify({ completedAt: new Date().toISOString() }));
  }

  claimOutbox(now: Date, limit = 20): OutboxItem[] {
    return withTransaction(this.db, () => {
      const rows = this.db
        .prepare(
          `SELECT id, event_id, recipient, idempotency_key, message, attempts, next_attempt_at
           FROM shepherd_outbox
           WHERE status = 'pending' AND next_attempt_at <= ?
           ORDER BY id LIMIT ?`,
        )
        .all(now.toISOString(), limit) as unknown as OutboxRow[];
      const claim = this.db.prepare(
        "UPDATE shepherd_outbox SET status = 'sending', claimed_at = ? WHERE id = ? AND status = 'pending'",
      );
      return rows.filter((row) => claim.run(now.toISOString(), row.id).changes === 1).map(outboxFromRow);
    });
  }

  completeOutbox(id: number, receipt?: CoordinatorReceipt): void {
    this.db
      .prepare(
        "UPDATE shepherd_outbox SET status = 'completed', completed_at = ?, receipt_json = ?, last_error = NULL WHERE id = ? AND status = 'sending'",
      )
      .run(new Date().toISOString(), receipt === undefined ? null : JSON.stringify(receipt), id);
  }

  retryOutbox(id: number, nextAttemptAt: Date, error: string): void {
    this.db
      .prepare(
        "UPDATE shepherd_outbox SET status = 'pending', attempts = attempts + 1, next_attempt_at = ?, claimed_at = NULL, last_error = ? WHERE id = ? AND status = 'sending'",
      )
      .run(nextAttemptAt.toISOString(), error, id);
  }

  parkOutbox(id: number, error: string): void {
    this.db
      .prepare(
        "UPDATE shepherd_outbox SET status = 'parked', attempts = attempts + 1, claimed_at = NULL, last_error = ? WHERE id = ? AND status = 'sending'",
      )
      .run(error, id);
    this.logHealth('outbox-parked', `outbox=${String(id)} ${error}`);
  }

  recoverInFlight(): void {
    this.db.prepare("UPDATE shepherd_outbox SET status = 'pending', claimed_at = NULL WHERE status = 'sending'").run();
  }

  listEvents(limit = 100): ShepherdEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM shepherd_events ORDER BY occurred_at DESC, id DESC LIMIT ?')
      .all(limit) as unknown as EventRow[];
    return rows.map(eventFromRow);
  }

  listOutbox(includeCompleted = false): OutboxItem[] {
    const rows = this.db
      .prepare(
        `SELECT id, event_id, recipient, idempotency_key, message, attempts, next_attempt_at
         FROM shepherd_outbox ${includeCompleted ? '' : "WHERE status NOT IN ('completed')"} ORDER BY id`,
      )
      .all() as unknown as OutboxRow[];
    return rows.map(outboxFromRow);
  }

  logHealth(event: string, detail?: string): void {
    this.db
      .prepare('INSERT INTO shepherd_health_log (event, detail, created_at) VALUES (?, ?, ?)')
      .run(event, detail ?? null, new Date().toISOString());
  }

  private trackedRow(pr: PullRequestRef): TrackedPullRequestRow | undefined {
    return this.db
      .prepare('SELECT * FROM shepherd_tracked_prs WHERE repo_key = ? AND pr_number = ?')
      .get(repoKey(pr.repo), pr.number) as TrackedPullRequestRow | undefined;
  }

  private releaseTrackedLifecycle(pr: PullRequestRef, occurredAt: string): void {
    const key = `authored:${repoKey(pr.repo)}#${String(pr.number)}`;
    const entity = this.db.prepare('SELECT * FROM shepherd_entities WHERE key = ?').get(key) as EntityRow | undefined;
    if (entity === undefined) return;
    const value = parseJson<Record<string, unknown>>(entity.value_json, `entity ${key}`);
    const sources = value.sources;
    if (
      typeof sources !== 'object' ||
      sources === null ||
      Array.isArray(sources) ||
      (sources as Record<string, unknown>).authored !== false
    ) {
      if (typeof sources === 'object' && sources !== null && !Array.isArray(sources)) {
        value.sources = { ...(sources as Record<string, unknown>), authored: true };
        delete (value.sources as Record<string, unknown>).trackedGeneration;
        this.db
          .prepare('UPDATE shepherd_entities SET value_json = ?, updated_at = ? WHERE key = ?')
          .run(JSON.stringify(value), occurredAt, key);
      }
      return;
    }
    const samePr = (candidate: unknown): boolean => {
      if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return false;
      const record = candidate as Record<string, unknown>;
      return (
        record.number === pr.number && typeof record.repo === 'string' && repoKey(record.repo) === repoKey(pr.repo)
      );
    };
    const deleteKeys = [key];
    for (const candidate of this.listEntities<Record<string, unknown>>()) {
      if (candidate.kind === 'action') {
        const mutation = candidate.value.mutation;
        if (typeof mutation === 'object' && mutation !== null && samePr((mutation as Record<string, unknown>).pr)) {
          deleteKeys.push(candidate.key);
        }
      } else if (candidate.kind === 'nudge' && samePr(candidate.value.details)) {
        deleteKeys.push(candidate.key);
      }
    }
    const remove = this.db.prepare('DELETE FROM shepherd_entities WHERE key = ?');
    for (const deleteKey of deleteKeys) remove.run(deleteKey);
  }

  private controlReplay(request: TrackedControlRequest): TrackedControlResult | undefined {
    const row = this.db
      .prepare('SELECT * FROM shepherd_control_operations WHERE idempotency_key = ?')
      .get(request.idempotencyKey) as TrackedControlOperationRow | undefined;
    if (row === undefined) return undefined;
    if (row.request_hash !== request.requestHash) {
      const equivalentLegacyRequest =
        row.operation === request.operation &&
        repoKey(row.repo) === repoKey(request.repo) &&
        row.pr_number === request.number &&
        row.actor === request.actor &&
        isDeepStrictEqual(
          parseJson<unknown>(row.evidence_json, `control operation ${request.idempotencyKey} evidence`),
          request.evidence,
        );
      if (!equivalentLegacyRequest) {
        throw new IdempotencyConflictError(
          `Idempotency key ${request.idempotencyKey} was already used for a different control request.`,
        );
      }
      this.db
        .prepare(
          `UPDATE shepherd_control_operations SET request_hash = ?
           WHERE idempotency_key = ? AND request_hash = ?`,
        )
        .run(request.requestHash, request.idempotencyKey, row.request_hash);
    }
    return {
      ...parseJson<TrackedControlResult>(row.result_json, `control operation ${request.idempotencyKey}`),
      idempotentReplay: true,
    };
  }

  private insertControlOperation(request: TrackedControlRequest, result: TrackedControlResult): void {
    this.db
      .prepare(
        `INSERT INTO shepherd_control_operations
          (idempotency_key, operation, repo, pr_number, actor, evidence_json, request_hash, outcome,
           result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.idempotencyKey,
        request.operation,
        request.repo,
        request.number,
        request.actor,
        JSON.stringify(request.evidence),
        request.requestHash,
        result.outcome,
        JSON.stringify(result),
        request.occurredAt,
      );
  }

  private commitWithin(
    updates: EntityUpdate[],
    events: ShepherdEvent[],
    recipient: string | undefined,
    deleteKeys: string[],
  ): ShepherdEvent[] {
    const inserted: ShepherdEvent[] = [];
    const committedAt = new Date().toISOString();
    for (const update of updates) {
      this.db
        .prepare(
          `INSERT INTO shepherd_entities (key, kind, value_json, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, value_json = excluded.value_json,
             updated_at = excluded.updated_at`,
        )
        .run(update.key, update.kind, JSON.stringify(update.value), committedAt);
    }
    for (const event of events) {
      if (!this.insertEvent(event, recipient, committedAt)) continue;
      inserted.push(event);
    }
    const remove = this.db.prepare('DELETE FROM shepherd_entities WHERE key = ?');
    for (const key of deleteKeys) remove.run(key);
    return inserted;
  }

  private insertEvent(event: ShepherdEvent, recipient: string | undefined, readyAt: string): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO shepherd_events
          (id, type, repo, pr_number, occurred_at, source_json, message)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.type,
        event.repo,
        event.prNumber,
        event.occurredAt,
        JSON.stringify(event.source),
        event.message,
      );
    if (result.changes !== 1) return false;
    if (recipient !== undefined) {
      this.db
        .prepare(
          `INSERT INTO shepherd_outbox
            (event_id, recipient, idempotency_key, message, next_attempt_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(event.id, recipient, `shepherd:${event.id}:${recipient}`, event.message, readyAt);
    }
    return true;
  }

  close(): void {
    this.db.close();
  }
}
