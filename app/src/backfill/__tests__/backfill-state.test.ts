import { describe, expect, it } from 'vitest';

import {
  BACKFILL_LEASE_MS,
  BACKFILL_MAX_CURSOR_IDS,
  beginBackfill,
  cancelBackfill,
  claimLease,
  commitChunk,
  describeBackfill,
  EMPTY_TALLY,
  isBackfillMode,
  isLeaseHeld,
  releaseLease,
  toBackfillState,
  type BackfillState,
} from 'src/backfill/backfill-state';

const NOW = new Date('2026-08-02T12:00:00.000Z');

const aRun = (): BackfillState =>
  beginBackfill({
    mode: 'unscored',
    now: NOW,
    requestedBy: 'Workspace member 7',
    totalAtStart: 1200,
  });

describe('backfill modes', () => {
  it('should accept only the two shipped modes', () => {
    expect(isBackfillMode('unscored')).toBe(true);
    expect(isBackfillMode('all')).toBe(true);
    expect(isBackfillMode('everything')).toBe(false);
    expect(isBackfillMode(undefined)).toBe(false);
  });
});

describe('beginBackfill', () => {
  it('should start unclaimed so the very next cron tick picks it up', () => {
    expect(aRun().leaseUntil).toBeNull();
  });

  it('should start at the beginning of the walk', () => {
    expect(aRun().cursor).toEqual({ createdAt: null, ids: [] });
    expect(aRun().tally).toEqual(EMPTY_TALLY);
  });

  it('should derive a run id from the start instant, needing no random source', () => {
    expect(aRun().runId).toBe('backfill-2026-08-02T12:00:00.000Z');
  });
});

describe('toBackfillState', () => {
  it('should round-trip a state through JSON, which is what key-value storage does', () => {
    const state = commitChunk(claimLease(aRun(), NOW), {
      now: NOW,
      cursor: { createdAt: '2025-01-01T00:00:00.000Z', ids: ['a'] },
      tally: { ...EMPTY_TALLY, examined: 30, scored: 28, failed: 2 },
      lastError: null,
      exhausted: false,
      stalled: false,
    });

    expect(toBackfillState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it('should refuse anything that is not a state at all', () => {
    expect(toBackfillState(null)).toBeNull();
    expect(toBackfillState('running')).toBeNull();
    expect(toBackfillState([])).toBeNull();
    expect(toBackfillState({})).toBeNull();
  });

  it('should refuse an unrecognised status rather than repairing it', () => {
    // A corrupt status is the one field that must not be guessed: guessing
    // "running" keeps a cron loop alive against a cursor nobody can interpret.
    expect(
      toBackfillState({ ...aRun(), status: 'paused' }),
    ).toBeNull();
  });

  it('should refuse an unrecognised mode', () => {
    expect(toBackfillState({ ...aRun(), mode: 'everything' })).toBeNull();
  });

  it('should default cosmetic fields rather than refusing over them', () => {
    const state = toBackfillState({
      status: 'running',
      mode: 'all',
      startedAt: '2026-01-01T00:00:00.000Z',
      tally: { examined: 'lots' },
      cursor: { ids: [1, 'keep', null] },
      chunks: -4,
    });

    expect(state?.tally).toEqual(EMPTY_TALLY);
    expect(state?.cursor).toEqual({ createdAt: null, ids: ['keep'] });
    expect(state?.chunks).toBe(0);
    expect(state?.totalAtStart).toBeNull();
  });
});

describe('the lease', () => {
  it('should not be held on a fresh run', () => {
    expect(isLeaseHeld(aRun(), NOW)).toBe(false);
  });

  it('should be held for exactly the lease window after being claimed', () => {
    const claimed = claimLease(aRun(), NOW);

    expect(isLeaseHeld(claimed, new Date(NOW.getTime() + 1))).toBe(true);
    expect(
      isLeaseHeld(claimed, new Date(NOW.getTime() + BACKFILL_LEASE_MS - 1)),
    ).toBe(true);
  });

  it('should expire, so a tick the platform killed cannot deadlock the run', () => {
    const claimed = claimLease(aRun(), NOW);

    expect(
      isLeaseHeld(claimed, new Date(NOW.getTime() + BACKFILL_LEASE_MS + 1)),
    ).toBe(false);
  });

  it('should treat an unparseable lease as expired', () => {
    expect(isLeaseHeld({ ...aRun(), leaseUntil: 'soon' }, NOW)).toBe(false);
  });

  it('should be released without disturbing the position', () => {
    const claimed = claimLease(aRun(), NOW);
    const released = releaseLease(claimed, NOW, 'page query failed');

    expect(released.leaseUntil).toBeNull();
    expect(released.cursor).toEqual(claimed.cursor);
    expect(released.status).toBe('running');
    expect(released.lastError).toBe('page query failed');
  });
});

describe('commitChunk', () => {
  const claimed = claimLease(aRun(), NOW);

  const commit = (exhausted: boolean) =>
    commitChunk(claimed, {
      now: new Date(NOW.getTime() + 30_000),
      cursor: { createdAt: '2025-06-01T00:00:00.000Z', ids: ['x'] },
      tally: { examined: 30, scored: 25, unchanged: 3, skipped: 1, failed: 1 },
      lastError: null,
      exhausted,
      stalled: false,
    });

  it('should release the lease so the next tick is not blocked behind it', () => {
    expect(commit(false).leaseUntil).toBeNull();
  });

  it('should accumulate the tally across chunks rather than replacing it', () => {
    const twice = commitChunk(claimLease(commit(false), NOW), {
      now: NOW,
      cursor: { createdAt: '2025-07-01T00:00:00.000Z', ids: [] },
      tally: { examined: 10, scored: 10, unchanged: 0, skipped: 0, failed: 0 },
      lastError: null,
      exhausted: false,
      stalled: false,
    });

    expect(twice.tally.examined).toBe(40);
    expect(twice.tally.scored).toBe(35);
    expect(twice.chunks).toBe(2);
  });

  it('should stay running until the page proves the walk is over', () => {
    expect(commit(false).status).toBe('running');
    expect(commit(false).finishedAt).toBeNull();
    expect(commit(true).status).toBe('completed');
    expect(commit(true).finishedAt).toBe('2026-08-02T12:00:30.000Z');
  });

  it('should cap the boundary id set rather than letting one import unbound it', () => {
    const ids = Array.from({ length: BACKFILL_MAX_CURSOR_IDS + 50 }, (_, i) =>
      String(i),
    );

    const committed = commitChunk(claimed, {
      now: NOW,
      cursor: { createdAt: '2025-06-01T00:00:00.000Z', ids },
      tally: EMPTY_TALLY,
      lastError: null,
      exhausted: false,
      stalled: false,
    });

    expect(committed.cursor.ids).toHaveLength(BACKFILL_MAX_CURSOR_IDS);
    // Keeps the newest, which are the ones the next page will collide with.
    expect(committed.cursor.ids[committed.cursor.ids.length - 1]).toBe(
      String(ids.length - 1),
    );
  });

  it('should fail a run that has stopped advancing, rather than let it spin', () => {
    const stall = (state: BackfillState) =>
      commitChunk(state, {
        now: NOW,
        cursor: state.cursor,
        tally: EMPTY_TALLY,
        lastError: null,
        exhausted: false,
        stalled: true,
      });

    const once = stall(aRun());
    const twice = stall(once);
    const thrice = stall(twice);

    expect(once.status).toBe('running');
    expect(twice.status).toBe('running');
    // A run that reported "running" forever while achieving nothing would be
    // the same defect as an empty gate queue over an unscored workspace.
    expect(thrice.status).toBe('failed');
    expect(thrice.finishedAt).toBe(NOW.toISOString());
    expect(thrice.lastError).toContain('stopped making progress');
  });

  it('should forget a stall as soon as a tick gets through something', () => {
    const stalled = commitChunk(aRun(), {
      now: NOW,
      cursor: { createdAt: null, ids: [] },
      tally: EMPTY_TALLY,
      lastError: null,
      exhausted: false,
      stalled: true,
    });

    expect(stalled.stalls).toBe(1);
    expect(commitChunk(stalled, {
      now: NOW,
      cursor: { createdAt: null, ids: [] },
      tally: { ...EMPTY_TALLY, examined: 1 },
      lastError: null,
      exhausted: false,
      stalled: false,
    }).stalls).toBe(0);
  });
});

describe('cancelBackfill', () => {
  it('should stop the run and leave no lease behind', () => {
    const cancelled = cancelBackfill(
      claimLease(aRun(), NOW),
      NOW,
      'Workspace member 9',
    );

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.leaseUntil).toBeNull();
    expect(cancelled.finishedAt).toBe(NOW.toISOString());
    expect(cancelled.requestedBy).toBe('Workspace member 9');
  });
});

describe('describeBackfill', () => {
  const progressed = (examined: number, minutes: number): BackfillState =>
    commitChunk(claimLease(aRun(), NOW), {
      now: new Date(NOW.getTime() + minutes * 60_000),
      cursor: { createdAt: null, ids: [] },
      tally: { ...EMPTY_TALLY, examined, scored: examined },
      lastError: null,
      exhausted: false,
      stalled: false,
    });

  it('should report percentage against the snapshot taken at the start', () => {
    expect(describeBackfill(progressed(600, 20), NOW).percent).toBe(50);
  });

  it('should cap the percentage rather than showing more than 100', () => {
    // Records created *during* a run are walked too, so the honest arithmetic
    // can exceed the denominator. A bar reading 114% is a bug report.
    expect(describeBackfill(progressed(1400, 40), NOW).percent).toBe(100);
  });

  it('should report no percentage when the count was never available', () => {
    const noTotal = beginBackfill({
      mode: 'all',
      now: NOW,
      requestedBy: 'install',
      totalAtStart: null,
    });

    expect(describeBackfill(noTotal, NOW).percent).toBeNull();
  });

  it('should estimate from the rate actually achieved, not the nominal one', () => {
    // 600 of 1200 in 20 minutes is 30/min; the remaining 600 is 20 more minutes.
    expect(describeBackfill(progressed(600, 20), NOW).minutesRemaining).toBe(20);
  });

  it('should not estimate for a run that is no longer going', () => {
    const done = cancelBackfill(progressed(600, 20), NOW, 'admin');

    expect(describeBackfill(done, NOW).minutesRemaining).toBeNull();
  });

  it('should say whether a tick is working right now', () => {
    expect(describeBackfill(claimLease(aRun(), NOW), NOW).working).toBe(true);
    expect(describeBackfill(aRun(), NOW).working).toBe(false);
  });
});
