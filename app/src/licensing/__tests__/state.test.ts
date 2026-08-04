/**
 * The decision table in `state.ts`, exercised row by row.
 *
 * Two invariants are asserted on *every* case rather than in one place:
 * the mode is always one of `full` / `rules-only` (there is no "off"), and the
 * key never appears in the resolved state.
 */

import { maskLicenceKey } from 'src/licensing/mask';
import { resolveLicenceState } from 'src/licensing/state';
import {
  type LicenceActivationState,
  type LicenceCallFailure,
  type LicenceState,
  type LicenceValidateOutcome,
} from 'src/licensing/types';
import {
  cachedEntitlement,
  hoursBefore,
  NOW,
  SANDBOX_TRIAL_KEY,
  validationResponse,
} from 'src/licensing/__tests__/fixtures';
import { describe, expect, it } from 'vitest';

const UNKNOWN_ACTIVATION: LicenceActivationState = { status: 'unknown' };

const resolve = (
  outcome: LicenceValidateOutcome | null,
  cached: Parameters<typeof resolveLicenceState>[0]['cached'] = null,
  activation: LicenceActivationState = UNKNOWN_ACTIVATION,
  hasKey = true,
): LicenceState =>
  resolveLicenceState({
    presence: { hasKey, maskedKey: maskLicenceKey(SANDBOX_TRIAL_KEY) },
    outcome,
    cached,
    activation,
    environment: 'production',
    now: NOW,
  }).state;

const FAILURES: LicenceCallFailure[] = [
  { kind: 'transport_failure', detail: 'FetchError: ENOTFOUND license.numaya.ai' },
  { kind: 'service_unavailable', statusCode: 503 },
  { kind: 'rate_limited', retryAfterSeconds: 60 },
  { kind: 'malformed_response', detail: 'response has no boolean "valid" field' },
  { kind: 'unexpected_status', statusCode: 404 },
];

/* -------------------------------------------------------------------------- */
/* Definitive failures — the service answering, not the service being down     */
/* -------------------------------------------------------------------------- */

describe('gotcha 4 — a misrouted environment does not walk the cache ladder', () => {
  it('should resolve a 200 license_not_found to the environment reason', () => {
    const state = resolve({
      kind: 'validated',
      response: validationResponse({
        valid: false,
        reason: 'license_not_found',
        hasFeature: false,
      }),
    });

    expect(state.reason).toBe('licence_not_found_in_environment');
    expect(state.mode).toBe('rules-only');
    expect(state.severity).toBe('problem');
  });

  it('should carry the environment that was asked into the state', () => {
    expect(resolve(null, null, UNKNOWN_ACTIVATION, false).environment).toBe(
      'production',
    );

    expect(
      resolveLicenceState({
        presence: { hasKey: true, maskedKey: 'mask' },
        outcome: { kind: 'validated', response: validationResponse() },
        cached: null,
        activation: UNKNOWN_ACTIVATION,
        environment: 'sandbox',
        now: NOW,
      }).state.environment,
    ).toBe('sandbox');
  });

  it('should not serve a fresh cache over a definitive answer', () => {
    // The ladder exists to ride out an outage. There is no outage to ride out
    // when the service has told us the key is refused or the licence is not in
    // this environment — and serving `full` from cache for another 24 hours
    // would only delay the notice that fixes it.
    for (const failure of [
      { kind: 'key_rejected', statusCode: 401 },
      { kind: 'licence_not_found', statusCode: 404 },
    ] as const) {
      const state = resolve(failure, cachedEntitlement());

      expect(state.mode, failure.kind).toBe('rules-only');
      expect(state.source, failure.kind).toBe('none');
      expect(state.failureKind, failure.kind).toBe(failure.kind);
    }
  });

  it('should read a 401 as a refused key and a 404 on activate as a wrong environment', () => {
    expect(resolve({ kind: 'key_rejected', statusCode: 401 }).reason).toBe(
      'invalid_licence',
    );
    expect(resolve({ kind: 'licence_not_found', statusCode: 404 }).reason).toBe(
      'licence_not_found_in_environment',
    );
  });

  it('should never write the cache on a definitive failure', () => {
    expect(
      resolveLicenceState({
        presence: { hasKey: true, maskedKey: 'mask' },
        outcome: { kind: 'key_rejected', statusCode: 401 },
        cached: cachedEntitlement(),
        activation: UNKNOWN_ACTIVATION,
        environment: 'production',
        now: NOW,
      }).cacheWrite,
    ).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* No key                                                                      */
/* -------------------------------------------------------------------------- */

describe('no licence key', () => {
  it('should run rules-only without calling anything', () => {
    const state = resolve(null, null, UNKNOWN_ACTIVATION, false);

    expect(state.mode).toBe('rules-only');
    expect(state.reason).toBe('no_licence_key');
    expect(state.source).toBe('none');
  });

  it('should treat running unlicensed as a notice, not a problem', () => {
    // Rules-only is the free floor and a supported configuration. Rendering it
    // in red would train admins to ignore red.
    expect(resolve(null, null, UNKNOWN_ACTIVATION, false).severity).toBe('notice');
  });

  it('should not report a stale activation limit when there is no key', () => {
    const state = resolve(
      null,
      null,
      { status: 'limit_reached', at: NOW.toISOString() },
      false,
    );

    expect(state.reason).toBe('no_licence_key');
  });
});

/* -------------------------------------------------------------------------- */
/* Live                                                                        */
/* -------------------------------------------------------------------------- */

describe('live validation', () => {
  it('should enable enrichment when valid and hasFeature', () => {
    const state = resolve({ kind: 'validated', response: validationResponse() });

    expect(state.mode).toBe('full');
    expect(state.reason).toBe('licensed');
    expect(state.source).toBe('live');
  });

  it('should degrade to rules-only for a valid licence without the feature', () => {
    const state = resolve({
      kind: 'validated',
      response: validationResponse({ hasFeature: false, features: ['rules'] }),
    });

    expect(state.mode).toBe('rules-only');
    expect(state.reason).toBe('feature_not_licensed');
    expect(state.severity).toBe('notice');
  });

  it('should degrade to rules-only for a suspended licence that still has the feature', () => {
    const state = resolve({
      kind: 'validated',
      response: validationResponse({
        valid: false,
        reason: 'suspended',
        hasFeature: true,
      }),
    });

    expect(state.mode).toBe('rules-only');
    expect(state.reason).toBe('suspended');
    expect(state.severity).toBe('problem');
  });

  it('should carry both booleans separately for the audit row', () => {
    const state = resolve({
      kind: 'validated',
      response: validationResponse({ valid: true, hasFeature: false }),
    });

    expect(state.observedValid).toBe(true);
    expect(state.observedHasFeature).toBe(false);
  });

  it('should write a cache entry from a live response and nothing else', () => {
    const resolved = resolveLicenceState({
      presence: { hasKey: true, maskedKey: maskLicenceKey(SANDBOX_TRIAL_KEY) },
      outcome: { kind: 'validated', response: validationResponse() },
      cached: null,
      activation: UNKNOWN_ACTIVATION,
      environment: 'production',
      now: NOW,
    });

    expect(resolved.cacheWrite).not.toBeNull();
    expect(resolved.cacheWrite?.cachedAt).toBe(NOW.toISOString());
    expect(resolved.cacheWrite?.valid).toBe(true);
    expect(resolved.cacheWrite?.hasFeature).toBe(true);
  });

  it('should raise severity when the licence is close to expiry', () => {
    const state = resolve({
      kind: 'validated',
      response: validationResponse({ daysRemaining: 3 }),
    });

    expect(state.mode).toBe('full');
    expect(state.severity).toBe('warning');
  });

  it('should raise severity when the service sets expiryWarning regardless of days', () => {
    const state = resolve({
      kind: 'validated',
      response: validationResponse({ daysRemaining: 30, expiryWarning: true }),
    });

    expect(state.severity).toBe('warning');
  });
});

/* -------------------------------------------------------------------------- */
/* Offline ladder                                                              */
/* -------------------------------------------------------------------------- */

describe('cache hit — failure within 24h', () => {
  for (const failure of FAILURES) {
    it(`should keep the cached entitlement after ${failure.kind}`, () => {
      const state = resolve(failure, cachedEntitlement({
        cachedAt: hoursBefore(6).toISOString(),
      }));

      expect(state.mode).toBe('full');
      expect(state.source).toBe('cache');
      expect(state.reason).toBe('licensed');
      expect(state.failureKind).toBe(failure.kind);
    });
  }

  it('should not re-enable a feature the cache says is not licensed', () => {
    const state = resolve(
      { kind: 'transport_failure', detail: 'ENOTFOUND' },
      cachedEntitlement({ hasFeature: false, features: ['rules'] }),
    );

    expect(state.mode).toBe('rules-only');
    expect(state.reason).toBe('feature_not_licensed');
  });

  it('should surface serving-from-cache as at least a notice', () => {
    expect(
      resolve({ kind: 'service_unavailable', statusCode: 503 }, cachedEntitlement())
        .severity,
    ).toBe('notice');
  });

  it('should never refresh cachedAt on a failure', () => {
    // Refreshing on failure would make the 24h and 72h windows unreachable: the
    // cache would look permanently fresh while never being re-validated.
    const resolved = resolveLicenceState({
      presence: { hasKey: true, maskedKey: 'mask' },
      outcome: { kind: 'transport_failure', detail: 'ENOTFOUND' },
      cached: cachedEntitlement(),
      activation: UNKNOWN_ACTIVATION,
      environment: 'production',
      now: NOW,
    });

    expect(resolved.cacheWrite).toBeNull();
  });
});

describe('grace window — failure between 24h and 72h', () => {
  for (const hours of [24, 48, 71]) {
    it(`should disable enrichment but keep scoring at ${hours}h`, () => {
      const state = resolve(
        { kind: 'transport_failure', detail: 'ENOTFOUND' },
        cachedEntitlement({ cachedAt: hoursBefore(hours).toISOString() }),
      );

      expect(state.mode).toBe('rules-only');
      expect(state.source).toBe('grace');
      expect(state.reason).toBe('licence_service_unreachable');
      expect(state.severity).toBe('warning');
    });
  }

  it('should name a 429 as rate limiting rather than as unreachable', () => {
    // Telling an admin "unreachable" when the truth is "rate-limited" sends
    // them to check DNS. The mode is identical either way; only the message
    // differs, and the message is the whole point of the notice.
    const state = resolve(
      { kind: 'rate_limited', retryAfterSeconds: 120 },
      cachedEntitlement({ cachedAt: hoursBefore(30).toISOString() }),
    );

    expect(state.mode).toBe('rules-only');
    expect(state.reason).toBe('licence_service_rate_limited');
  });

  it('should name a malformed response as such', () => {
    const state = resolve(
      { kind: 'malformed_response', detail: 'not json' },
      cachedEntitlement({ cachedAt: hoursBefore(30).toISOString() }),
    );

    expect(state.reason).toBe('licence_response_malformed');
  });
});

describe('grace expired — failure beyond 72h', () => {
  it('should degrade to rules-only with a visible warning, never a block', () => {
    const state = resolve(
      { kind: 'transport_failure', detail: 'ENOTFOUND' },
      cachedEntitlement({ cachedAt: hoursBefore(100).toISOString() }),
    );

    expect(state.mode).toBe('rules-only');
    expect(state.source).toBe('none');
    expect(state.reason).toBe('licence_service_unreachable_grace_expired');
    expect(state.severity).toBe('problem');
  });

  it('should stay rules-only however long the outage lasts', () => {
    const state = resolve(
      { kind: 'service_unavailable', statusCode: 503 },
      cachedEntitlement({ cachedAt: hoursBefore(24 * 365).toISOString() }),
    );

    expect(state.mode).toBe('rules-only');
  });
});

describe('no cache at all', () => {
  it('should treat a first-run failure as grace-expired', () => {
    const state = resolve({ kind: 'transport_failure', detail: 'ENOTFOUND' }, null);

    expect(state.mode).toBe('rules-only');
    expect(state.reason).toBe('licence_service_unreachable_grace_expired');
    expect(state.cacheAgeMs).toBeNull();
  });

  it('should treat an unparseable cachedAt as no cache', () => {
    const state = resolve(
      { kind: 'transport_failure', detail: 'ENOTFOUND' },
      cachedEntitlement({ cachedAt: 'not a date' }),
    );

    expect(state.reason).toBe('licence_service_unreachable_grace_expired');
  });

  it('should treat "no call attempted" as a transport failure rather than a new branch', () => {
    const state = resolve(null, null, UNKNOWN_ACTIVATION, true);

    expect(state.mode).toBe('rules-only');
    expect(state.failureKind).toBe('transport_failure');
  });
});

/* -------------------------------------------------------------------------- */
/* Gotcha 3's consequence — sticky activation limit                            */
/* -------------------------------------------------------------------------- */

describe('gotcha 3 — a 409 must survive the nightly re-validation', () => {
  const limitReached: LicenceActivationState = {
    status: 'limit_reached',
    at: NOW.toISOString(),
  };

  it('should override a perfectly healthy live validation', () => {
    // This is the case the whole sticky-activation design exists for. Because
    // `validate` does not consult activation slots for Trial/Subscription
    // licences, a workspace refused with 409 still gets valid:true,
    // hasFeature:true — so without the override, the next nightly run would
    // silently switch enrichment back on.
    const state = resolve(
      { kind: 'validated', response: validationResponse() },
      null,
      limitReached,
    );

    expect(state.observedValid).toBe(true);
    expect(state.observedHasFeature).toBe(true);
    expect(state.mode).toBe('rules-only');
    expect(state.reason).toBe('max_activations_reached');
    expect(state.severity).toBe('problem');
  });

  it('should override a fresh cache hit too', () => {
    const state = resolve(
      { kind: 'transport_failure', detail: 'ENOTFOUND' },
      cachedEntitlement(),
      limitReached,
    );

    expect(state.mode).toBe('rules-only');
    expect(state.reason).toBe('max_activations_reached');
  });

  it('should not poison the cache entry with the override', () => {
    // Clearing the 409 must take effect immediately, not after the cache
    // expires — so the cache records what the service said, not what we did.
    const resolved = resolveLicenceState({
      presence: { hasKey: true, maskedKey: 'mask' },
      outcome: { kind: 'validated', response: validationResponse() },
      cached: null,
      activation: limitReached,
      environment: 'production',
      now: NOW,
    });

    expect(resolved.state.mode).toBe('rules-only');
    expect(resolved.cacheWrite?.valid).toBe(true);
    expect(resolved.cacheWrite?.hasFeature).toBe(true);
  });

  it('should restore full mode once activation is claimed', () => {
    const state = resolve(
      { kind: 'validated', response: validationResponse() },
      null,
      { status: 'claimed', at: NOW.toISOString() },
    );

    expect(state.mode).toBe('full');
  });
});

/* -------------------------------------------------------------------------- */
/* Gotcha 2                                                                    */
/* -------------------------------------------------------------------------- */

describe('gotcha 2 — validity does not depend on activation', () => {
  it('should enable enrichment on a never-activated licence that validates', () => {
    // The observed sandbox behaviour: activatedCount 0, valid true. There is no
    // "activate then re-validate" recovery loop anywhere in this client.
    const state = resolve(
      {
        kind: 'validated',
        response: validationResponse({ activatedCount: 0, maxActivations: 1 }),
      },
      null,
      UNKNOWN_ACTIVATION,
    );

    expect(state.mode).toBe('full');
  });

  it('should still report device_not_activated as itself if a policy ever sends it', () => {
    const state = resolve({
      kind: 'validated',
      response: validationResponse({
        valid: false,
        reason: 'device_not_activated',
        hasFeature: true,
      }),
    });

    expect(state.reason).toBe('device_not_activated');
    expect(state.mode).toBe('rules-only');
  });
});

/* -------------------------------------------------------------------------- */
/* Invariants across every branch                                              */
/* -------------------------------------------------------------------------- */

describe('invariants', () => {
  const everyOutcome: (LicenceValidateOutcome | null)[] = [
    null,
    { kind: 'validated', response: validationResponse() },
    { kind: 'validated', response: validationResponse({ valid: false, reason: 'expired' }) },
    { kind: 'validated', response: validationResponse({ hasFeature: false }) },
    ...FAILURES,
  ];

  const everyCache = [
    null,
    cachedEntitlement({ cachedAt: hoursBefore(1).toISOString() }),
    cachedEntitlement({ cachedAt: hoursBefore(40).toISOString() }),
    cachedEntitlement({ cachedAt: hoursBefore(200).toISOString() }),
  ];

  const everyActivation: LicenceActivationState[] = [
    { status: 'unknown' },
    { status: 'claimed', at: NOW.toISOString() },
    { status: 'limit_reached', at: NOW.toISOString() },
  ];

  it('should never produce a mode other than full or rules-only', () => {
    for (const outcome of everyOutcome) {
      for (const cached of everyCache) {
        for (const activation of everyActivation) {
          for (const hasKey of [true, false]) {
            const state = resolve(outcome, cached, activation, hasKey);

            expect(['full', 'rules-only']).toContain(state.mode);
          }
        }
      }
    }
  });

  it('should never place the licence key in the resolved state', () => {
    for (const outcome of everyOutcome) {
      for (const cached of everyCache) {
        const state = resolve(outcome, cached);

        expect(JSON.stringify(state)).not.toContain(SANDBOX_TRIAL_KEY);
        expect(JSON.stringify(state)).not.toContain('VN3D3');
      }
    }
  });
});
