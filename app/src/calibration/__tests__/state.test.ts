/**
 * The calibration freshness ladder, row by row.
 *
 * The boundary that matters is 72h rather than 24h: calibration deliberately
 * outlives the entitlement's window because a word list carries none of the
 * revocation risk an entitlement does. See the table in `state.ts`.
 */

import {
  CALIBRATION_MAX_AGE_MS,
  countCalibration,
  resolveCalibration,
} from 'src/calibration/state';
import {
  type CachedCalibration,
  type Calibration,
} from 'src/calibration/types';
import { describe, expect, it } from 'vitest';

const NOW = new Date('2026-08-02T12:00:00.000Z');

const msBefore = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();

const HOUR_MS = 3_600_000;

const calibration = (overrides: Partial<Calibration> = {}): Calibration => ({
  schemaVersion: 1,
  calibrationVersion: 9,
  issuedAt: '2026-07-30T09:00:00.000Z',
  notes: null,
  decisionMakerTitles: ['ceo', 'geschäftsführer', 'sócio'],
  influencerTitles: ['manager', 'projektleiter'],
  roleInboxLocalParts: ['info'],
  placeholderValues: ['n/a', 'tbd', 'unknown', 'xxx'],
  industrySynonyms: { construction: ['bau', 'bauwesen'], software: ['saas'] },
  ...overrides,
});

const cached = (overrides: Partial<CachedCalibration> = {}): CachedCalibration => ({
  cachedAt: msBefore(HOUR_MS),
  verifiedAt: msBefore(HOUR_MS),
  keyId: 'greenlight-calibration-1',
  sealTag: 'dGFn',
  calibration: calibration(),
  ...overrides,
});

describe('resolveCalibration — no cache', () => {
  it('reports shipped defaults with no calibration to apply', () => {
    const resolved = resolveCalibration({ cached: null, now: NOW });

    expect(resolved.state.status).toBe('shipped_defaults');
    expect(resolved.state.reason).toBe('not_provisioned');
    expect(resolved.state.source).toBe('none');
    expect(resolved.calibration).toBeNull();
  });

  it('nulls every field that would describe a payload', () => {
    // "There is no calibration" and "there is a calibration with nothing in it"
    // must not render the same in the admin panel, and a zero count is exactly
    // how the second one would look.
    const { state } = resolveCalibration({ cached: null, now: NOW });

    expect(state.calibrationVersion).toBeNull();
    expect(state.issuedAt).toBeNull();
    expect(state.refreshedAt).toBeNull();
    expect(state.cacheAgeMs).toBeNull();
    expect(state.keyId).toBeNull();
    expect(state.counts).toBeNull();
    expect(state.checkedAt).toBe(NOW.toISOString());
  });
});

describe('resolveCalibration — a usable cache', () => {
  it('serves an hour-old cache as calibrated from cache', () => {
    const entry = cached();
    const resolved = resolveCalibration({ cached: entry, now: NOW });

    expect(resolved.state.status).toBe('calibrated');
    expect(resolved.state.reason).toBe('calibrated');
    expect(resolved.state.source).toBe('cache');
    expect(resolved.state.cacheAgeMs).toBe(HOUR_MS);
    expect(resolved.calibration).toBe(entry.calibration);
  });

  it('reports a zero-age cache as live', () => {
    const resolved = resolveCalibration({
      cached: cached({ cachedAt: NOW.toISOString() }),
      now: NOW,
    });

    expect(resolved.state.source).toBe('live');
    expect(resolved.state.cacheAgeMs).toBe(0);
  });

  it('carries the version, key and counts an admin panel needs', () => {
    const entry = cached();
    const { state } = resolveCalibration({ cached: entry, now: NOW });

    expect(state.calibrationVersion).toBe(9);
    expect(state.issuedAt).toBe('2026-07-30T09:00:00.000Z');
    expect(state.refreshedAt).toBe(entry.verifiedAt);
    expect(state.keyId).toBe('greenlight-calibration-1');
    expect(state.counts).toEqual(countCalibration(entry.calibration));
  });

  it('reports an empty issuedAt as null rather than as an empty string', () => {
    const { state } = resolveCalibration({
      cached: cached({ calibration: calibration({ issuedAt: '' }) }),
      now: NOW,
    });

    expect(state.issuedAt).toBeNull();
  });

  it('keeps a cache well past the entitlement’s 24h window', () => {
    // The entitlement tightens at 24h because a stale one risks serving a paid
    // feature to a revoked licence. Calibration is a word list and carries no
    // such risk, so it rides straight through the grace window.
    for (const hours of [24, 48, 71]) {
      const resolved = resolveCalibration({
        cached: cached({ cachedAt: msBefore(hours * HOUR_MS) }),
        now: NOW,
      });

      expect(resolved.state.status, `${hours}h`).toBe('calibrated');
      expect(resolved.calibration, `${hours}h`).not.toBeNull();
    }
  });

  it('is still calibrated one minute before the cliff', () => {
    const resolved = resolveCalibration({
      cached: cached({ cachedAt: msBefore(71 * HOUR_MS + 59 * 60_000) }),
      now: NOW,
    });

    expect(resolved.state.status).toBe('calibrated');
    expect(resolved.state.source).toBe('cache');
    expect(resolved.calibration).not.toBeNull();
  });
});

describe('resolveCalibration — past the cliff', () => {
  it('retires a cache that is exactly 72h old', () => {
    // Inclusive at the lower edge of the worse band, the same way the licensing
    // ladder rounds — "fresh" has to mean strictly under the limit.
    const resolved = resolveCalibration({
      cached: cached({ cachedAt: msBefore(CALIBRATION_MAX_AGE_MS) }),
      now: NOW,
    });

    expect(resolved.state.status).toBe('shipped_defaults');
    expect(resolved.state.reason).toBe('stale');
    expect(resolved.calibration).toBeNull();
  });

  it('still says which calibration expired and which key signed it', () => {
    // Falling back silently would leave the admin with a panel that cannot
    // explain what changed.
    const { state } = resolveCalibration({
      cached: cached({ cachedAt: msBefore(CALIBRATION_MAX_AGE_MS) }),
      now: NOW,
    });

    expect(state.calibrationVersion).toBe(9);
    expect(state.keyId).toBe('greenlight-calibration-1');
    expect(state.cacheAgeMs).toBe(CALIBRATION_MAX_AGE_MS);
    expect(state.counts).toBeNull();
  });

  it('stays stale however old the cache gets', () => {
    const resolved = resolveCalibration({
      cached: cached({ cachedAt: msBefore(365 * 24 * HOUR_MS) }),
      now: NOW,
    });

    expect(resolved.state.reason).toBe('stale');
    expect(resolved.calibration).toBeNull();
  });

  it.each([
    ['unparseable', 'not a date'],
    ['empty', ''],
  ])('treats a %s cachedAt as stale rather than as fresh', (_label, cachedAt) => {
    // The opposite choice would make a corrupt timestamp mean "trust this
    // forever", which is the one thing a freshness check must never be talked
    // into.
    const resolved = resolveCalibration({ cached: cached({ cachedAt }), now: NOW });

    expect(resolved.state.reason).toBe('stale');
    expect(resolved.state.cacheAgeMs).toBeNull();
    expect(resolved.calibration).toBeNull();
  });

  it('treats a cache written by a clock that is ahead as fresh, not stale', () => {
    const resolved = resolveCalibration({
      cached: cached({ cachedAt: new Date(NOW.getTime() + HOUR_MS).toISOString() }),
      now: NOW,
    });

    expect(resolved.state.source).toBe('live');
    expect(resolved.calibration).not.toBeNull();
  });
});

describe('countCalibration', () => {
  it('counts each list and the number of synonym clusters', () => {
    expect(countCalibration(calibration())).toEqual({
      decisionMakerTitles: 3,
      influencerTitles: 2,
      roleInboxLocalParts: 1,
      placeholderValues: 4,
      // A key count, not a variant count: the panel is reporting how many
      // industries the pack knows about, not how many words it carries.
      industrySynonyms: 2,
    });
  });

  it('counts an empty pack as zeroes', () => {
    expect(
      countCalibration(
        calibration({
          decisionMakerTitles: [],
          influencerTitles: [],
          roleInboxLocalParts: [],
          placeholderValues: [],
          industrySynonyms: {},
        }),
      ),
    ).toEqual({
      decisionMakerTitles: 0,
      influencerTitles: 0,
      roleInboxLocalParts: 0,
      placeholderValues: 0,
      industrySynonyms: 0,
    });
  });
});
