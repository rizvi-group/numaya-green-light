import { describe, expect, it } from 'vitest';

import { ALL_RULES } from 'src/scoring';

import {
  ICP_RULE_DIMENSIONS,
  readIcpStatus,
  readReviewState,
} from 'src/icp/icp-status';

/** The seeded record: permissive ICP, everything else at engine defaults. */
const seededRecord = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: 'config-1',
  icpIndustries: [],
  icpRegions: [],
  icpSizeBands: { bands: [] },
  ...overrides,
});

describe('the rule/dimension map', () => {
  it('covers every ICP rule in the catalogue that can carry points', () => {
    // If a release adds a fourth ICP rule and forgets this map, an unconfigured
    // dimension would be reported as configured — the exact error this whole
    // surface exists to prevent. Cheap to guard.
    //
    // A zero-weight pure gate (the excluded-industry block) is exempt: it has
    // no config list that switches it on and can never be idle points, so
    // there is no dimension for it to be missing from. Everything else in the
    // ICP category must map.
    const pointCarryingIcpRuleIds = ALL_RULES.filter(
      (rule) => rule.category === 'icp' && rule.defaultWeight > 0,
    ).map((rule) => rule.id);

    expect(pointCarryingIcpRuleIds.sort()).toEqual(
      Object.keys(ICP_RULE_DIMENSIONS).sort(),
    );
  });
});

describe('readIcpStatus', () => {
  it('reports the seeded config as three idle dimensions worth real points', () => {
    const status = readIcpStatus(seededRecord());

    expect(status.configured).toBe(false);
    expect(status.dimensions).toHaveLength(3);
    expect(status.dimensions.every((one) => one.idle)).toBe(true);
    expect(status.idlePoints).toBe(40);
    expect(status.activePoints).toBe(90);
    expect(status.totalPoints).toBe(130);
    expect(status.idleShare).toBeCloseTo(0.3077, 3);
  });

  it('says what is idle, in points, in one sentence', () => {
    const status = readIcpStatus(seededRecord());

    expect(status.headline).toContain('40 of the 130 points');
    expect(status.headline).toContain('31%');
  });

  it('moves a dimension out of the idle column as soon as it has an entry', () => {
    const status = readIcpStatus(
      seededRecord({ icpIndustries: ['Manufacturing'] }),
    );

    expect(status.configured).toBe(true);
    expect(status.fullyConfigured).toBe(false);
    expect(status.idlePoints).toBe(20);
    expect(status.activePoints).toBe(110);

    const industry = status.dimensions.find(
      (one) => one.ruleId === 'icp.industry',
    );

    expect(industry).toMatchObject({ configured: true, idle: false, entryCount: 1 });
  });

  it('reports a fully configured profile as having nothing idle', () => {
    const status = readIcpStatus(
      seededRecord({
        icpIndustries: ['Manufacturing'],
        icpRegions: ['Germany'],
        icpSizeBands: {
          bands: [{ label: 'smb', minEmployees: 1, maxEmployees: 50 }],
        },
      }),
    );

    expect(status.fullyConfigured).toBe(true);
    expect(status.idlePoints).toBe(0);
    expect(status.idleShare).toBe(0);
    expect(status.headline).toContain('configured and scoring');
  });

  it('does not count a disabled ICP rule as idle points', () => {
    // Switching the rule off is a decision. Points that were deliberately
    // removed from the model are not points sitting unused in it.
    const status = readIcpStatus(
      seededRecord({
        ruleSettings: { 'icp.industry': { enabled: false, severity: 'major' } },
      }),
    );

    expect(status.idlePoints).toBe(20);
    expect(status.totalPoints).toBe(110);
  });

  it('uses the workspace’s own weights rather than the shipped ones', () => {
    const status = readIcpStatus(
      seededRecord({ scoreWeights: { 'icp.industry': 60 } }),
    );

    expect(status.idlePoints).toBe(80);
    expect(status.totalPoints).toBe(170);
  });

  it('treats a missing record as an unreviewed, fully idle profile', () => {
    const status = readIcpStatus(null);

    expect(status.idlePoints).toBe(40);
    expect(status.review.decision).toBe('NOT_REVIEWED');
  });
});

describe('readReviewState', () => {
  it('reads a record with no review columns as never reviewed', () => {
    expect(readReviewState({ id: 'config-1' })).toEqual({
      decision: 'NOT_REVIEWED',
      reviewedAt: null,
    });
  });

  it('reads an applied review', () => {
    expect(
      readReviewState({
        icpReviewDecision: 'APPLIED',
        icpReviewedAt: '2026-08-03T09:00:00.000Z',
      }),
    ).toEqual({
      decision: 'APPLIED',
      reviewedAt: '2026-08-03T09:00:00.000Z',
    });
  });

  it('reads a deliberate decision to leave the profile open', () => {
    expect(readReviewState({ icpReviewDecision: 'left_open' }).decision).toBe(
      'LEFT_OPEN',
    );
  });

  it('falls back to never-reviewed on an unrecognised value', () => {
    expect(readReviewState({ icpReviewDecision: 'MAYBE' }).decision).toBe(
      'NOT_REVIEWED',
    );
    expect(readReviewState('nonsense').decision).toBe('NOT_REVIEWED');
  });
});
