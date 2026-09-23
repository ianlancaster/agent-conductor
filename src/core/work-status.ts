import type { WorkClaimState, WorkStatusEvent, WorkStatusReport } from '../store/work-status.js';

export interface WorkActivityObservation {
  processActive: boolean | null;
  processObservedAt?: number;
  activity: 'working' | 'idle' | 'unknown';
  idleSince?: number;
  activityObservedAt?: number;
}

export interface WorkStatusThresholds {
  disagreementMs: number;
  staleMs: number;
  waitingMs: number;
  observationMaxAgeMs: number;
}

export interface WorkStatusView {
  session: string;
  workId: string;
  attemptId: string;
  state: WorkClaimState;
  summary: string;
  stateEnteredAt: number;
  cumulativeMs: Record<WorkClaimState, number>;
  workStartedAt: number;
  claimEventId: string;
  blockerId?: string;
  blockerRevision?: number;
  blockerStartedAt?: number;
  needsFrom?: string;
  waitingOn?: string;
  evidence?: string[];
  resolvedAt?: number;
  liveness: 'working' | 'idle' | 'stopped' | 'unknown';
  stale: boolean;
  disagreement: boolean;
  attentionBand: number;
  attentionSince: number;
  paused: boolean;
}

export interface WorkStatusSummary {
  views: WorkStatusView[];
  activeAttempts: number;
  activeUnits: number;
  startedUnresolved: number;
  onOperator: number;
  oldestOperatorBlockMs: number | null;
}

const ACTIVE = new Set<WorkClaimState>(['working', 'waiting', 'blocked', 'done']);

function claim(event: WorkStatusEvent): WorkStatusReport {
  return JSON.parse(event.payload_json) as WorkStatusReport;
}

function fresh(observedAt: number | undefined, now: number, maxAge: number): boolean {
  return observedAt !== undefined && now >= observedAt && now - observedAt <= maxAge;
}

export function deriveWorkStatus(
  events: readonly WorkStatusEvent[],
  observation: (session: string) => WorkActivityObservation,
  paused: (session: string) => boolean,
  now: number,
  thresholds: WorkStatusThresholds,
): WorkStatusSummary {
  const current = new Map<
    string,
    {
      event: WorkStatusEvent;
      enteredAt: number;
      blockerStartedAt?: number;
      accumulated: Record<WorkClaimState, number>;
    }
  >();
  const firstStart = new Map<string, number>();
  const resolved = new Map<string, number>();
  for (const event of events) {
    const key = `${event.fleet_id}\0${event.attempt_id}`;
    if (event.kind === 'blocker_resolved' && event.blocker_id !== null && event.blocker_revision !== null) {
      resolved.set(`${event.blocker_id}:${String(event.blocker_revision)}`, event.occurred_at_ms);
    }
    if (event.kind !== 'claim' || event.state === null) continue;
    const workKey = `${event.fleet_id}\0${event.work_id}`;
    firstStart.set(workKey, Math.min(firstStart.get(workKey) ?? event.occurred_at_ms, event.occurred_at_ms));
    const prior = current.get(key);
    const enteredAt = prior?.event.state === event.state ? prior.enteredAt : event.occurred_at_ms;
    const accumulated = prior?.accumulated ?? { working: 0, waiting: 0, blocked: 0, done: 0, failed: 0 };
    if (prior !== undefined && prior.event.state !== null && prior.event.state !== event.state) {
      accumulated[prior.event.state] += event.occurred_at_ms - prior.enteredAt;
    }
    const blockerStartedAt =
      event.state !== 'blocked'
        ? undefined
        : prior?.event.blocker_id === event.blocker_id && prior.event.blocker_revision === event.blocker_revision
          ? prior.blockerStartedAt
          : event.occurred_at_ms;
    current.set(key, { event, enteredAt, blockerStartedAt, accumulated });
  }
  const views: WorkStatusView[] = [];
  for (const { event, enteredAt, blockerStartedAt, accumulated } of current.values()) {
    if (event.state === null) continue;
    const report = claim(event);
    const mechanical = observation(event.session);
    const processFresh = fresh(mechanical.processObservedAt, now, thresholds.observationMaxAgeMs);
    const activityFresh = fresh(mechanical.activityObservedAt, now, thresholds.observationMaxAgeMs);
    const liveness: WorkStatusView['liveness'] =
      processFresh && mechanical.processActive === false
        ? 'stopped'
        : processFresh && mechanical.processActive === true && activityFresh
          ? mechanical.activity
          : 'unknown';
    const disagree =
      event.state === 'working' &&
      (liveness === 'stopped' ||
        (liveness === 'idle' &&
          mechanical.idleSince !== undefined &&
          now - mechanical.idleSince >= thresholds.disagreementMs));
    const stale =
      event.state === 'working' &&
      now - enteredAt >= thresholds.staleMs &&
      (liveness === 'stopped' ||
        (liveness === 'idle' &&
          mechanical.idleSince !== undefined &&
          now - mechanical.idleSince >= thresholds.disagreementMs));
    const resolutionKey =
      event.blocker_id === null || event.blocker_revision === null
        ? undefined
        : `${event.blocker_id}:${String(event.blocker_revision)}`;
    const resolvedAt = resolutionKey === undefined ? undefined : resolved.get(resolutionKey);
    const blocked = event.state === 'blocked' && resolvedAt === undefined;
    const overdue =
      (event.state === 'waiting' && now - enteredAt >= thresholds.waitingMs) ||
      (resolvedAt !== undefined && now - resolvedAt >= thresholds.waitingMs);
    const attentionBand =
      blocked && report.needs_from === 'operator'
        ? 0
        : blocked
          ? 0
          : stale || disagree
            ? 1
            : overdue
              ? 2
              : event.state === 'done'
                ? 3
                : event.state === 'working'
                  ? 4
                  : 5;
    const attentionSince =
      blocked && blockerStartedAt !== undefined
        ? blockerStartedAt
        : overdue && resolvedAt !== undefined
          ? resolvedAt
          : enteredAt;
    views.push({
      session: event.session,
      workId: event.work_id,
      attemptId: event.attempt_id,
      state: event.state,
      summary: report.summary,
      stateEnteredAt: enteredAt,
      cumulativeMs: { ...accumulated, [event.state]: accumulated[event.state] + Math.max(0, now - enteredAt) },
      workStartedAt: firstStart.get(`${event.fleet_id}\0${event.work_id}`) ?? enteredAt,
      claimEventId: `${event.fleet_id}:work-status:${String(event.id)}`,
      ...(event.blocker_id === null ? {} : { blockerId: event.blocker_id }),
      ...(event.blocker_revision === null ? {} : { blockerRevision: event.blocker_revision }),
      ...(blockerStartedAt === undefined ? {} : { blockerStartedAt }),
      ...(report.needs_from === undefined ? {} : { needsFrom: report.needs_from }),
      ...(report.waiting_on === undefined ? {} : { waitingOn: report.waiting_on }),
      ...(report.evidence === undefined ? {} : { evidence: report.evidence }),
      ...(resolvedAt === undefined ? {} : { resolvedAt }),
      liveness,
      stale,
      disagreement: disagree,
      attentionBand,
      attentionSince,
      paused: paused(event.session),
    });
  }
  views.sort(
    (a, b) =>
      a.attentionBand - b.attentionBand ||
      (a.attentionBand === 0 && a.needsFrom === 'operator' && b.needsFrom !== 'operator' ? -1 : 0) ||
      (a.attentionBand === 0 && b.needsFrom === 'operator' && a.needsFrom !== 'operator' ? 1 : 0) ||
      a.attentionSince - b.attentionSince ||
      a.workId.localeCompare(b.workId) ||
      a.attemptId.localeCompare(b.attemptId),
  );
  const active = views.filter((view) => ACTIVE.has(view.state));
  const onOperator = views.filter(
    (view) => view.state === 'blocked' && view.resolvedAt === undefined && view.needsFrom === 'operator',
  );
  const units = new Set(views.map((view) => view.workId));
  return {
    views,
    activeAttempts: active.length,
    activeUnits: new Set(active.map((view) => view.workId)).size,
    startedUnresolved: units.size,
    onOperator: onOperator.length,
    oldestOperatorBlockMs:
      onOperator.length === 0
        ? null
        : now - Math.min(...onOperator.map((view) => view.blockerStartedAt ?? view.stateEnteredAt)),
  };
}

export function formatWorkDuration(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)}h`;
  return `${String(Math.floor(hours / 24))}d`;
}

export function renderWorkStatus(summary: WorkStatusSummary, now: number): string {
  if (summary.views.length === 0) return '';
  const oldest = summary.oldestOperatorBlockMs === null ? 'none' : formatWorkDuration(summary.oldestOperatorBlockMs);
  const lines = [
    `Work status: ${String(summary.activeAttempts)} active attempt(s), ${String(summary.activeUnits)} active unit(s), ${String(summary.startedUnresolved)} started unresolved · on Ian: ${String(summary.onOperator)}, oldest ${oldest}`,
    '  Session · Work · State · In state · Work age · Evidence · Needs from · Liveness',
  ];
  for (const view of summary.views) {
    const label =
      view.resolvedAt !== undefined && view.state === 'blocked'
        ? 'resolved; awaiting transition'
        : view.stale
          ? 'stale'
          : view.disagreement
            ? 'disagreement'
            : view.state === 'done'
              ? 'done awaiting acceptance'
              : view.state;
    const needs = view.needsFrom ?? view.waitingOn ?? '-';
    lines.push(
      `  ${view.session} · ${view.workId} · ${label}${view.paused ? ' (session paused)' : ''} · ${formatWorkDuration(now - view.stateEnteredAt)} · ${formatWorkDuration(now - view.workStartedAt)} · ${view.evidence?.[0] ?? '-'} · ${needs} · ${view.liveness}`,
    );
  }
  return lines.join('\n');
}
