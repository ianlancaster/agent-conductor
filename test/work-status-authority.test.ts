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

function done(workId = 'TASK-1', session = 'worker', artifactRevision?: string) {
  store.workStatus.report(fleet, session, { state: 'working', work_id: workId, summary: 'Reviewing' }, '1', 100);
  return store.workStatus.report(
    fleet,
    session,
    {
      state: 'done',
      work_id: workId,
      summary: 'Reviewed',
      evidence: ['review://123'],
      ...(artifactRevision === undefined ? {} : { artifact_revision: artifactRevision }),
    },
    '1',
    200,
  );
}

function target(workId = 'TASK-1', attemptId?: string) {
  const current = store.workStatus.currentDone(fleet, workId, attemptId);
  const payload = JSON.parse(current.event.payload_json) as { artifact_revision?: string };
  return {
    attemptId: current.row.attempt_id,
    claimEventId: `${fleet}:work-status:${String(current.event.id)}`,
    ...(payload.artifact_revision === undefined ? {} : { artifactRevision: payload.artifact_revision }),
  };
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
  it('attests a non-SHA done output, names the exact claim revision, and closes live WIP', () => {
    const claim = done();
    expect(renderWorkStatus(views(250), 250)).toContain(
      `TASK-1 · ${claim.attemptId} · done awaiting acceptance (claim r1)`,
    );
    const receipt = store.workStatus.accept(fleet, 'TASK-1', 'operator', target(), undefined, 300);
    expect(receipt).toMatchObject({
      targetClaimEventId: claim.eventId,
      claimRevision: 1,
      evidence: ['review://123'],
      claimEvidence: ['review://123'],
      actor: 'operator',
      attestation: 'attested',
    });
    const authorityEvent = store.workStatus.readAfter(fleet, claim.sequence, 5, 'worker').events[0];
    expect(authorityEvent).toMatchObject({ kind: 'accepted', target_event_id: claim.sequence });
    expect(JSON.parse(authorityEvent?.payload_json ?? '{}')).toMatchObject({
      attestation: 'attested',
      evidence: ['review://123'],
    });
    expect(views().views).toHaveLength(0);
    expect(views().startedUnresolved).toBe(0);
    expect(() =>
      store.workStatus.report(
        fleet,
        'worker',
        {
          state: 'done',
          work_id: 'TASK-1',
          summary: 'Reviewed',
          evidence: ['review://456'],
        },
        '1',
        400,
      ),
    ).toThrow('closed');
    expect(() =>
      store.workStatus.report(
        fleet,
        'worker',
        {
          state: 'working',
          work_id: 'TASK-1',
          summary: 'Rework',
        },
        '1',
        400,
      ),
    ).toThrow('closed');
  });

  it('rejects a superseded completion claim and requires an exact cited artifact revision', () => {
    done('TASK-1', 'worker', 'sha-1');
    const old = target();
    const amended = store.workStatus.report(
      fleet,
      'worker',
      {
        state: 'done',
        work_id: 'TASK-1',
        summary: 'Reviewed',
        evidence: ['review://123', 'comment://456'],
        artifact_revision: 'sha-1',
      },
      '1',
      300,
    );
    expect(() => store.workStatus.accept(fleet, 'TASK-1', 'operator', old, undefined, 400)).toThrow('changed');
    expect(() =>
      store.workStatus.accept(
        fleet,
        'TASK-1',
        'operator',
        {
          ...target(),
          artifactRevision: 'wrong-sha',
        },
        undefined,
        400,
      ),
    ).toThrow('changed');
    expect(views(350).views[0]).toMatchObject({ stateEnteredAt: 200, workStartedAt: 100, completionRevision: 2 });
    const accepted = store.workStatus.accept(fleet, 'TASK-1', 'operator', target(), 'checks://green', 400);
    expect(accepted).toMatchObject({
      targetClaimEventId: amended.eventId,
      claimRevision: 2,
      artifactRevision: 'sha-1',
      evidence: ['checks://green'],
    });
  });

  it('records not-accepted with a reason, delivers rework feedback, and permits a new attempt', () => {
    const first = done();
    const rejected = store.workStatus.reject(fleet, 'TASK-1', 'reviewer', 'Missing tests', target(), 300);
    expect(rejected).toMatchObject({
      targetClaimEventId: first.eventId,
      claimRevision: 1,
      reason: 'Missing tests',
      actor: 'reviewer',
      claimEvidence: ['review://123'],
    });
    expect(store.getMessage(rejected.messageId!)).toMatchObject({ recipient: 'worker', status: 'pending' });
    expect(views(350)).toMatchObject({ activeAttempts: 0, startedUnresolved: 1 });
    expect(views(350).views[0]).toMatchObject({ disposition: 'not_accepted', attentionBand: 2 });
    expect(() => store.workStatus.accept(fleet, 'TASK-1', 'operator', target(), undefined, 400)).toThrow();
    expect(() =>
      store.workStatus.report(
        fleet,
        'worker',
        {
          state: 'done',
          work_id: 'TASK-1',
          summary: 'Amended',
          evidence: ['review://456'],
        },
        '1',
        400,
      ),
    ).toThrow('not accepted');
    const retry = store.workStatus.report(
      fleet,
      'worker',
      {
        state: 'working',
        work_id: 'TASK-1',
        summary: 'Fix tests',
      },
      '1',
      500,
    );
    expect(retry.attemptId).not.toBe(first.attemptId);
    expect(views(600).views[0]).toMatchObject({ attemptId: retry.attemptId, workStartedAt: 100 });
  });

  it('closes failed work with a reason and rejects a stale exact closure', () => {
    store.workStatus.report(fleet, 'worker', { state: 'working', work_id: 'TASK-1', summary: 'Build' }, '1', 100);
    const failed = store.workStatus.report(
      fleet,
      'worker',
      {
        state: 'failed',
        work_id: 'TASK-1',
        summary: 'Failed',
        reason: 'CI',
      },
      '1',
      200,
    );
    expect(
      store.workStatus.report(
        fleet,
        'worker',
        {
          state: 'failed',
          work_id: 'TASK-1',
          summary: 'Failed',
          reason: 'CI',
        },
        '1',
        250,
      ),
    ).toMatchObject({ eventId: failed.eventId, unchanged: true });
    expect(views(300).startedUnresolved).toBe(1);
    const bound = { attemptId: failed.attemptId, claimEventId: failed.eventId };
    const closed = store.workStatus.closeWork(fleet, 'TASK-1', 'operator', 'Cancelled', bound, 400);
    expect(closed).toMatchObject({ targetClaimEventId: failed.eventId, reason: 'Cancelled' });
    expect(views(500).views).toHaveLength(0);
    expect(() => store.workStatus.closeWork(fleet, 'TASK-1', 'operator', 'Again', bound, 600)).toThrow();
    expect(() =>
      store.workStatus.report(
        fleet,
        'worker',
        {
          state: 'working',
          work_id: 'TASK-1',
          summary: 'Retry',
        },
        '1',
        600,
      ),
    ).toThrow('closed');
  });

  it('requires an explicit trusted rebind before a new execution continues an open attempt', () => {
    const first = store.workStatus.report(
      fleet,
      'worker',
      {
        state: 'working',
        work_id: 'TASK-1',
        summary: 'Build',
      },
      '1',
      100,
      undefined,
      'run-1',
    );
    const waiting = store.workStatus.report(
      fleet,
      'worker',
      {
        state: 'waiting',
        work_id: 'TASK-1',
        summary: 'CI',
        waiting_on: 'CI',
      },
      '1',
      150,
      undefined,
      'run-1',
    );
    expect(() =>
      store.workStatus.report(
        fleet,
        'worker',
        {
          state: 'working',
          work_id: 'TASK-1',
          summary: 'Resume build',
        },
        '1',
        200,
        undefined,
        'run-2',
      ),
    ).toThrow('trusted rebind');
    expect(() =>
      store.workStatus.rebind(
        fleet,
        'TASK-1',
        'operator',
        'Stale view',
        {
          attemptId: first.attemptId,
          claimEventId: first.eventId,
        },
        'run-2',
        225,
      ),
    ).toThrow('changed');
    const rebound = store.workStatus.rebind(
      fleet,
      'TASK-1',
      'operator',
      'Continued in replacement process',
      { attemptId: first.attemptId, claimEventId: waiting.eventId },
      'run-2',
      250,
    );
    expect(rebound).toMatchObject({ targetClaimEventId: waiting.eventId, actor: 'operator' });
    expect(
      store.workStatus.report(
        fleet,
        'worker',
        {
          state: 'working',
          work_id: 'TASK-1',
          summary: 'Resume build',
        },
        '1',
        300,
        undefined,
        'run-2',
      ).attemptId,
    ).toBe(first.attemptId);
  });

  it('does not rebind a completion claim or failed attempt', () => {
    const completion = done('DONE');
    expect(() =>
      store.workStatus.rebind(
        fleet,
        'DONE',
        'operator',
        'new run',
        {
          attemptId: completion.attemptId,
          claimEventId: completion.eventId,
        },
        'run-2',
      ),
    ).toThrow('open executing attempt');
    store.workStatus.report(fleet, 'worker', { state: 'working', work_id: 'FAILED', summary: 'Build' });
    const failed = store.workStatus.report(fleet, 'worker', {
      state: 'failed',
      work_id: 'FAILED',
      summary: 'Failed',
      reason: 'CI',
    });
    expect(() =>
      store.workStatus.rebind(
        fleet,
        'FAILED',
        'operator',
        'new run',
        {
          attemptId: failed.attemptId,
          claimEventId: failed.eventId,
        },
        'run-2',
      ),
    ).toThrow('open executing attempt');
  });

  it('requires a trusted rebind when an older open attempt has no execution identity', () => {
    const old = store.workStatus.report(
      fleet,
      'worker',
      {
        state: 'working',
        work_id: 'LEGACY',
        summary: 'Build',
      },
      '1',
      100,
    );
    expect(() =>
      store.workStatus.report(
        fleet,
        'worker',
        {
          state: 'waiting',
          work_id: 'LEGACY',
          summary: 'CI',
          waiting_on: 'CI',
        },
        '1',
        200,
        undefined,
        'new-run',
      ),
    ).toThrow('trusted rebind');
    store.workStatus.rebind(
      fleet,
      'LEGACY',
      'operator',
      'Adopt legacy attempt',
      {
        attemptId: old.attemptId,
        claimEventId: old.eventId,
      },
      'new-run',
      250,
    );
    expect(
      store.workStatus.report(
        fleet,
        'worker',
        {
          state: 'waiting',
          work_id: 'LEGACY',
          summary: 'CI',
          waiting_on: 'CI',
        },
        '1',
        300,
        undefined,
        'new-run',
      ).state,
    ).toBe('waiting');
  });

  it('rejects ambiguous short actions and pages the journal by stable scoped sequence', () => {
    done('TASK-1', 'worker');
    done('TASK-1', 'other');
    expect(() => store.workStatus.currentDone(fleet, 'TASK-1')).toThrow('Ambiguous');
    const firstPage = store.workStatus.readAfter(fleet, 0, 2, 'worker');
    expect(firstPage.events).toHaveLength(2);
    expect(firstPage.events[0]?.eventId).toMatch(/^fleet-authority:work-status:\d+$/);
    expect(firstPage.highWater).toBeGreaterThanOrEqual(firstPage.events[1]!.id);
    expect(store.workStatus.readAfter(fleet, firstPage.events[1]!.id, 2, 'worker').events).toHaveLength(0);
    store.workStatus.accept(fleet, 'TASK-1', 'operator', target('TASK-1', firstPage.events[0]?.attempt_id));
    expect(firstPage.highWater).toBeLessThan(store.workStatus.readAfter(fleet, 0, 10, 'worker').highWater);
    expect(store.workStatus.readAfter(fleet, firstPage.events[1]!.id, 2, 'worker').events).toHaveLength(1);
    expect(() => store.workStatus.readAfter(fleet, 0, 501)).toThrow('1–500');
  });
});
