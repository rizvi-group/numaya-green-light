import {
  describeEnrichmentGate,
  enrichmentDisabledReason,
  isDeterministicScoringLicensed,
  isEnrichmentEnabled,
} from 'src/licensing/feature-gate';
import { maskLicenceKey } from 'src/licensing/mask';
import { resolveLicenceState } from 'src/licensing/state';
import { type LicenceState, type LicenceValidateOutcome } from 'src/licensing/types';
import {
  cachedEntitlement,
  hoursBefore,
  NOW,
  SANDBOX_TRIAL_KEY,
  validationResponse,
} from 'src/licensing/__tests__/fixtures';
import { describe, expect, it } from 'vitest';

const state = (
  outcome: LicenceValidateOutcome | null,
  cached: Parameters<typeof resolveLicenceState>[0]['cached'] = null,
  hasKey = true,
): LicenceState =>
  resolveLicenceState({
    presence: { hasKey, maskedKey: maskLicenceKey(SANDBOX_TRIAL_KEY) },
    outcome,
    cached,
    activation: { status: 'unknown' },
    environment: 'production',
    now: NOW,
  }).state;

describe('isEnrichmentEnabled', () => {
  it('should be true only in full mode', () => {
    expect(
      isEnrichmentEnabled(state({ kind: 'validated', response: validationResponse() })),
    ).toBe(true);
  });

  it('should be false for a valid licence without the feature', () => {
    expect(
      isEnrichmentEnabled(
        state({
          kind: 'validated',
          response: validationResponse({ hasFeature: false }),
        }),
      ),
    ).toBe(false);
  });

  it('should be false for a suspended licence that still reports the feature', () => {
    expect(
      isEnrichmentEnabled(
        state({
          kind: 'validated',
          response: validationResponse({
            valid: false,
            reason: 'suspended',
            hasFeature: true,
          }),
        }),
      ),
    ).toBe(false);
  });

  it('should stay true through a short outage covered by the cache', () => {
    expect(
      isEnrichmentEnabled(
        state({ kind: 'transport_failure', detail: 'ENOTFOUND' }, cachedEntitlement()),
      ),
    ).toBe(true);
  });

  it('should go false once the cache leaves the 24h window', () => {
    expect(
      isEnrichmentEnabled(
        state(
          { kind: 'transport_failure', detail: 'ENOTFOUND' },
          cachedEntitlement({ cachedAt: hoursBefore(30).toISOString() }),
        ),
      ),
    ).toBe(false);
  });

  it('should treat a never-published state as disabled', () => {
    // Not knowing whether a workspace is entitled is not the same as knowing it
    // is, and this is a paid capability.
    expect(isEnrichmentEnabled(null)).toBe(false);
    expect(enrichmentDisabledReason(null)).toBe(
      'licence_service_unreachable_grace_expired',
    );
  });
});

describe('enrichmentDisabledReason', () => {
  it('should be null when enrichment is on', () => {
    expect(
      enrichmentDisabledReason(
        state({ kind: 'validated', response: validationResponse() }),
      ),
    ).toBeNull();
  });

  it('should name the derived feature reason for a rules-only licence', () => {
    expect(
      enrichmentDisabledReason(
        state({
          kind: 'validated',
          response: validationResponse({ hasFeature: false }),
        }),
      ),
    ).toBe('feature_not_licensed');
  });
});

describe('describeEnrichmentGate', () => {
  it('should answer everything an enrichment caller needs in one read', () => {
    expect(
      describeEnrichmentGate(
        state({ kind: 'validated', response: validationResponse() }),
      ),
    ).toEqual({ enabled: true, mode: 'full', reason: null });
  });

  it('should degrade safely with no published state', () => {
    expect(describeEnrichmentGate(null).enabled).toBe(false);
    expect(describeEnrichmentGate(null).mode).toBe('rules-only');
  });
});

describe('deterministic scoring is not a licensed capability', () => {
  it('should always be licensed, by construction', () => {
    // Executable documentation. A future change that wants to gate scoring has
    // to delete a function whose name says what it is doing.
    expect(isDeterministicScoringLicensed()).toBe(true);
  });
});
