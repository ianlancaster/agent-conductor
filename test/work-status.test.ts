import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveWorkStatus, renderWorkStatus, type WorkActivityObservation } from '../src/core/work-status.js';
import { Store } from '../src/store/index.js';
import type { WorkStatusReport } from '../src/store/work-status.js';

const fleet = 'fleet-test';
const blocked: WorkStatusReport = {
  state: 'blocked',
  work_id: 'TASK-1',
  summary: 'Need a decision',
  needs_from: 'operator',
  question: 'Which API?',
  recommendation: 'Use A',
  meanwhile: 'Documenting',
  if_no_answer: 'Wait',
};

describe('work status journal', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  it('binds one attempt, rejects summary-only working and a second working item', () => {
    const first = store.workStatus.report(
      fleet,
      'alpha',
      { state: 'working', work_id: 'TASK-1', summary: 'Build' },
      100,
    );
    expect(first.attemptId).toBeTruthy();
    expect(() =>
      store.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-1', summary: 'Step 2' }, 200),
    ).toThrow('changed structured field');
    expect(() =>
      store.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-2', summary: 'Other' }, 200),
    ).toThrow(`Move TASK-1 (attempt ${first.attemptId}) from working before starting TASK-2.`);
    const wait = store.workStatus.report(
      fleet,
      'alpha',
      { state: 'waiting', work_id: 'TASK-1', summary: 'CI', waiting_on: 'CI run' },
      200,
    );
    expect(wait.attemptId).toBe(first.attemptId);
    expect(
      store.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-2', summary: 'Other' }, 300).attemptId,
    ).not.toBe(first.attemptId);
  });

  it('preserves the original keyed receipt after later reports, audits exact duplicates, and rejects key reuse', () => {
    const report = { state: 'working' as const, work_id: 'TASK-1', summary: 'Build', idempotencyKey: 'request-1' };
    const first = store.workStatus.report(fleet, 'alpha', report, 100);
    expect(store.workStatus.report(fleet, 'alpha', report, 110)).toMatchObject({
      eventId: first.eventId,
      unchanged: true,
    });
    store.workStatus.report(
      fleet,
      'alpha',
      { state: 'waiting', work_id: 'TASK-1', summary: 'CI', waiting_on: 'CI' },
      200,
    );
    store.workStatus.report(
      fleet,
      'alpha',
      { state: 'waiting', work_id: 'TASK-1', summary: 'CI', waiting_on: 'CI' },
      210,
    );
    expect(store.workStatus.report(fleet, 'alpha', report, 300)).toMatchObject({
      eventId: first.eventId,
      unchanged: true,
    });
    expect(() => store.workStatus.report(fleet, 'alpha', { ...report, summary: 'Different' }, 300)).toThrow(
      'idempotencyKey',
    );
    expect(store.workStatus.events(fleet).find((event) => event.id === first.sequence)?.duplicate_count).toBe(2);
  });

  it('revises a blocker only for a changed question, and resolves the current revision', () => {
    store.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-1', summary: 'Build' }, 100);
    const first = store.workStatus.report(fleet, 'alpha', blocked, 200);
    expect(first.blockerRevision).toBe(1);
    expect(() => store.workStatus.report(fleet, 'alpha', { ...blocked, summary: 'No change' }, 250)).toThrow(
      'changed structured field',
    );
    const clarification = store.workStatus.report(fleet, 'alpha', { ...blocked, recommendation: 'Use B' }, 300);
    expect(clarification).toMatchObject({ blockerId: first.blockerId, blockerRevision: 1 });
    const next = store.workStatus.report(fleet, 'alpha', { ...blocked, question: 'Which endpoint?' }, 400);
    expect(next).toMatchObject({ blockerId: first.blockerId, blockerRevision: 2 });
    const answer = store.workStatus.resolve(fleet, 'TASK-1', 'Use endpoint B', 500);
    expect(answer).toMatchObject({ targetClaimEventId: next.eventId, blockerRevision: 2, question: 'Which endpoint?' });
    expect(store.getMessage(answer.messageId)).toMatchObject({ recipient: 'alpha', status: 'pending' });
    expect(
      store.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-1', summary: 'Implementing' }, 600)
        .attemptId,
    ).toBe(first.attemptId);
  });

  it('requires an identified blocker owner', () => {
    store.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-1', summary: 'Build' }, 100);
    expect(() =>
      store.workStatus.report(
        fleet,
        'alpha',
        { ...blocked, needs_from: 'unlisted-owner' },
        200,
        new Set(['alpha', 'bob']),
      ),
    ).toThrow('needs_from must be operator or a known session codename');
    expect(
      store.workStatus.report(fleet, 'alpha', { ...blocked, needs_from: 'bob' }, 200, new Set(['alpha', 'bob'])).state,
    ).toBe('blocked');
  });

  it('returns an old keyed blocker receipt after its authority leaves the roster', () => {
    store.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-1', summary: 'Build' }, 100);
    const packet = { ...blocked, needs_from: 'bob', idempotencyKey: 'decision-1' };
    const first = store.workStatus.report(fleet, 'alpha', packet, 200, new Set(['alpha', 'bob']));
    expect(store.workStatus.report(fleet, 'alpha', packet, 300, new Set(['alpha']))).toMatchObject({
      eventId: first.eventId,
      unchanged: true,
    });
    expect(store.workStatus.events(fleet)).toHaveLength(2);
    expect(store.workStatus.events(fleet)[1]?.duplicate_count).toBe(1);
  });

  it('resolves the latest clarification and records its claim event', () => {
    store.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-1', summary: 'Build' }, 100);
    const first = store.workStatus.report(fleet, 'alpha', blocked, 200);
    const clarified = store.workStatus.report(fleet, 'alpha', { ...blocked, recommendation: 'Use B' }, 300);
    const resolved = store.workStatus.resolve(fleet, 'TASK-1', 'A', 400);
    expect(resolved).toMatchObject({
      targetClaimEventId: clarified.eventId,
      blockerId: first.blockerId,
      blockerRevision: first.blockerRevision,
    });
    expect(store.workStatus.events(fleet).filter((event) => event.kind === 'blocker_resolved')).toHaveLength(1);
  });

  it('requires evidence identifying done output, permits new evidence, and bars failed amendments', () => {
    store.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-1', summary: 'Review' }, 100);
    expect(() =>
      store.workStatus.report(
        fleet,
        'alpha',
        { state: 'done', work_id: 'TASK-1', summary: 'Reviewed', evidence: [] },
        200,
      ),
    ).toThrow('evidence');
    const first = store.workStatus.report(
      fleet,
      'alpha',
      { state: 'done', work_id: 'TASK-1', summary: 'Reviewed', evidence: ['review://123'] },
      200,
    );
    const amended = store.workStatus.report(
      fleet,
      'alpha',
      { state: 'done', work_id: 'TASK-1', summary: 'Reviewed', evidence: ['review://123', 'comment://456'] },
      300,
    );
    expect(amended.eventId).not.toBe(first.eventId);
    expect(() =>
      store.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-1', summary: 'Rework' }, 350),
    ).toThrow('closed');
    expect(() =>
      store.workStatus.report(fleet, 'alpha', { state: 'failed', work_id: 'TASK-1', summary: 'No', reason: 'No' }, 400),
    ).toThrow('closed');
  });

  it('rejects ambiguous short blocker resolution and leaves delivery durable', () => {
    for (const session of ['alpha', 'beta']) {
      store.workStatus.report(fleet, session, { state: 'working', work_id: 'TASK-1', summary: 'Build' }, 100);
      store.workStatus.report(fleet, session, blocked, 200);
    }
    expect(() => store.workStatus.currentBlocker(fleet, 'TASK-1')).toThrow('Ambiguous');
    expect(store.workStatus.events(fleet).filter((event) => event.kind === 'blocker_resolved')).toHaveLength(0);
  });

  it('leaves the blocker open when protected answer delivery is at capacity', () => {
    store.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-1', summary: 'Build' }, 100);
    store.workStatus.report(fleet, 'alpha', blocked, 200);
    store.insertDirectMessage('operator', 'alpha', 'Existing message');
    expect(() => store.workStatus.resolve(fleet, 'TASK-1', 'Use A', 300, 1)).toThrow('queue');
    expect(store.workStatus.currentBlocker(fleet, 'TASK-1').state).toBe('blocked');
    expect(store.workStatus.events(fleet).filter((event) => event.kind === 'blocker_resolved')).toHaveLength(0);
  });
});

describe('work status projection', () => {
  let store: Store;
  beforeEach(() => {
    store = new Store(':memory:');
  });
  afterEach(() => {
    store.close();
  });
  const limits = { disagreementMs: 3_600_000, staleMs: 14_400_000, waitingMs: 14_400_000, observationMaxAgeMs: 60_000 };
  const unknown: WorkActivityObservation = { processActive: null, activity: 'unknown' };
  const derive = (now: number, observation: WorkActivityObservation = unknown) =>
    deriveWorkStatus(
      store.workStatus.current(fleet),
      () => observation,
      () => true,
      now,
      limits,
    );

  it('keeps state and work age across same-state updates and pause, with unknown telemetry', () => {
    store.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-1', summary: 'Build' }, 100);
    store.workStatus.report(
      fleet,
      'alpha',
      { state: 'waiting', work_id: 'TASK-1', summary: 'CI', waiting_on: 'CI run 1' },
      200,
    );
    store.workStatus.report(
      fleet,
      'alpha',
      { state: 'waiting', work_id: 'TASK-1', summary: 'CI', waiting_on: 'CI run 2' },
      300,
    );
    const status = derive(400);
    expect(status.views[0]).toMatchObject({
      stateEnteredAt: 200,
      workStartedAt: 100,
      cumulativeMs: { working: 100, waiting: 200 },
      paused: true,
      liveness: 'unknown',
      stale: false,
    });
    expect(status.active).toBe(1);
  });

  it('shows disagreement at one hour, stale later, and keeps failed work unresolved', () => {
    store.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-1', summary: 'Build' }, 100);
    const now = 3_600_101;
    const idle: WorkActivityObservation = {
      processActive: true,
      processObservedAt: now,
      activity: 'idle',
      activityObservedAt: now,
      idleSince: 100,
    };
    expect(derive(now, idle).views[0]).toMatchObject({ disagreement: true, stale: false, attentionBand: 3 });
    const later = 14_400_101;
    expect(derive(later, { ...idle, processObservedAt: later, activityObservedAt: later }).views[0]).toMatchObject({
      disagreement: true,
      stale: true,
    });
    store.workStatus.report(
      fleet,
      'alpha',
      { state: 'failed', work_id: 'TASK-1', summary: 'Failed', reason: 'Build failed' },
      later,
    );
    expect(derive(later).unresolved).toBe(1);
  });

  it('keeps a completed stop in attention after telemetry expires and a store restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'conductor-work-stop-'));
    try {
      const dbPath = join(dir, 'conductor.db');
      const persistent = new Store(dbPath);
      persistent.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-1', summary: 'Build' }, 100);
      persistent.upsertSessionState({
        session: 'alpha',
        auto: false,
        tag: null,
        paused: false,
        activeRuntime: null,
        activeEffort: null,
        activity: 'stopped',
      });
      persistent.close();
      const restarted = new Store(dbPath);
      try {
        const now = 10 * limits.observationMaxAgeMs;
        const summary = deriveWorkStatus(
          restarted.workStatus.current(fleet),
          () => ({
            processActive: null,
            activity: 'unknown',
            persistedStopped: restarted.getSessionState('alpha')?.activity === 'stopped',
          }),
          () => false,
          now,
          limits,
        );
        expect(summary.views[0]).toMatchObject({ liveness: 'stopped', disagreement: true, attentionBand: 3 });
      } finally {
        restarted.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('puts a verified harness prompt below operator blockers without adding it to the operator queue', () => {
    store.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-1', summary: 'Build' }, 100);
    const now = 200;
    const summary = derive(now, {
      processActive: true,
      processObservedAt: now,
      activity: 'blocked',
      activityObservedAt: now,
      blockedSince: 150,
    });
    expect(summary.views[0]).toMatchObject({ liveness: 'blocked', attentionBand: 1, disagreement: false });
    expect(summary.onOperator).toBe(0);
    expect(
      derive(now, {
        processActive: null,
        activity: 'blocked',
        activityObservedAt: now,
        blockedSince: 150,
      }).views[0]?.attentionBand,
    ).toBe(1);
    store.workStatus.report(
      fleet,
      'alpha',
      { state: 'waiting', work_id: 'TASK-1', summary: 'CI', waiting_on: 'CI' },
      175,
    );
    expect(
      derive(now, {
        processActive: true,
        processObservedAt: now,
        activity: 'blocked',
        activityObservedAt: now,
        blockedSince: 150,
      }).views[0]?.attentionBand,
    ).toBe(1);
  });

  it('shows the blocker question and the operator queue in the live status window', () => {
    store.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-1', summary: 'Build' }, 100);
    store.workStatus.report(
      fleet,
      'alpha',
      {
        state: 'blocked',
        work_id: 'TASK-1',
        summary: 'Need a decision',
        needs_from: 'operator',
        question: 'Which\nAPI?',
      },
      200,
    );
    const status = derive(300);
    expect(status.views[0]?.question).toBe('Which\nAPI?');
    expect(renderWorkStatus(status, 300)).toContain('on operator: 1, oldest');
    expect(renderWorkStatus(status, 300)).toContain('Which API?');
  });

  it('renders a bounded neutral notification without changing liveness or queue counts', () => {
    store.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-1', summary: 'Build' }, 100);
    const summary = derive(200, {
      processActive: true,
      processObservedAt: 200,
      activity: 'unknown',
      unknownNotification: 'older hook message',
    });
    expect(summary.views[0]).toMatchObject({ liveness: 'unknown', attentionBand: 6 });
    expect(summary.onOperator).toBe(0);
    expect(renderWorkStatus(summary, 200)).toContain('runtime notification, type unknown: older hook message');
  });

  it('shows only the latest attempt for a work item and preserves work age through retry', () => {
    const first = store.workStatus.report(
      fleet,
      'alpha',
      { state: 'working', work_id: 'TASK-1', summary: 'Build' },
      100,
    );
    store.workStatus.report(
      fleet,
      'alpha',
      { state: 'failed', work_id: 'TASK-1', summary: 'Failed', reason: 'CI' },
      200,
    );
    const second = store.workStatus.report(
      fleet,
      'alpha',
      { state: 'working', work_id: 'TASK-1', summary: 'Retry' },
      300,
    );
    expect(second.attemptId).not.toBe(first.attemptId);
    const summary = derive(400);
    expect(summary.views).toHaveLength(1);
    expect(summary.views[0]).toMatchObject({ attemptId: second.attemptId, workStartedAt: 100 });
    expect(summary.unresolved).toBe(1);
  });
});
