import { parseValidationResponse } from 'src/licensing/parse';
import { describe, expect, it } from 'vitest';

/** The verified live response, verbatim from LICENSING_INTEGRATION.md. */
const LIVE_RESPONSE = {
  valid: true,
  reason: null,
  licenseId: '3e202b01-376c-4604-870c-d44f4f84c4b2',
  type: 'Trial',
  status: 'Active',
  isTrial: true,
  isPerpetual: false,
  isSubscription: false,
  daysRemaining: 14,
  expiryWarning: false,
  maintenanceExpired: false,
  inGracePeriod: false,
  hasFeature: true,
  features: ['rules', 'enrichment'],
  activatedCount: 0,
  maxActivations: 1,
  expiryAt: '2026-08-16T09:58:42.729898Z',
  tier: 'Pro',
};

describe('parsing the verified response', () => {
  it('should read every field Greenlight depends on', () => {
    const parsed = parseValidationResponse(LIVE_RESPONSE);

    expect(parsed.kind).toBe('parsed');

    if (parsed.kind !== 'parsed') {
      return;
    }

    expect(parsed.response).toMatchObject({
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
    });
  });

  it('should treat valid: false as a perfectly normal response', () => {
    // A failed validation is a 200, not an error. Nothing about a suspended
    // licence is malformed.
    const parsed = parseValidationResponse({
      ...LIVE_RESPONSE,
      valid: false,
      reason: 'suspended',
    });

    expect(parsed.kind).toBe('parsed');
  });
});

describe('garbage responses', () => {
  const garbage: [string, unknown][] = [
    ['null', null],
    ['a string', 'service unavailable'],
    ['an array', [1, 2, 3]],
    ['an HTML error page parsed as text', '<html>502 Bad Gateway</html>'],
    ['an empty object', {}],
    ['an error envelope', { error: true, statusCode: 500, message: 'boom' }],
    ['valid as a string', { valid: 'true', hasFeature: true }],
    ['valid as a number', { valid: 1 }],
  ];

  for (const [label, payload] of garbage) {
    it(`should classify ${label} as malformed rather than throwing`, () => {
      expect(() => parseValidationResponse(payload)).not.toThrow();
      expect(parseValidationResponse(payload).kind).toBe('malformed');
    });
  }
});

describe('partial responses', () => {
  it('should fail closed on the paid feature when hasFeature is missing', () => {
    // Rules scoring is unaffected either way, so the safe direction is "no
    // enrichment" — an absent field must never be read as an entitlement.
    const parsed = parseValidationResponse({ valid: true });

    expect(parsed.kind).toBe('parsed');
    expect(parsed.kind === 'parsed' && parsed.response.hasFeature).toBe(false);
  });

  it('should default a missing daysRemaining to null, not zero', () => {
    // Zero would render as "expires today" and cry wolf on every response that
    // simply omits the field.
    const parsed = parseValidationResponse({ valid: true });

    expect(parsed.kind === 'parsed' && parsed.response.daysRemaining).toBeNull();
  });

  it('should accept a numeric field arriving as a quoted string', () => {
    const parsed = parseValidationResponse({ valid: true, daysRemaining: '5' });

    expect(parsed.kind === 'parsed' && parsed.response.daysRemaining).toBe(5);
  });

  it('should drop non-string entries from the feature list', () => {
    const parsed = parseValidationResponse({
      valid: true,
      features: ['rules', 42, null, 'enrichment'],
    });

    expect(parsed.kind === 'parsed' && parsed.response.features).toEqual([
      'rules',
      'enrichment',
    ]);
  });
});
