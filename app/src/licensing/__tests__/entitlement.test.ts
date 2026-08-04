/**
 * Gotcha 1, pinned.
 *
 * These are the two responses that were confirmed by live test against the
 * sandbox and that contradict the service's documented reason codes. Both would
 * be implemented wrongly by anyone working from the reason list alone, so each
 * gets an explicit test naming the wrong implementation it exists to prevent.
 */

import {
  entitlementReason,
  isEnrichmentEntitled,
  normaliseInvalidReason,
  resolveEntitlement,
} from 'src/licensing/entitlement';
import { validationResponse } from 'src/licensing/__tests__/fixtures';
import { describe, expect, it } from 'vitest';

describe('gotcha 1 — valid and hasFeature are independent', () => {
  it('should refuse enrichment on a valid rules-only licence (valid: true, hasFeature: false)', () => {
    // The exact observed response: asking a Greenlight Rules Only licence about
    // `enrichment` returns a *healthy* licence that simply lacks the feature.
    // There is no `feature_not_licensed` reason on the wire — reason is null.
    const response = validationResponse({
      valid: true,
      reason: null,
      hasFeature: false,
      features: ['rules'],
      tier: 'Rules',
    });

    expect(isEnrichmentEntitled(response)).toBe(false);

    // The naive `if (res.valid)` check would have enabled the paid feature here.
    expect(response.valid).toBe(true);
  });

  it('should derive the feature_not_licensed reason the service never sends', () => {
    const response = validationResponse({ hasFeature: false, reason: null });

    expect(response.reason).toBeNull();
    expect(entitlementReason(response)).toBe('feature_not_licensed');
  });

  it('should refuse enrichment on a suspended licence that still reports hasFeature: true', () => {
    // The other observed response: suspension does not strip the feature list.
    const response = validationResponse({
      valid: false,
      reason: 'suspended',
      hasFeature: true,
    });

    expect(isEnrichmentEntitled(response)).toBe(false);

    // The naive `if (res.hasFeature)` check would have kept enrichment running
    // on a suspended licence, making suspension useless as a billing lever.
    expect(response.hasFeature).toBe(true);
  });

  it('should report the licence problem, not the feature, when a suspended licence has the feature', () => {
    const response = validationResponse({
      valid: false,
      reason: 'suspended',
      hasFeature: true,
    });

    expect(entitlementReason(response)).toBe('suspended');
    expect(entitlementReason(response)).not.toBe('feature_not_licensed');
  });

  it('should only entitle enrichment when both booleans are true', () => {
    const table: { valid: boolean; hasFeature: boolean; entitled: boolean }[] = [
      { valid: true, hasFeature: true, entitled: true },
      { valid: true, hasFeature: false, entitled: false },
      { valid: false, hasFeature: true, entitled: false },
      { valid: false, hasFeature: false, entitled: false },
    ];

    for (const row of table) {
      expect(isEnrichmentEntitled(row)).toBe(row.entitled);
    }
  });
});

describe('invalid reason normalisation', () => {
  it('should pass through every documented reason code', () => {
    for (const reason of [
      'revoked',
      'suspended',
      'expired',
      'device_not_activated',
      'feature_not_licensed',
      'quota_exceeded',
    ]) {
      expect(normaliseInvalidReason(reason)).toBe(reason);
    }
  });

  it('should map an unknown or absent reason to invalid_licence', () => {
    expect(normaliseInvalidReason('something_new_numaya_shipped')).toBe(
      'invalid_licence',
    );
    expect(normaliseInvalidReason(null)).toBe('invalid_licence');
  });
});

describe('gotcha 4 — license_not_found is an environment problem, not a bad key', () => {
  it('should not let the service reason fall through to invalid_licence', () => {
    // Verbatim from the live service: a sandbox licence validated without the
    // `X-Numaya-Environment: sandbox` header. HTTP 200, a plausible rejection,
    // and a licenceId of all zeros because no record was resolved.
    const response = validationResponse({
      valid: false,
      reason: 'license_not_found',
      hasFeature: false,
      features: [],
      tier: null,
      licenceType: 'Perpetual',
      status: 'Revoked',
      daysRemaining: null,
      expiryAt: null,
    });

    expect(entitlementReason(response)).toBe('licence_not_found_in_environment');

    // The failure this replaces: `invalid_licence` renders as "check the key in
    // the app settings for a typo", which is the one action guaranteed not to
    // fix it.
    expect(entitlementReason(response)).not.toBe('invalid_licence');
  });

  it('should accept the service spelling regardless of case or padding', () => {
    for (const raw of ['license_not_found', 'LICENSE_NOT_FOUND', ' license_not_found ']) {
      expect(normaliseInvalidReason(raw)).toBe('licence_not_found_in_environment');
    }
  });

  it('should leave every other invalid reason exactly where it was', () => {
    // A licence that *was* found and is suspended must keep reading as
    // suspended. Widening the not-found branch would hide real licence states
    // behind a configuration message.
    for (const reason of ['suspended', 'expired', 'revoked', 'quota_exceeded']) {
      expect(normaliseInvalidReason(reason)).toBe(reason);
    }

    expect(normaliseInvalidReason('licence_not_found')).toBe('invalid_licence');
  });

  it('should still refuse enrichment, because fail-open is about scoring only', () => {
    expect(
      isEnrichmentEntitled({ valid: false, hasFeature: false }),
    ).toBe(false);
  });
});

describe('resolveEntitlement', () => {
  it('should answer both questions from one response', () => {
    expect(resolveEntitlement(validationResponse())).toEqual({
      entitled: true,
      reason: 'licensed',
    });
  });
});
