import {
  buildLicenceAuditDetail,
  buildLicenceAuditRow,
  describeLicenceForAdmin,
  LICENCE_AUDIT_PREFIX,
} from 'src/licensing/audit';
import { maskLicenceKey } from 'src/licensing/mask';
import { resolveLicenceState } from 'src/licensing/state';
import {
  type LicenceActivationState,
  type LicenceReason,
  type LicenceState,
  type LicenceValidateOutcome,
} from 'src/licensing/types';
import {
  cachedEntitlement,
  hoursBefore,
  NOW,
  SANDBOX_RULES_ONLY_KEY,
  SANDBOX_TRIAL_KEY,
  validationResponse,
} from 'src/licensing/__tests__/fixtures';
import { describe, expect, it } from 'vitest';

const stateFor = (
  outcome: LicenceValidateOutcome | null,
  cached: Parameters<typeof resolveLicenceState>[0]['cached'] = null,
  activation: LicenceActivationState = { status: 'unknown' },
  hasKey = true,
  environment: 'production' | 'sandbox' = 'production',
): LicenceState =>
  resolveLicenceState({
    presence: { hasKey, maskedKey: maskLicenceKey(SANDBOX_TRIAL_KEY) },
    outcome,
    cached,
    activation,
    environment,
    now: NOW,
  }).state;

/** One state per reason in the vocabulary, so nothing is left undescribed. */
const EVERY_STATE: { reason: LicenceReason; state: LicenceState }[] = [
  { reason: 'licensed', state: stateFor({ kind: 'validated', response: validationResponse() }) },
  {
    reason: 'no_licence_key',
    state: stateFor(null, null, { status: 'unknown' }, false),
  },
  {
    reason: 'feature_not_licensed',
    state: stateFor({
      kind: 'validated',
      response: validationResponse({ hasFeature: false, features: ['rules'] }),
    }),
  },
  ...(['expired', 'revoked', 'suspended', 'quota_exceeded', 'device_not_activated'] as const).map(
    (reason) => ({
      reason: reason as LicenceReason,
      state: stateFor({
        kind: 'validated',
        response: validationResponse({ valid: false, reason }),
      }),
    }),
  ),
  {
    reason: 'invalid_licence',
    state: stateFor({
      kind: 'validated',
      response: validationResponse({ valid: false, reason: 'who_knows' }),
    }),
  },
  {
    reason: 'licence_not_found_in_environment',
    state: stateFor({
      kind: 'validated',
      response: validationResponse({
        valid: false,
        reason: 'license_not_found',
        hasFeature: false,
        features: [],
      }),
    }),
  },
  {
    reason: 'max_activations_reached',
    state: stateFor({ kind: 'validated', response: validationResponse() }, null, {
      status: 'limit_reached',
      at: NOW.toISOString(),
    }),
  },
  {
    reason: 'licence_service_rate_limited',
    state: stateFor(
      { kind: 'rate_limited', retryAfterSeconds: 60 },
      cachedEntitlement({ cachedAt: hoursBefore(30).toISOString() }),
    ),
  },
  {
    reason: 'licence_response_malformed',
    state: stateFor(
      { kind: 'malformed_response', detail: 'not json' },
      cachedEntitlement({ cachedAt: hoursBefore(30).toISOString() }),
    ),
  },
  {
    reason: 'licence_service_unreachable',
    state: stateFor(
      { kind: 'transport_failure', detail: 'ENOTFOUND' },
      cachedEntitlement({ cachedAt: hoursBefore(30).toISOString() }),
    ),
  },
  {
    reason: 'licence_service_unreachable_grace_expired',
    state: stateFor({ kind: 'transport_failure', detail: 'ENOTFOUND' }, null),
  },
];

describe('the audit detail records what the requirement asks for', () => {
  it('should carry timestamp, masked key, valid, hasFeature, reason, cached-vs-live and mode', () => {
    const detail = buildLicenceAuditDetail(
      stateFor({
        kind: 'validated',
        response: validationResponse({ hasFeature: false }),
      }),
    );

    expect(detail).toMatchObject({
      checkedAt: NOW.toISOString(),
      maskedKey: maskLicenceKey(SANDBOX_TRIAL_KEY),
      valid: true,
      hasFeature: false,
      reason: 'feature_not_licensed',
      source: 'live',
      cached: false,
      mode: 'rules-only',
    });
  });

  it('should mark a cache-served decision as cached', () => {
    const detail = buildLicenceAuditDetail(
      stateFor({ kind: 'transport_failure', detail: 'ENOTFOUND' }, cachedEntitlement()),
    );

    expect(detail.cached).toBe(true);
    expect(detail.source).toBe('cache');
  });

  it('should record the underlying failure kind alongside the reason', () => {
    const detail = buildLicenceAuditDetail(
      stateFor(
        { kind: 'service_unavailable', statusCode: 503 },
        cachedEntitlement({ cachedAt: hoursBefore(40).toISOString() }),
      ),
    );

    expect(detail.failureKind).toBe('service_unavailable');
    expect(detail.reason).toBe('licence_service_unreachable');
  });
});

describe('the licence key never reaches an audit row', () => {
  for (const { reason, state } of EVERY_STATE) {
    it(`should not leak the key for reason ${reason}`, () => {
      const serialised = JSON.stringify(buildLicenceAuditRow(state));

      expect(serialised).not.toContain(SANDBOX_TRIAL_KEY);
      expect(serialised).not.toContain(SANDBOX_RULES_ONLY_KEY);
      // Any single secret group would be enough to make the key guessable.
      for (const group of ['VN3D3', 'ZUDPJ', 'FKCW4', 'FH8J2', '8S5XM', 'HWL5Y']) {
        expect(serialised).not.toContain(group);
      }
    });
  }
});

describe('audit rows', () => {
  it('should be greppable by prefix without a schema change', () => {
    const row = buildLicenceAuditRow(
      stateFor({ kind: 'validated', response: validationResponse() }),
    );

    expect(String(row['name']).startsWith(`${LICENCE_AUDIT_PREFIX} · `)).toBe(true);
  });

  it('should file a healthy check under LICENCE', () => {
    const row = buildLicenceAuditRow(
      stateFor({ kind: 'validated', response: validationResponse() }),
    );

    expect(row['eventType']).toBe('LICENCE');
  });

  it('should file an unbought feature as a notice, not an error', () => {
    // A customer who has not bought enrichment has nothing wrong with their
    // licence. Filing that as ERROR would put a red row in the audit log every
    // night forever, and the admin would learn to ignore red.
    const row = buildLicenceAuditRow(
      stateFor({
        kind: 'validated',
        response: validationResponse({ hasFeature: false }),
      }),
    );

    expect(row['eventType']).toBe('LICENCE');
    expect(row['ruleTrace']).toMatchObject({ severity: 'notice' });
  });

  it('should file a suspended, revoked or expired licence under LICENCE too', () => {
    // These used to be `ERROR`, which was the only red the object offered before
    // `LICENCE` existed. They are not errors: nothing in Greenlight failed, the
    // customer's commercial state changed. The assertion is therefore inverted
    // rather than dropped — the severity that used to be encoded in the event
    // type has to still be legible, and it is, on the row itself.
    for (const reason of ['suspended', 'revoked', 'expired']) {
      const row = buildLicenceAuditRow(
        stateFor({
          kind: 'validated',
          response: validationResponse({ valid: false, reason }),
        }),
      );

      expect(row['eventType']).toBe('LICENCE');
      expect(row['ruleTrace']).toMatchObject({ severity: 'problem' });
      expect(row['eventType']).not.toBe('ERROR');
    }
  });

  it('should describe no lead, using the vocabulary already in the object', () => {
    const row = buildLicenceAuditRow(
      stateFor({ kind: 'validated', response: validationResponse() }),
    );

    expect(row).toMatchObject({
      leadObjectNameSingular: '',
      leadDisplayName: '',
      actorType: 'SYSTEM',
      score: null,
      band: 'UNSCORED',
      decision: 'UNSCORED',
    });
  });
});

describe('the admin notice', () => {
  it('should produce a headline and an action for every reason', () => {
    for (const { reason, state } of EVERY_STATE) {
      const notice = describeLicenceForAdmin(state);

      expect(notice.headline.length, reason).toBeGreaterThan(0);
      expect(notice.detail.length, reason).toBeGreaterThan(0);
    }
  });

  it('should say that scoring keeps working in every degraded state', () => {
    // The single most important thing an admin can be told when enrichment goes
    // off is that their leads are still being scored.
    const degraded = EVERY_STATE.filter(({ state }) => state.mode === 'rules-only');

    expect(degraded.length).toBeGreaterThan(5);

    for (const { reason, state } of degraded) {
      const notice = describeLicenceForAdmin(state);
      const text = `${notice.headline} ${notice.detail}`.toLowerCase();

      expect(
        text.includes('scoring') || text.includes('rules-only'),
        `${reason}: ${notice.detail}`,
      ).toBe(true);
    }
  });

  it('should distinguish "never validated" from "cache expired"', () => {
    const never = describeLicenceForAdmin(
      stateFor({ kind: 'transport_failure', detail: 'ENOTFOUND' }, null),
    );
    const stale = describeLicenceForAdmin(
      stateFor(
        { kind: 'transport_failure', detail: 'ENOTFOUND' },
        cachedEntitlement({ cachedAt: hoursBefore(200).toISOString() }),
      ),
    );

    expect(never.headline).not.toBe(stale.headline);
  });

  it('should name the environment, and refuse to blame the key, on a misrouted check', () => {
    // The whole point of the exercise. This state is reached by a *correct* key
    // pointed at the wrong environment, and the service reports it with HTTP
    // 200 and a reason that reads like a bad key. The notice has to break that
    // reading, out loud, or the fail-open design hides it forever.
    const misrouted = (environment: 'production' | 'sandbox') =>
      describeLicenceForAdmin(
        stateFor(
          {
            kind: 'validated',
            response: validationResponse({
              valid: false,
              reason: 'license_not_found',
              hasFeature: false,
            }),
          },
          null,
          { status: 'unknown' },
          true,
          environment,
        ),
      );

    const production = misrouted('production');

    expect(production.severity).toBe('problem');
    // Names the environment that was actually asked …
    expect(production.headline).toContain('production');
    // … names the setting and the value to try …
    expect(production.detail).toContain('LICENCE_ENVIRONMENT');
    expect(production.detail).toContain('sandbox');
    // … and says outright that re-entering the key is not the fix.
    expect(production.detail.toLowerCase()).toContain('do not re-enter the key');
    expect(production.detail.toLowerCase()).not.toContain('typo');

    // Symmetric: a production licence checked against sandbox reads the same
    // way round the other way.
    const sandbox = misrouted('sandbox');

    expect(sandbox.headline).toContain('sandbox');
    expect(sandbox.detail).toContain('production');
    expect(sandbox.headline).not.toBe(production.headline);
  });

  it('should keep "rejected" meaning a bad key, so the two are never confused', () => {
    // The mirror of the test above. A 401 is what a mistyped key actually
    // produces, measured live — and *that* notice is the one that should send
    // an admin back to the key field.
    const rejected = describeLicenceForAdmin(
      stateFor({ kind: 'key_rejected', statusCode: 401 }, cachedEntitlement()),
    );

    expect(rejected.detail.toLowerCase()).toContain('typo');
    expect(rejected.detail).not.toContain('LICENCE_ENVIRONMENT');
  });

  it('should record the environment on every row, healthy ones included', () => {
    // A row saying `reason: license_not_found` without saying which environment
    // was asked is a support ticket; with it, it is a two-minute fix.
    expect(
      buildLicenceAuditDetail(
        stateFor({ kind: 'validated', response: validationResponse() }),
      ).environment,
    ).toBe('production');

    expect(
      buildLicenceAuditDetail(
        stateFor(
          { kind: 'validated', response: validationResponse() },
          null,
          { status: 'unknown' },
          true,
          'sandbox',
        ),
      ).environment,
    ).toBe('sandbox');
  });

  it('should prompt for renewal before the licence actually expires', () => {
    const notice = describeLicenceForAdmin(
      stateFor({
        kind: 'validated',
        response: validationResponse({ daysRemaining: 3 }),
      }),
    );

    expect(notice.headline).toContain('expires');
    expect(notice.severity).toBe('warning');
  });
});
