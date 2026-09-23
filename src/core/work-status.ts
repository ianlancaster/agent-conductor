import type { WorkClaimState, WorkStatusReport } from '../store/work-status.js';
import type { WorkStatusCurrent } from '../store/work-status-projection.js';

export interface WorkActivityObservation {
  processActive: boolean | null;
  processObservedAt?: number;
  activity: 'working' | 'idle' | 'blocked' | 'unknown';
  idleSince?: number;
  blockedSince?: number;
  activityObservedAt?: number;
  persistedStopped?: boolean;
  unknownNotification?: string;
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
  resolvedAwaitingTransitionMs: number;
  workStartedAt: number;
  claimEventId: string;
  blockerId?: string;
  blockerRevision?: number;
  blockerStartedAt?: number;
  needsFrom?: string;
  waitingOn?: string;
  evidence?: string[];
  resolvedAt?: number;
  liveness: 'working' | 'idle' | 'blocked' | 'stopped' | 'unknown';
  unknownNotification?: string;
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

function fresh(observedAt: number | undefined, now: number, maxAge: number): boolean {
  return observedAt !== undefined && now >= observedAt && now - observedAt <= maxAge;
}

/** Current-row projection; no history is replayed for status rendering. */
export function deriveWorkStatus(
  rows: readonly WorkStatusCurrent[],
  observation: (session: string) => WorkActivityObservation,
  paused: (session: string) => boolean,
  now: number,
  thresholds: WorkStatusThresholds,
): WorkStatusSummary {
  const views: WorkStatusView[] = [];
  for (const row of rows) {
    const report = JSON.parse(row.payload_json) as WorkStatusReport;
    const mechanical = observation(row.session);
    const processFresh = fresh(mechanical.processObservedAt, now, thresholds.observationMaxAgeMs);
    const activityFresh = fresh(mechanical.activityObservedAt, now, thresholds.observationMaxAgeMs);
    const liveness: WorkStatusView['liveness'] =
      mechanical.persistedStopped === true || (processFresh && mechanical.processActive === false)
        ? 'stopped'
        : activityFresh && mechanical.activity === 'blocked'
          ? 'blocked'
          : processFresh && mechanical.processActive === true && activityFresh
            ? mechanical.activity
            : 'unknown';
    const disagreement =
      row.state === 'working' &&
      (liveness === 'stopped' ||
        (liveness === 'idle' &&
          mechanical.idleSince !== undefined &&
          now - mechanical.idleSince >= thresholds.disagreementMs));
    const stale =
      row.state === 'working' &&
      now - row.state_entered_at_ms >= thresholds.staleMs &&
      (liveness === 'stopped' ||
        (liveness === 'idle' &&
          mechanical.idleSince !== undefined &&
          now - mechanical.idleSince >= thresholds.disagreementMs));
    const claimBlocked = row.state === 'blocked' && row.resolved_at_ms === null;
    const harnessPrompt = liveness === 'blocked' && !claimBlocked;
    const overdue =
      (row.state === 'waiting' && now - row.state_entered_at_ms >= thresholds.waitingMs) ||
      (row.state === 'blocked' && row.resolved_at_ms !== null && now - row.resolved_at_ms >= thresholds.waitingMs);
    const attentionBand =
      claimBlocked && report.needs_from === 'operator'
        ? 0
        : harnessPrompt
          ? 0.25
          : claimBlocked
            ? 0.5
            : stale || disagreement
              ? 1
              : overdue
                ? 2
                : row.state === 'done'
                  ? 3
                  : row.state === 'working'
                    ? 4
                    : 5;
    const attentionSince = claimBlocked
      ? (row.blocker_started_at_ms ?? row.state_entered_at_ms)
      : harnessPrompt
        ? (mechanical.blockedSince ?? mechanical.activityObservedAt ?? row.state_entered_at_ms)
        : overdue && row.resolved_at_ms !== null
          ? row.resolved_at_ms
          : row.state_entered_at_ms;
    const cumulative = JSON.parse(row.cumulative_json) as Record<WorkClaimState, number>;
    if (row.state === 'blocked' && row.resolved_at_ms === null) {
      cumulative.blocked += Math.max(0, now - (row.blocker_started_at_ms ?? row.state_entered_at_ms));
    } else if (row.state !== 'blocked') {
      cumulative[row.state] += Math.max(0, now - row.state_entered_at_ms);
    }
    const resolvedAwaitingTransitionMs =
      row.acknowledgement_wait_ms +
      (row.state === 'blocked' && row.resolved_at_ms !== null ? Math.max(0, now - row.resolved_at_ms) : 0);
    views.push({
      session: row.session,
      workId: row.work_id,
      attemptId: row.attempt_id,
      state: row.state,
      summary: report.summary,
      stateEnteredAt: row.state_entered_at_ms,
      cumulativeMs: cumulative,
      resolvedAwaitingTransitionMs,
      workStartedAt: row.work_started_at_ms,
      claimEventId: `${row.fleet_id}:work-status:${String(row.claim_event_id)}`,
      ...(row.blocker_id === null ? {} : { blockerId: row.blocker_id }),
      ...(row.blocker_revision === null ? {} : { blockerRevision: row.blocker_revision }),
      ...(row.blocker_started_at_ms === null ? {} : { blockerStartedAt: row.blocker_started_at_ms }),
      ...(report.needs_from === undefined ? {} : { needsFrom: report.needs_from }),
      ...(report.waiting_on === undefined ? {} : { waitingOn: report.waiting_on }),
      ...(report.evidence === undefined ? {} : { evidence: report.evidence }),
      ...(row.resolved_at_ms === null ? {} : { resolvedAt: row.resolved_at_ms }),
      ...(mechanical.unknownNotification === undefined ? {} : { unknownNotification: mechanical.unknownNotification }),
      liveness,
      stale,
      disagreement,
      attentionBand,
      attentionSince,
      paused: paused(row.session),
    });
  }
  views.sort(
    (a, b) =>
      a.attentionBand - b.attentionBand ||
      a.attentionSince - b.attentionSince ||
      a.workId.localeCompare(b.workId) ||
      a.attemptId.localeCompare(b.attemptId),
  );
  const active = views.filter((view) => ACTIVE.has(view.state));
  const onOperator = views.filter(
    (view) => view.state === 'blocked' && view.resolvedAt === undefined && view.needsFrom === 'operator',
  );
  return {
    views,
    activeAttempts: active.length,
    activeUnits: new Set(active.map((view) => view.workId)).size,
    startedUnresolved: new Set(views.map((view) => view.workId)).size,
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
    `Work status: ${String(summary.activeAttempts)} active attempt(s), ${String(summary.activeUnits)} active unit(s), ${String(summary.startedUnresolved)} started unresolved · on operator: ${String(summary.onOperator)}, oldest ${oldest}`,
    '  Session · Work · State · In state · Work age · Evidence · Needs from · Liveness',
  ];
  for (const view of summary.views) {
    const label =
      view.attentionBand === 0.25
        ? 'harness prompt'
        : view.resolvedAt !== undefined && view.state === 'blocked'
          ? 'resolved; awaiting transition'
          : view.stale
            ? 'stale'
            : view.disagreement
              ? 'disagreement'
              : view.state === 'done'
                ? 'done awaiting acceptance'
                : view.state;
    const needs = view.needsFrom ?? view.waitingOn ?? '-';
    const annotation =
      view.unknownNotification === undefined
        ? ''
        : ` · runtime notification, type unknown: ${view.unknownNotification}`;
    lines.push(
      `  ${view.session} · ${view.workId} · ${label}${view.paused ? ' (session paused)' : ''} · ${formatWorkDuration(now - view.stateEnteredAt)} · ${formatWorkDuration(now - view.workStartedAt)} · ${view.evidence?.[0] ?? '-'} · ${needs} · ${view.liveness}${annotation}`,
    );
  }
  return lines.join('\n');
}
