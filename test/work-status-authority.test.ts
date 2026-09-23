import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveWorkStatus, renderWorkStatus } from '../src/core/work-status.js';
import { Store } from '../src/store/index.js';

const fleet = 'fleet-authority';
let store: Store;

beforeEach(() => {
  store = new Store(':memory:');
});
afterEach(() => {
  store.close();
});

function done(workId = 'TASK-1', session = 'worker') {
  store.workStatus.report(fleet, session, { state: 'working', work_id: workId, summary: 'Reviewing' }, 100);
  return store.workStatus.report(
    fleet,
    session,
    { state: 'done', work_id: workId, summary: 'Reviewed', evidence: ['review://123'] },
    200,
  );
}

function views(now = 1000) {
  return deriveWorkStatus(
    store.workStatus.current(fleet),
    () => ({ processActive: null, activity: 'unknown' }),
    () => false,
    now,
    { disagreementMs: 3_600_000, staleMs: 14_400_000, waitingMs: 14_400_000, observationMaxAgeMs: 60_000 },
  );
}

describe('work status authority facts', () => {
  it('attests a non-SHA output against its exact done claim and removes accepted work from the live view', () => {
    const claim = done();
    expect(renderWorkStatus(views(250), 250)).toContain('TASK-1 · done awaiting acceptance');
    const receipt = store.workStatus.accept(fleet, 'TASK-1', 'operator', undefined, 300);
    expect(receipt).toMatchObject({
      targetClaimEventId: claim.eventId,
      evidence: ['review://123'],
      claimEvidence: ['review://123'],
      actor: 'operator',
      attestation: 'attested',
    });
    expect(store.workStatus.events(fleet).at(-1)).toMatchObject({ kind: 'accepted', target_event_id: claim.sequence });
    expect(views().views).toHaveLength(0);
    expect(views().unresolved).toBe(0);
    expect(() =>
      store.workStatus.report(fleet, 'worker', {
        state: 'done',
        work_id: 'TASK-1',
        summary: 'Revised',
        evidence: ['review://456'],
      }),
    ).toThrow('closed');
  });

  it('accepts the latest completion claim after new evidence is reported', () => {
    done();
    const amended = store.workStatus.report(
      fleet,
      'worker',
      { state: 'done', work_id: 'TASK-1', summary: 'Reviewed', evidence: ['review://123', 'comment://456'] },
      300,
    );
    expect(views(350).views[0]).toMatchObject({ stateEnteredAt: 200, workStartedAt: 100 });
    const accepted = store.workStatus.accept(fleet, 'TASK-1', 'operator', 'checks://green', 400);
    expect(accepted).toMatchObject({ targetClaimEventId: amended.eventId, evidence: ['checks://green'] });
  });

  it('records a rejected claim, delivers a protected reason, and permits a new attempt', () => {
    const first = done();
    const rejected = store.workStatus.reject(fleet, 'TASK-1', 'operator', 'Missing tests', 300);
    expect(rejected).toMatchObject({
      targetClaimEventId: first.eventId,
      reason: 'Missing tests',
      claimEvidence: ['review://123'],
    });
    expect(store.getMessage(rejected.messageId!)).toMatchObject({ recipient: 'worker', status: 'pending' });
    expect(store.getMessage(rejected.messageId!)?.content).toContain('Report your next state.');
    expect(views(350)).toMatchObject({ active: 0, unresolved: 1 });
    expect(views(350).views[0]).toMatchObject({ disposition: 'not_accepted', attentionBand: 4 });
    expect(() => store.workStatus.accept(fleet, 'TASK-1', 'operator')).toThrow();
    expect(() =>
      store.workStatus.report(fleet, 'worker', {
        state: 'done',
        work_id: 'TASK-1',
        summary: 'Amended',
        evidence: ['review://456'],
      }),
    ).toThrow('not accepted');
    const retry = store.workStatus.report(
      fleet,
      'worker',
      { state: 'working', work_id: 'TASK-1', summary: 'Fix tests' },
      500,
    );
    expect(retry.attemptId).not.toBe(first.attemptId);
    expect(views(600).views[0]).toMatchObject({ attemptId: retry.attemptId, workStartedAt: 100 });
  });

  it('closes failed work and refuses a second closure', () => {
    store.workStatus.report(fleet, 'worker', { state: 'working', work_id: 'TASK-1', summary: 'Build' }, 100);
    const failed = store.workStatus.report(
      fleet,
      'worker',
      {
        state: 'failed',
        work_id: 'TASK-1',
        summary: 'Failed',
        reason: 'CI',
      },
      200,
    );
    expect(views(300).unresolved).toBe(1);
    const closed = store.workStatus.closeWork(fleet, 'TASK-1', 'operator', 'Cancelled', 400);
    expect(closed).toMatchObject({ targetClaimEventId: failed.eventId, reason: 'Cancelled' });
    expect(views(500).views).toHaveLength(0);
    expect(() => store.workStatus.closeWork(fleet, 'TASK-1', 'operator', 'Again', 600)).toThrow();
  });

  it('keeps a done claim open when rework feedback cannot enter the delivery queue', () => {
    done();
    store.insertDirectMessage('operator', 'worker', 'Existing message');
    expect(() => store.workStatus.reject(fleet, 'TASK-1', 'operator', 'Needs tests', 300, 1)).toThrow('queue');
    expect(store.workStatus.currentDone(fleet, 'TASK-1').row.disposition).toBe('open');
    expect(store.workStatus.events(fleet).filter((event) => event.kind === 'not_accepted')).toHaveLength(0);
  });

  it('rejects ambiguous short actions rather than choosing a session', () => {
    done('TASK-1', 'worker');
    done('TASK-1', 'other');
    expect(() => store.workStatus.currentDone(fleet, 'TASK-1')).toThrow('Ambiguous');
    expect(() => store.workStatus.accept(fleet, 'TASK-1', 'operator')).toThrow('Ambiguous');
  });
});
