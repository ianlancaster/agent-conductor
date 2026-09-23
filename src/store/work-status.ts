import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { InvalidRequestError } from '../core/errors.js';
import { messageEnvelope } from '../core/utils.js';
import { withTransaction } from './sqlite.js';
import { currentWork, projectClaim, projectResolution, type WorkStatusCurrent } from './work-status-projection.js';

export type WorkClaimState = 'working' | 'waiting' | 'blocked' | 'done' | 'failed';

export interface WorkStatusReport {
  work_id: string;
  state: WorkClaimState;
  summary: string;
  attempt_id?: string;
  idempotencyKey?: string;
  mapping_version?: string;
  waiting_on?: string;
  needs_from?: string;
  question?: string;
  recommendation?: string;
  meanwhile?: string;
  if_no_answer?: string;
  options?: string[];
  evidence?: string[];
  artifact_revision?: string;
  reason?: string;
  resolution?: string;
}

export interface WorkStatusEvent {
  id: number;
  fleet_id: string;
  session: string;
  work_id: string;
  attempt_id: string;
  mapping_version: string;
  kind:
    'claim' | 'unchanged_report' | 'blocker_resolved' | 'accepted' | 'not_accepted' | 'work_closed' | 'attempt_rebound';
  state: WorkClaimState | null;
  payload_json: string;
  idempotency_key: string | null;
  blocker_id: string | null;
  blocker_revision: number | null;
  target_event_id: number | null;
  occurred_at_ms: number;
  duplicate_count: number;
  execution_id: string | null;
}

export interface WorkStatusReceipt {
  eventId: string;
  sequence: number;
  occurredAt: string;
  workId: string;
  attemptId: string;
  state: WorkClaimState;
  blockerId?: string;
  blockerRevision?: number;
  unchanged: boolean;
}

export interface WorkBlockerResolution {
  eventId: string;
  sequence: number;
  workId: string;
  attemptId: string;
  session: string;
  blockerId: string;
  blockerRevision: number;
  question: string;
  answer: string;
  targetClaimEventId: string;
  messageId: number;
}

export interface WorkStatusExactTarget {
  attemptId: string;
  claimEventId: string;
  artifactRevision?: string;
}

export interface WorkStatusAuthorityReceipt {
  eventId: string;
  sequence: number;
  workId: string;
  fleetId: string;
  attemptId: string;
  session: string;
  targetClaimEventId: string;
  claimRevision: number;
  artifactRevision?: string;
  evidence?: string[];
  claimEvidence?: string[];
  reason?: string;
  actor: string;
  attestation: 'attested' | 'authority';
  messageId?: number;
}

export interface WorkStatusReadPage {
  events: (WorkStatusEvent & { eventId: string })[];
  highWater: number;
}

const CLAIM_FIELDS = [
  'work_id',
  'state',
  'summary',
  'waiting_on',
  'needs_from',
  'question',
  'recommendation',
  'meanwhile',
  'if_no_answer',
  'options',
  'evidence',
  'artifact_revision',
  'reason',
  'resolution',
] as const;

function claimPayload(report: WorkStatusReport): Record<string, unknown> {
  return Object.fromEntries(CLAIM_FIELDS.flatMap((key) => (report[key] === undefined ? [] : [[key, report[key]]])));
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function required(value: unknown, name: string, max = 240): string {
  if (typeof value !== 'string' || value.trim().length === 0 || [...value].length > max) {
    throw new InvalidRequestError(`${name} must contain 1–${String(max)} characters.`);
  }
  return value.trim();
}

function validate(report: WorkStatusReport): void {
  required(report.work_id, 'work_id', 160);
  required(report.summary, 'summary', 240);
  if (!['working', 'waiting', 'blocked', 'done', 'failed'].includes(report.state)) {
    throw new InvalidRequestError('state must be working, waiting, blocked, done, or failed.');
  }
  if (report.attempt_id !== undefined) required(report.attempt_id, 'attempt_id', 160);
  if (report.idempotencyKey !== undefined) required(report.idempotencyKey, 'idempotencyKey', 160);
  if (report.mapping_version !== undefined && report.mapping_version !== '1') {
    throw new InvalidRequestError('Unsupported mapping_version.');
  }
  const allowed = new Set<string>(['work_id', 'state', 'summary', 'attempt_id', 'idempotencyKey', 'mapping_version']);
  const conditional: Record<WorkClaimState, readonly string[]> = {
    working: ['resolution'],
    waiting: ['waiting_on', 'resolution'],
    blocked: ['needs_from', 'question', 'recommendation', 'meanwhile', 'if_no_answer', 'options'],
    done: ['evidence', 'artifact_revision', 'resolution'],
    failed: ['reason', 'resolution'],
  };
  for (const key of conditional[report.state]) allowed.add(key);
  for (const [key, value] of Object.entries(report)) {
    if (value !== undefined && !allowed.has(key))
      throw new InvalidRequestError(`${key} is invalid for ${report.state}.`);
  }
  if (report.state === 'waiting') required(report.waiting_on, 'waiting_on');
  if (report.state === 'blocked') {
    for (const key of ['needs_from', 'question', 'recommendation', 'meanwhile', 'if_no_answer'] as const) {
      required(report[key], key);
    }
    if (report.options !== undefined) {
      if (!Array.isArray(report.options) || report.options.length < 1 || report.options.length > 8) {
        throw new InvalidRequestError('options must contain 1–8 choices.');
      }
      for (const option of report.options) required(option, 'option', 80);
    }
  }
  if (report.state === 'done') {
    if (!Array.isArray(report.evidence) || report.evidence.length < 1 || report.evidence.length > 8) {
      throw new InvalidRequestError('done requires 1–8 evidence references.');
    }
    for (const item of report.evidence) required(item, 'evidence item', 320);
    if (report.artifact_revision !== undefined) required(report.artifact_revision, 'artifact_revision', 320);
  }
  if (report.state === 'failed') required(report.reason, 'reason');
  if (report.resolution !== undefined) required(report.resolution, 'resolution');
}

function payload(event: WorkStatusEvent): WorkStatusReport {
  return JSON.parse(event.payload_json) as WorkStatusReport;
}

/** Durable, transactional status claims. The operator and session adapters share this policy. */
export class WorkStatusJournal {
  constructor(private readonly db: DatabaseSync) {}

  events(fleetId: string, session?: string): WorkStatusEvent[] {
    return (session === undefined
      ? this.db.prepare('SELECT * FROM work_status_events WHERE fleet_id = ? ORDER BY id').all(fleetId)
      : this.db
          .prepare('SELECT * FROM work_status_events WHERE fleet_id = ? AND session = ? ORDER BY id')
          .all(fleetId, session)) as unknown as WorkStatusEvent[];
  }

  current(fleetId: string, session?: string): WorkStatusCurrent[] {
    return (session === undefined
      ? this.db.prepare('SELECT * FROM work_status_current WHERE fleet_id = ? ORDER BY work_id, session').all(fleetId)
      : this.db
          .prepare('SELECT * FROM work_status_current WHERE fleet_id = ? AND session = ? ORDER BY work_id')
          .all(fleetId, session)) as unknown as WorkStatusCurrent[];
  }

  /** Bounded internal catch-up read. Sequence is global; scope and high-water are fixed for this page. */
  readAfter(fleetId: string, afterSequence: number, limit: number, session?: string): WorkStatusReadPage {
    if (
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    ) {
      throw new InvalidRequestError('afterSequence must be nonnegative and limit must be 1–500.');
    }
    const scope = session === undefined ? 'fleet_id = ?' : 'fleet_id = ? AND session = ?';
    const values = session === undefined ? [fleetId] : [fleetId, session];
    const latest = this.db
      .prepare(`SELECT max(id) AS high_water FROM work_status_events WHERE ${scope}`)
      .get(...values) as { high_water: number | null };
    const highWater = latest.high_water ?? 0;
    const rows = this.db
      .prepare(`SELECT * FROM work_status_events WHERE ${scope} AND id > ? AND id <= ? ORDER BY id LIMIT ?`)
      .all(...values, afterSequence, highWater, limit) as unknown as WorkStatusEvent[];
    return {
      events: rows.map((event) => ({ ...event, eventId: `${event.fleet_id}:work-status:${String(event.id)}` })),
      highWater,
    };
  }

  currentDone(fleetId: string, workId: string, attemptId?: string): { event: WorkStatusEvent; row: WorkStatusCurrent } {
    const row = this.uniqueCurrent(
      fleetId,
      workId,
      attemptId,
      "state = 'done' AND disposition = 'open'",
      'No open done claim for this work ID.',
    );
    return { row, event: this.eventById(row.claim_event_id) };
  }

  currentUnresolved(
    fleetId: string,
    workId: string,
    attemptId?: string,
  ): { event: WorkStatusEvent; row: WorkStatusCurrent } {
    const row = this.uniqueCurrent(
      fleetId,
      workId,
      attemptId,
      "disposition NOT IN ('accepted', 'closed')",
      'No unresolved work for this work ID.',
    );
    return { row, event: this.eventById(row.claim_event_id) };
  }

  report(
    fleetId: string,
    session: string,
    report: WorkStatusReport,
    snapshotVersion = '1',
    now = Date.now(),
    knownSessions?: ReadonlySet<string>,
    executionId?: string,
  ): WorkStatusReceipt {
    validate(report);
    if (executionId !== undefined) required(executionId, 'execution_id', 160);
    const version = report.mapping_version ?? snapshotVersion;
    if (version !== '1') throw new InvalidRequestError('Unsupported status mapping version.');
    const normalized = claimPayload(report);
    const normalizedJson = JSON.stringify(normalized);
    return withTransaction(this.db, () => {
      if (report.idempotencyKey !== undefined) {
        const keyed = this.db
          .prepare('SELECT * FROM work_status_idempotency WHERE fleet_id = ? AND session = ? AND idempotency_key = ?')
          .get(fleetId, session, report.idempotencyKey) as { payload_json: string; claim_event_id: number } | undefined;
        if (keyed !== undefined) {
          if (keyed.payload_json !== normalizedJson)
            throw new InvalidRequestError('idempotencyKey was reused with different report content.');
          const original = this.eventById(keyed.claim_event_id);
          this.countDuplicate(original.id);
          return this.receipt(original, true);
        }
      }
      if (
        report.state === 'blocked' &&
        report.needs_from !== 'operator' &&
        !knownSessions?.has(report.needs_from ?? '')
      ) {
        throw new InvalidRequestError('needs_from must be operator or a known session codename.');
      }
      const currentRow = currentWork(this.db, fleetId, session, report.work_id);
      const current = currentRow === undefined ? undefined : this.eventById(currentRow.claim_event_id);
      const currentReport = current === undefined ? undefined : payload(current);
      const currentAttempt = current?.attempt_id;
      const terminal = currentReport?.state === 'done' || currentReport?.state === 'failed';
      if (currentRow?.disposition === 'accepted' || currentRow?.disposition === 'closed') {
        throw new InvalidRequestError('Work is closed; new reports require a new work ID.');
      }
      if (
        currentReport?.state === 'failed' &&
        current !== undefined &&
        (report.attempt_id === undefined || report.attempt_id === currentAttempt) &&
        same(claimPayload(currentReport), normalized)
      ) {
        this.countDuplicate(current.id);
        this.bindKey(fleetId, session, report.idempotencyKey, normalizedJson, current.id);
        return this.receipt(current, true);
      }
      const newAttempt =
        current === undefined ||
        ((currentReport?.state === 'failed' || currentRow?.disposition === 'not_accepted') &&
          report.state === 'working' &&
          (report.attempt_id === undefined || report.attempt_id !== currentAttempt));
      if (!newAttempt && report.attempt_id !== undefined && report.attempt_id !== currentAttempt) {
        throw new InvalidRequestError('Report targets a closed, superseded, or different attempt.');
      }
      if (newAttempt && report.state !== 'working') {
        throw new InvalidRequestError('A new work attempt must start with working.');
      }
      if (currentRow?.disposition === 'not_accepted' && !newAttempt) {
        throw new InvalidRequestError('The done claim was not accepted; start a new working attempt.');
      }
      if (terminal && !newAttempt && !(currentReport?.state === 'done' && report.state === 'done')) {
        throw new InvalidRequestError('This attempt is closed to new state reports.');
      }
      if (report.state === 'working') {
        const conflict = this.db
          .prepare(
            `SELECT work_id, attempt_id FROM work_status_current
          WHERE fleet_id = ? AND session = ? AND state = 'working' AND work_id <> ? LIMIT 1`,
          )
          .get(fleetId, session, report.work_id) as { work_id: string; attempt_id: string } | undefined;
        if (conflict !== undefined) {
          throw new InvalidRequestError(
            `Move ${conflict.work_id} (attempt ${conflict.attempt_id}) from working before starting ${report.work_id}.`,
          );
        }
      }
      const attemptId = newAttempt ? (report.attempt_id ?? randomUUID()) : currentAttempt;
      if (attemptId === undefined) throw new Error('Attempt binding is missing.');
      if (
        newAttempt &&
        this.db
          .prepare('SELECT id FROM work_status_events WHERE fleet_id = ? AND attempt_id = ? LIMIT 1')
          .get(fleetId, attemptId) !== undefined
      ) {
        throw new InvalidRequestError('attempt_id is already bound to an attempt.');
      }
      if (current !== undefined && !newAttempt && currentReport?.state === report.state) {
        if (same(claimPayload(currentReport), normalized)) {
          this.countDuplicate(current.id);
          this.bindKey(fleetId, session, report.idempotencyKey, normalizedJson, current.id);
          return this.receipt(current, true);
        }
        if (
          report.state === 'blocked' &&
          report.question === currentReport.question &&
          report.needs_from !== currentReport.needs_from
        ) {
          throw new InvalidRequestError('Changing the blocker authority requires a new question.');
        }
        const allowed =
          (report.state === 'waiting' && currentReport.waiting_on !== report.waiting_on) ||
          (report.state === 'blocked' &&
            (report.question !== currentReport.question ||
              report.recommendation !== currentReport.recommendation ||
              report.meanwhile !== currentReport.meanwhile ||
              report.if_no_answer !== currentReport.if_no_answer ||
              !same(report.options, currentReport.options))) ||
          (report.state === 'done' &&
            (!same(currentReport.evidence, report.evidence) ||
              currentReport.artifact_revision !== report.artifact_revision));
        if (!allowed) throw new InvalidRequestError('Same-state reports require a changed structured field.');
      }
      if (
        executionId !== undefined &&
        !newAttempt &&
        !(currentReport?.state === 'done' && report.state === 'done') &&
        (currentRow?.execution_id === null || currentRow?.execution_id !== executionId)
      ) {
        throw new InvalidRequestError('Attempt belongs to an unknown or previous execution; request a trusted rebind.');
      }
      if (currentReport?.state === 'blocked' && current !== undefined) {
        const resolved = currentRow?.resolved_at_ms !== null;
        const newQuestion = report.state === 'blocked' && report.question !== currentReport.question;
        if ((report.state !== 'blocked' || newQuestion) && !resolved) {
          if (!newQuestion) required(report.resolution, 'resolution');
          const resolution = this.insert({
            fleetId,
            session,
            workId: report.work_id,
            attemptId,
            version,
            kind: 'blocker_resolved',
            state: null,
            json: JSON.stringify({ answer: report.resolution ?? 'superseded by a new question', by: session }),
            now,
            blockerId: current.blocker_id ?? undefined,
            blockerRevision: current.blocker_revision ?? undefined,
            target: current.id,
          });
          projectResolution(this.db, resolution);
        }
      }
      const blockerId =
        report.state !== 'blocked'
          ? undefined
          : currentReport?.state === 'blocked' && !newAttempt
            ? (current?.blocker_id ?? randomUUID())
            : randomUUID();
      const blockerRevision =
        report.state !== 'blocked'
          ? undefined
          : currentReport?.state === 'blocked' && !newAttempt
            ? (current?.blocker_revision ?? 1) + (report.question !== currentReport.question ? 1 : 0)
            : 1;
      const inserted = this.insert({
        fleetId,
        session,
        workId: report.work_id,
        attemptId,
        version,
        kind: 'claim',
        state: report.state,
        json: normalizedJson,
        now,
        blockerId,
        blockerRevision,
        idempotencyKey: report.idempotencyKey,
        executionId,
      });
      projectClaim(this.db, inserted);
      if (newAttempt) {
        this.db
          .prepare(
            `UPDATE work_status_current SET disposition = 'open', disposition_event_id = NULL,
          completion_revision = 0, execution_id = ? WHERE fleet_id = ? AND session = ? AND work_id = ?`,
          )
          .run(executionId ?? null, fleetId, session, report.work_id);
      }
      if (report.state === 'done') {
        this.db
          .prepare(
            `UPDATE work_status_current SET completion_revision = completion_revision + 1
          WHERE fleet_id = ? AND session = ? AND work_id = ?`,
          )
          .run(fleetId, session, report.work_id);
      }
      this.bindKey(fleetId, session, report.idempotencyKey, normalizedJson, inserted.id);
      return this.receipt(inserted, false);
    });
  }

  resolve(
    fleetId: string,
    workId: string,
    answer: string,
    target?: { attemptId: string; blockerId: string; blockerRevision: number; targetClaimEventId?: string },
    now = Date.now(),
    queueCapacity = 5,
  ): WorkBlockerResolution {
    required(workId, 'work_id', 160);
    required(answer, 'answer', 2000);
    return withTransaction(this.db, () => {
      const current = this.currentBlocker(fleetId, workId, target?.attemptId);
      if (current.blocker_id === null || current.blocker_revision === null)
        throw new Error('Blocker identity is missing.');
      if (
        target !== undefined &&
        (target.attemptId !== current.attempt_id ||
          target.blockerId !== current.blocker_id ||
          target.blockerRevision !== current.blocker_revision ||
          (target.targetClaimEventId !== undefined &&
            target.targetClaimEventId !== `${fleetId}:work-status:${String(current.id)}`))
      ) {
        throw new InvalidRequestError('Blocker changed before resolution; refresh the status view.');
      }
      const pending = this.db
        .prepare("SELECT count(*) AS count FROM messages WHERE recipient = ? AND status = 'pending'")
        .get(current.session) as { count: number };
      if (pending.count >= queueCapacity) {
        throw new InvalidRequestError(`Message queue for ${current.session} is full; the blocker remains open.`);
      }
      const content = `Work ${workId} blocker ${current.blocker_id} (revision ${String(current.blocker_revision)}) was answered: ${answer}\nReport your next state.`;
      const message = this.db
        .prepare(
          "INSERT INTO messages (sender, recipient, type, content, delivery_policy, delivery_envelope) VALUES ('operator', ?, 'message', ?, 'bypass', ?)",
        )
        .run(current.session, content, messageEnvelope('operator', content));
      const event = this.insert({
        fleetId,
        session: current.session,
        workId,
        attemptId: current.attempt_id,
        version: current.mapping_version,
        kind: 'blocker_resolved',
        state: null,
        json: JSON.stringify({ answer, by: 'operator' }),
        now,
        blockerId: current.blocker_id,
        blockerRevision: current.blocker_revision,
        target: current.id,
      });
      projectResolution(this.db, event);
      return {
        eventId: `${fleetId}:work-status:${String(event.id)}`,
        sequence: event.id,
        workId,
        attemptId: current.attempt_id,
        session: current.session,
        blockerId: current.blocker_id,
        blockerRevision: current.blocker_revision,
        question: payload(current).question ?? '',
        answer,
        targetClaimEventId: `${fleetId}:work-status:${String(current.id)}`,
        messageId: Number(message.lastInsertRowid),
      };
    });
  }

  currentBlocker(fleetId: string, workId: string, attemptId?: string): WorkStatusEvent {
    const open = (attemptId === undefined
      ? this.db
          .prepare(
            `SELECT * FROM work_status_current
          WHERE fleet_id = ? AND work_id = ? AND state = 'blocked' AND resolved_at_ms IS NULL`,
          )
          .all(fleetId, workId)
      : this.db
          .prepare(
            `SELECT * FROM work_status_current
          WHERE fleet_id = ? AND work_id = ? AND attempt_id = ? AND state = 'blocked' AND resolved_at_ms IS NULL`,
          )
          .all(fleetId, workId, attemptId)) as unknown as WorkStatusCurrent[];
    if (open.length !== 1) {
      throw new InvalidRequestError(
        open.length === 0 ? 'No open blocker for this work ID.' : 'Ambiguous work ID; specify an attempt.',
      );
    }
    const current = open[0];
    if (current === undefined) throw new Error('Current blocker is missing.');
    return this.eventById(current.claim_event_id);
  }

  accept(
    fleetId: string,
    workId: string,
    actor: string,
    target: WorkStatusExactTarget,
    evidenceRef?: string,
    now = Date.now(),
  ): WorkStatusAuthorityReceipt {
    required(actor, 'actor', 160);
    if (evidenceRef !== undefined) required(evidenceRef, 'evidence_ref', 320);
    return withTransaction(this.db, () => {
      const { row, event } = this.exactDone(fleetId, workId, target);
      const claim = payload(event);
      const evidence = evidenceRef === undefined ? (claim.evidence ?? []) : [evidenceRef];
      if (evidence.length === 0) throw new InvalidRequestError('Acceptance requires attested evidence.');
      const accepted = this.insert({
        fleetId,
        session: row.session,
        workId,
        attemptId: row.attempt_id,
        version: event.mapping_version,
        kind: 'accepted',
        state: null,
        json: JSON.stringify({
          actor,
          evidence,
          attestation: 'attested',
          claimRevision: row.completion_revision,
          ...(claim.artifact_revision === undefined ? {} : { artifactRevision: claim.artifact_revision }),
        }),
        now,
        target: event.id,
      });
      this.setDisposition(row, 'accepted', accepted.id);
      return this.authorityReceipt(accepted, row, event, actor, 'attested', { evidence });
    });
  }

  reject(
    fleetId: string,
    workId: string,
    actor: string,
    reason: string,
    target: WorkStatusExactTarget,
    now = Date.now(),
    queueCapacity = 5,
    messageSender = actor,
  ): WorkStatusAuthorityReceipt {
    required(actor, 'actor', 160);
    required(reason, 'reason', 1000);
    return withTransaction(this.db, () => {
      const { row, event } = this.exactDone(fleetId, workId, target);
      this.assertQueueSpace(row.session, queueCapacity);
      const content = `Work ${workId} completion claim ${fleetId}:work-status:${String(event.id)} was not accepted: ${reason}\nReport your next state.`;
      const message = this.db
        .prepare(
          "INSERT INTO messages (sender, recipient, type, content, delivery_policy, delivery_envelope) VALUES (?, ?, 'message', ?, 'bypass', ?)",
        )
        .run(messageSender, row.session, content, messageEnvelope(messageSender, content));
      const rejected = this.insert({
        fleetId,
        session: row.session,
        workId,
        attemptId: row.attempt_id,
        version: event.mapping_version,
        kind: 'not_accepted',
        state: null,
        json: JSON.stringify({ actor, reason, claimRevision: row.completion_revision }),
        now,
        target: event.id,
      });
      this.setDisposition(row, 'not_accepted', rejected.id);
      return this.authorityReceipt(rejected, row, event, actor, 'authority', {
        reason,
        messageId: Number(message.lastInsertRowid),
      });
    });
  }

  closeWork(
    fleetId: string,
    workId: string,
    actor: string,
    reason: string,
    target: { attemptId: string; claimEventId: string },
    now = Date.now(),
  ): WorkStatusAuthorityReceipt {
    required(actor, 'actor', 160);
    required(reason, 'reason', 1000);
    return withTransaction(this.db, () => {
      const { row, event } = this.exactUnresolved(fleetId, workId, target);
      const closed = this.insert({
        fleetId,
        session: row.session,
        workId,
        attemptId: row.attempt_id,
        version: event.mapping_version,
        kind: 'work_closed',
        state: null,
        json: JSON.stringify({ actor, reason }),
        now,
        target: event.id,
      });
      this.setDisposition(row, 'closed', closed.id, true);
      return this.authorityReceipt(closed, row, event, actor, 'authority', { reason });
    });
  }

  rebind(
    fleetId: string,
    workId: string,
    actor: string,
    reason: string,
    target: { attemptId: string; claimEventId: string },
    executionId: string,
    now = Date.now(),
  ): WorkStatusAuthorityReceipt {
    required(actor, 'actor', 160);
    required(reason, 'reason', 1000);
    required(executionId, 'execution_id', 160);
    return withTransaction(this.db, () => {
      const { row, event } = this.exactUnresolved(fleetId, workId, target);
      if (row.disposition !== 'open' || row.state === 'done' || row.state === 'failed') {
        throw new InvalidRequestError('Only an open executing attempt can be rebound.');
      }
      if (row.execution_id === executionId)
        throw new InvalidRequestError('Attempt is already bound to this execution.');
      const rebound = this.insert({
        fleetId,
        session: row.session,
        workId,
        attemptId: row.attempt_id,
        version: event.mapping_version,
        kind: 'attempt_rebound',
        state: null,
        json: JSON.stringify({ actor, reason, previousExecutionId: row.execution_id, executionId }),
        now,
        target: event.id,
        executionId,
      });
      const changed = this.db
        .prepare(
          `UPDATE work_status_current SET execution_id = ?
        WHERE fleet_id = ? AND session = ? AND work_id = ? AND attempt_id = ? AND claim_event_id = ?
          AND disposition NOT IN ('accepted', 'closed')`,
        )
        .run(executionId, fleetId, row.session, workId, row.attempt_id, row.claim_event_id);
      if (changed.changes !== 1)
        throw new InvalidRequestError('Attempt changed before rebind; refresh the status view.');
      return this.authorityReceipt(rebound, row, event, actor, 'authority', { reason });
    });
  }

  private uniqueCurrent(
    fleetId: string,
    workId: string,
    attemptId: string | undefined,
    predicate: string,
    missing: string,
  ): WorkStatusCurrent {
    required(workId, 'work_id', 160);
    const rows = (attemptId === undefined
      ? this.db
          .prepare(`SELECT * FROM work_status_current WHERE fleet_id = ? AND work_id = ? AND ${predicate}`)
          .all(fleetId, workId)
      : this.db
          .prepare(
            `SELECT * FROM work_status_current WHERE fleet_id = ? AND work_id = ? AND attempt_id = ? AND ${predicate}`,
          )
          .all(fleetId, workId, attemptId)) as unknown as WorkStatusCurrent[];
    if (rows.length !== 1)
      throw new InvalidRequestError(rows.length === 0 ? missing : 'Ambiguous work ID; specify an attempt.');
    const row = rows[0];
    if (row === undefined) throw new Error('Current work row is missing.');
    return row;
  }

  private exactDone(
    fleetId: string,
    workId: string,
    target: WorkStatusExactTarget,
  ): { row: WorkStatusCurrent; event: WorkStatusEvent } {
    const current = this.currentDone(fleetId, workId, target.attemptId);
    const claim = payload(current.event);
    if (
      target.claimEventId !== `${fleetId}:work-status:${String(current.event.id)}` ||
      (target.artifactRevision ?? null) !== (claim.artifact_revision ?? null)
    ) {
      throw new InvalidRequestError('Done claim changed before acceptance; refresh the status view.');
    }
    return current;
  }

  private exactUnresolved(
    fleetId: string,
    workId: string,
    target: { attemptId: string; claimEventId: string },
  ): { row: WorkStatusCurrent; event: WorkStatusEvent } {
    const current = this.currentUnresolved(fleetId, workId, target.attemptId);
    if (target.claimEventId !== `${fleetId}:work-status:${String(current.event.id)}`) {
      throw new InvalidRequestError('Work claim changed before action; refresh the status view.');
    }
    return current;
  }

  private setDisposition(
    row: WorkStatusCurrent,
    disposition: WorkStatusCurrent['disposition'],
    eventId: number,
    allowRejected = false,
  ): void {
    const allowed = allowRejected ? "('open', 'not_accepted')" : "('open')";
    const changed = this.db
      .prepare(
        `UPDATE work_status_current SET disposition = ?, disposition_event_id = ?
      WHERE fleet_id = ? AND session = ? AND work_id = ? AND attempt_id = ? AND claim_event_id = ? AND disposition IN ${allowed}`,
      )
      .run(disposition, eventId, row.fleet_id, row.session, row.work_id, row.attempt_id, row.claim_event_id);
    if (changed.changes !== 1)
      throw new InvalidRequestError('Work claim changed before action; refresh the status view.');
  }

  private assertQueueSpace(session: string, capacity: number): void {
    const pending = this.db
      .prepare("SELECT count(*) AS count FROM messages WHERE recipient = ? AND status = 'pending'")
      .get(session) as { count: number };
    if (pending.count >= capacity)
      throw new InvalidRequestError(`Message queue for ${session} is full; status is unchanged.`);
  }

  private authorityReceipt(
    event: WorkStatusEvent,
    row: WorkStatusCurrent,
    target: WorkStatusEvent,
    actor: string,
    attestation: WorkStatusAuthorityReceipt['attestation'],
    extra: { evidence?: string[]; reason?: string; messageId?: number },
  ): WorkStatusAuthorityReceipt {
    const claim = payload(target);
    return {
      eventId: `${event.fleet_id}:work-status:${String(event.id)}`,
      sequence: event.id,
      workId: row.work_id,
      fleetId: row.fleet_id,
      attemptId: row.attempt_id,
      session: row.session,
      targetClaimEventId: `${target.fleet_id}:work-status:${String(target.id)}`,
      claimRevision: row.completion_revision,
      ...(claim.artifact_revision === undefined ? {} : { artifactRevision: claim.artifact_revision }),
      ...(claim.evidence === undefined ? {} : { claimEvidence: claim.evidence }),
      ...(extra.evidence === undefined ? {} : { evidence: extra.evidence }),
      ...(extra.reason === undefined ? {} : { reason: extra.reason }),
      ...(extra.messageId === undefined ? {} : { messageId: extra.messageId }),
      actor,
      attestation,
    };
  }

  private eventById(id: number): WorkStatusEvent {
    const event = this.db.prepare('SELECT * FROM work_status_events WHERE id = ?').get(id) as
      WorkStatusEvent | undefined;
    if (event === undefined) throw new Error(`Work status event ${String(id)} is missing.`);
    return event;
  }

  private countDuplicate(eventId: number): void {
    this.db.prepare('UPDATE work_status_events SET duplicate_count = duplicate_count + 1 WHERE id = ?').run(eventId);
  }

  private bindKey(fleetId: string, session: string, key: string | undefined, json: string, eventId: number): void {
    if (key === undefined) return;
    this.db
      .prepare(
        `INSERT INTO work_status_idempotency
      (fleet_id, session, idempotency_key, payload_json, claim_event_id) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(fleetId, session, key, json, eventId);
  }

  private receipt(event: WorkStatusEvent, unchanged: boolean): WorkStatusReceipt {
    if (event.state === null) throw new Error('Cannot issue a claim receipt for a non-claim event.');
    return {
      eventId: `${event.fleet_id}:work-status:${String(event.id)}`,
      sequence: event.id,
      occurredAt: new Date(event.occurred_at_ms).toISOString(),
      workId: event.work_id,
      attemptId: event.attempt_id,
      state: event.state,
      ...(event.blocker_id === null ? {} : { blockerId: event.blocker_id }),
      ...(event.blocker_revision === null ? {} : { blockerRevision: event.blocker_revision }),
      unchanged,
    };
  }

  private insert(input: {
    fleetId: string;
    session: string;
    workId: string;
    attemptId: string;
    version: string;
    kind: WorkStatusEvent['kind'];
    state: WorkClaimState | null;
    json: string;
    now: number;
    target?: number;
    blockerId?: string;
    blockerRevision?: number;
    idempotencyKey?: string;
    executionId?: string;
  }): WorkStatusEvent {
    const result = this.db
      .prepare(
        `INSERT INTO work_status_events
         (fleet_id, session, work_id, attempt_id, mapping_version, kind, state, payload_json,
          blocker_id, blocker_revision, target_event_id, occurred_at_ms, idempotency_key, execution_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.fleetId,
        input.session,
        input.workId,
        input.attemptId,
        input.version,
        input.kind,
        input.state,
        input.json,
        input.blockerId ?? null,
        input.blockerRevision ?? null,
        input.target ?? null,
        input.now,
        input.idempotencyKey ?? null,
        input.executionId ?? null,
      );
    const event = this.db
      .prepare('SELECT * FROM work_status_events WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as WorkStatusEvent | undefined;
    if (event === undefined) throw new Error('Work status event was not persisted.');
    return event;
  }
}
