/**
 * Shared fixtures for the licensing tests.
 *
 * The two keys below are **synthetic**. They are shaped exactly like a real
 * Numaya key so the secret-containment tests scan for a realistically shaped
 * value rather than for `'test-key'`, which any masking bug would trivially
 * pass — but they are not issued, belong to no organisation, and grant nothing.
 *
 * They were real Sandbox keys until 2026-08-04. That was wrong for two reasons,
 * and neither was about the sandbox org's exposure:
 *
 *   1. This repo is intended to go public for npm provenance. A real key in the
 *      source tree becomes a published key, and `git rm` does not remove it from
 *      history.
 *   2. Nothing here needs a key to be real. No test in this folder makes a
 *      network call — `LicensingPort` is a port for exactly that reason — so the
 *      only property these values need is their *shape*.
 *
 * Keep them synthetic. If a test ever genuinely needs a live key, it belongs in
 * an integration suite that reads it from the environment, never from source.
 */

import {
  type CachedLicenceValidation,
  type LicenceActivateOutcome,
  type LicenceValidateOutcome,
  type LicenceValidationResponse,
  type LicensingPort,
} from 'src/licensing/types';

/** Synthetic. Stands in for a Trial licence: features `rules` + `enrichment`. */
export const SANDBOX_TRIAL_KEY = 'NUMAYA-T3ST0-TR14L-K3Y00-A';

/** Synthetic. Stands in for a Rules Only licence: feature `rules`. */
export const SANDBOX_RULES_ONLY_KEY = 'NUMAYA-T3ST0-RUL3S-K3Y00-B';

export const NOW = new Date('2026-08-02T12:00:00.000Z');

export const hoursBefore = (hours: number): Date =>
  new Date(NOW.getTime() - hours * 3_600_000);

/**
 * The verified Trial response from the live smoke test, field for field.
 * Overrides let each test vary exactly one thing.
 */
export const validationResponse = (
  overrides: Partial<LicenceValidationResponse> = {},
): LicenceValidationResponse => ({
  valid: true,
  reason: null,
  hasFeature: true,
  features: ['rules', 'enrichment'],
  tier: 'Pro',
  licenceType: 'Trial',
  status: 'Active',
  daysRemaining: 14,
  expiryWarning: false,
  expiryAt: '2026-08-16T09:58:42.729898Z',
  activatedCount: 0,
  maxActivations: 1,
  inGracePeriod: false,
  // Absent from every live response; `null`/`false` is what the tolerant parser
  // produces for them, so that is what the fixture asserts against.
  gracePeriodDaysRemaining: null,
  maintenanceExpired: false,
  maintenanceExpiryAt: null,
  // Present on every live response and absent from the published schema — the
  // exact reverse of the three fields above.
  licenceId: 'ba3b3604-9c2e-47b1-b705-1d0a19df5a62',
  // No calibration by default: a licence issued before calibration existed is
  // the majority case and the one every pre-existing test is written against.
  customerMetadata: undefined,
  ...overrides,
});

export const cachedEntitlement = (
  overrides: Partial<CachedLicenceValidation> = {},
): CachedLicenceValidation => ({
  cachedAt: hoursBefore(1).toISOString(),
  maskedKey: 'NUMAYA-*****-*****-*****-* #00000000',
  valid: true,
  hasFeature: true,
  reason: null,
  features: ['rules', 'enrichment'],
  tier: 'Pro',
  daysRemaining: 14,
  expiryWarning: false,
  expiryAt: '2026-08-16T09:58:42.729898Z',
  ...overrides,
});

export interface FakeLicensingPort extends LicensingPort {
  readonly calls: { method: 'validate' | 'activate'; key: string }[];
}

export const fakeLicensingPort = (
  validateOutcome: LicenceValidateOutcome,
  activateOutcome: LicenceActivateOutcome = { kind: 'activated', activationId: 'act-1' },
): FakeLicensingPort => {
  const calls: { method: 'validate' | 'activate'; key: string }[] = [];

  return {
    calls,
    validate: async ({ key }) => {
      calls.push({ method: 'validate', key });

      return validateOutcome;
    },
    activate: async ({ key }) => {
      calls.push({ method: 'activate', key });

      return activateOutcome;
    },
  };
};
