import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveWorkStatus, type WorkActivityObservation } from '../src/core/work-status.js';
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
      '1',
      100,
    );
    expect(first.attemptId).toBeTruthy();
    expect(() =>
      store.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-1', summary: 'Step 2' }, '1', 200),
    ).toThrow('changed structured field');
    expect(() =>
      store.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-2', summary: 'Other' }, '1', 200),
    ).toThrow('current working item');
    const wait = store.workStatus.report(
      fleet,
      'alpha',
      { state: 'waiting', work_id: 'TASK-1', summary: 'CI', waiting_on: 'CI run' },
      '1',
      200,
    );
    expect(wait.attemptId).toBe(first.attemptId);
    expect(
      store.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-2', summary: 'Other' }, '1', 300)
        .attemptId,
    ).not.toBe(first.attemptId);
  });

  it('uses a supplied attempt ID and refuses to bind it to another session', () => {
    const first = store.workStatus.report(
      fleet,
      'alpha',
      { state: 'working', work_id: 'TASK-1', summary: 'Build', attempt_id: 'packet-123' },
      '1',
      100,
    );
    expect(first.attemptId).toBe('packet-123');
    expect(() =>
      store.workStatus.report(
        fleet,
        'beta',
        { state: 'working', work_id: 'TASK-2', summary: 'Build', attempt_id: 'packet-123' },
        '1',
        200,
      ),
    ).toThrow('already bound');
    expect(() =>
      store.workStatus.report(
        fleet,
        'alpha',
        { state: 'waiting', work_id: 'TASK-1', summary: 'Wait', waiting_on: 'CI', attempt_id: 'wrong' },
        '1',
        200,
      ),
    ).toThrow('different attempt');
  });

  it('preserves the original keyed receipt after later reports, audits exact duplicates, and rejects key reuse', () => {
    const report = { state: 'working' as const, work_id: 'TASK-1', summary: 'Build', idempotencyKey: 'request-1' };
    const first = store.workStatus.report(fleet, 'alpha', report, '1', 100);
    expect(store.workStatus.report(fleet, 'alpha', report, '1', 110)).toMatchObject({
      eventId: first.eventId,
      unchanged: true,
    });
    store.workStatus.report(
      fleet,
      'alpha',
      { state: 'waiting', work_id: 'TASK-1', summary: 'CI', waiting_on: 'CI' },
      '1',
      200,
    );
    store.workStatus.report(
      fleet,
      'alpha',
      { state: 'waiting', work_id: 'TASK-1', summary: 'CI', waiting_on: 'CI' },
      '1',
      210,
    );
    expect(store.workStatus.report(fleet, 'alpha', report, '1', 300)).toMatchObject({
      eventId: first.eventId,
      unchanged: true,
    });
    expect(() => store.workStatus.report(fleet, 'alpha', { ...report, summary: 'Different' }, '1', 300)).toThrow(
      'idempotencyKey',
    );
    expect(store.workStatus.events(fleet).filter((event) => event.kind === 'unchanged_report')).toHaveLength(1);
  });

  it('revises a blocker only for a changed question, and rejects late answers', () => {
    store.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-1', summary: 'Build' }, '1', 100);
    const first = store.workStatus.report(fleet, 'alpha', blocked, '1', 200);
    expect(first.blockerRevision).toBe(1);
    expect(() => store.workStatus.report(fleet, 'alpha', { ...blocked, summary: 'No change' }, '1', 250)).toThrow(
      'changed structured field',
    );
    const clarification = store.workStatus.report(fleet, 'alpha', { ...blocked, recommendation: 'Use B' }, '1', 300);
    expect(clarification).toMatchObject({ blockerId: first.blockerId, blockerRevision: 1 });
    const next = store.workStatus.report(fleet, 'alpha', { ...blocked, question: 'Which endpoint?' }, '1', 400);
    expect(next).toMatchObject({ blockerId: first.blockerId, blockerRevision: 2 });
    expect(() =>
      store.workStatus.resolve(
        fleet,
        'TASK-1',
        'A',
        { attemptId: first.attemptId, blockerId: first.blockerId!, blockerRevision: 1 },
        500,
      ),
    ).toThrow('changed before resolution');
    const answer = store.workStatus.resolve(
      fleet,
      'TASK-1',
      'Use endpoint B',
      { attemptId: next.attemptId, blockerId: next.blockerId!, blockerRevision: 2 },
      500,
    );
    expect(answer).toMatchObject({ targetClaimEventId: next.eventId, blockerRevision: 2, question: 'Which endpoint?' });
    expect(store.getMessage(answer.messageId)).toMatchObject({ recipient: 'alpha', status: 'pending' });
    expect(
      store.workStatus.report(
        fleet,
        'alpha',
        { state: 'working', work_id: 'TASK-1', summary: 'Implementing' },
        '1',
        600,
      ).attemptId,
    ).toBe(first.attemptId);
  });

  it('binds a short resolution to the exact claim event and rejects an intervening clarification', () => {
    store.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-1', summary: 'Build' }, '1', 100);
    const first = store.workStatus.report(fleet, 'alpha', blocked, '1', 200);
    const staleTarget = {
      attemptId: first.attemptId,
      blockerId: first.blockerId!,
      blockerRevision: first.blockerRevision!,
      targetClaimEventId: first.eventId,
    };
    store.workStatus.report(fleet, 'alpha', { ...blocked, recommendation: 'Use B' }, '1', 300);
    expect(() => store.workStatus.resolve(fleet, 'TASK-1', 'A', staleTarget, 400)).toThrow('changed before resolution');
    expect(store.workStatus.events(fleet).filter((event) => event.kind === 'blocker_resolved')).toHaveLength(0);
  });

  it('requires evidence identifying done output, permits new evidence, and bars failed amendments', () => {
    store.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-1', summary: 'Review' }, '1', 100);
    expect(() =>
      store.workStatus.report(
        fleet,
        'alpha',
        { state: 'done', work_id: 'TASK-1', summary: 'Reviewed', evidence: [] },
        '1',
        200,
      ),
    ).toThrow('evidence');
    const first = store.workStatus.report(
      fleet,
      'alpha',
      { state: 'done', work_id: 'TASK-1', summary: 'Reviewed', evidence: ['review://123'] },
      '1',
      200,
    );
    const amended = store.workStatus.report(
      fleet,
      'alpha',
      { state: 'done', work_id: 'TASK-1', summary: 'Reviewed', evidence: ['review://123', 'comment://456'] },
      '1',
      300,
    );
    expect(amended.eventId).not.toBe(first.eventId);
    expect(() =>
      store.workStatus.report(
        fleet,
        'alpha',
        { state: 'failed', work_id: 'TASK-1', summary: 'No', reason: 'No' },
        '1',
        400,
      ),
    ).toThrow('closed');
  });

  it('rejects ambiguous short blocker resolution and leaves delivery durable', () => {
    for (const session of ['alpha', 'beta']) {
      store.workStatus.report(fleet, session, { state: 'working', work_id: 'TASK-1', summary: 'Build' }, '1', 100);
      store.workStatus.report(fleet, session, blocked, '1', 200);
    }
    expect(() => store.workStatus.currentBlocker(fleet, 'TASK-1')).toThrow('Ambiguous');
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
      store.workStatus.events(fleet),
      () => observation,
      () => true,
      now,
      limits,
    );

  it('keeps state and work age across same-state updates and pause, with unknown telemetry', () => {
    store.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-1', summary: 'Build' }, '1', 100);
    store.workStatus.report(
      fleet,
      'alpha',
      { state: 'waiting', work_id: 'TASK-1', summary: 'CI', waiting_on: 'CI run 1' },
      '1',
      200,
    );
    store.workStatus.report(
      fleet,
      'alpha',
      { state: 'waiting', work_id: 'TASK-1', summary: 'CI', waiting_on: 'CI run 2' },
      '1',
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
    expect(status.activeUnits).toBe(1);
  });

  it('shows disagreement at one hour, stale later, and keeps failed work unresolved', () => {
    store.workStatus.report(fleet, 'alpha', { state: 'working', work_id: 'TASK-1', summary: 'Build' }, '1', 100);
    const now = 3_600_101;
    const idle: WorkActivityObservation = {
      processActive: true,
      processObservedAt: now,
      activity: 'idle',
      activityObservedAt: now,
      idleSince: 100,
    };
    expect(derive(now, idle).views[0]).toMatchObject({ disagreement: true, stale: false, attentionBand: 1 });
    const later = 14_400_101;
    expect(derive(later, { ...idle, processObservedAt: later, activityObservedAt: later }).views[0]).toMatchObject({
      disagreement: true,
      stale: true,
    });
    store.workStatus.report(
      fleet,
      'alpha',
      { state: 'failed', work_id: 'TASK-1', summary: 'Failed', reason: 'Build failed' },
      '1',
      later,
    );
    expect(derive(later).startedUnresolved).toBe(1);
  });
});
