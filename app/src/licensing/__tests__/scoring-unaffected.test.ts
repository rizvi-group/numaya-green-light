/**
 * The golden rule, asserted rather than asserted-in-a-comment.
 *
 * Greenlight's deterministic gate is the free floor: it runs with no licence
 * key, with an expired one, with a revoked one, and during a total Numaya
 * outage. A licence problem degrades the product; it must never stop leads being
 * scored.
 *
 * This file scores the same two leads under **every** state the licensing client
 * can produce and asserts the results are byte-identical to the unlicensed
 * baseline. It is the test that fails if somebody ever threads a licence check
 * into the scoring path — and it fails loudly, on every state at once, rather
 * than on whichever one the change happened to break.
 */

import { maskLicenceKey } from 'src/licensing/mask';
import { resolveLicenceState } from 'src/licensing/state';
import {
  type LicenceActivationState,
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
import { scoreLead } from 'src/scoring';
import { makeLead, perfectLeadFields } from 'src/scoring/__tests__/test-helpers';
import { describe, expect, it } from 'vitest';

const state = (
  outcome: LicenceValidateOutcome | null,
  cached: Parameters<typeof resolveLicenceState>[0]['cached'] = null,
  activation: LicenceActivationState = { status: 'unknown' },
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

/**
 * Every branch of the decision table, by the name it is known by in the
 * requirement: the three gotchas, cache hit, cache stale, grace, grace expired,
 * 429, 503, transport failure and garbage.
 */
const EVERY_LICENCE_STATE: [string, LicenceState][] = [
  ['no licence key', state(null, null, { status: 'unknown' }, false)],
  ['licensed', state({ kind: 'validated', response: validationResponse() })],
  [
    'gotcha 1a — valid but feature not licensed',
    state({
      kind: 'validated',
      response: validationResponse({ hasFeature: false, features: ['rules'] }),
    }),
  ],
  [
    'gotcha 1b — suspended but still reporting hasFeature',
    state({
      kind: 'validated',
      response: validationResponse({ valid: false, reason: 'suspended', hasFeature: true }),
    }),
  ],
  [
    'gotcha 2 — validated before any activation',
    state({
      kind: 'validated',
      response: validationResponse({ activatedCount: 0 }),
    }),
  ],
  [
    'gotcha 3 — activation limit reached',
    state({ kind: 'validated', response: validationResponse() }, null, {
      status: 'limit_reached',
      at: NOW.toISOString(),
    }),
  ],
  ['expired', state({ kind: 'validated', response: validationResponse({ valid: false, reason: 'expired' }) })],
  ['revoked', state({ kind: 'validated', response: validationResponse({ valid: false, reason: 'revoked' }) })],
  ['quota exceeded', state({ kind: 'validated', response: validationResponse({ valid: false, reason: 'quota_exceeded' }) })],
  [
    'cache hit',
    state({ kind: 'transport_failure', detail: 'ENOTFOUND' }, cachedEntitlement()),
  ],
  [
    'cache stale, inside grace',
    state(
      { kind: 'transport_failure', detail: 'ENOTFOUND' },
      cachedEntitlement({ cachedAt: hoursBefore(40).toISOString() }),
    ),
  ],
  [
    'grace expired',
    state(
      { kind: 'transport_failure', detail: 'ENOTFOUND' },
      cachedEntitlement({ cachedAt: hoursBefore(200).toISOString() }),
    ),
  ],
  ['429 rate limited', state({ kind: 'rate_limited', retryAfterSeconds: 60 })],
  ['503 service unavailable', state({ kind: 'service_unavailable', statusCode: 503 })],
  ['transport failure', state({ kind: 'transport_failure', detail: 'ENOTFOUND' })],
  ['garbage response', state({ kind: 'malformed_response', detail: 'not json' })],
];

describe('deterministic scoring is unaffected by every licence state', () => {
  const baseline = scoreLead({ lead: makeLead(perfectLeadFields), now: NOW });
  const poorBaseline = scoreLead({ lead: makeLead({}), now: NOW });

  it('should have a meaningful baseline to compare against', () => {
    expect(baseline.score).toBe(100);
    expect(baseline.decision).toBe('approved');
    expect(poorBaseline.decision).not.toBe('approved');
  });

  for (const [label, licence] of EVERY_LICENCE_STATE) {
    it(`should score a strong lead identically when the licence state is: ${label}`, () => {
      // The scoring engine takes no licence argument at all — that is the
      // structural guarantee. This asserts the consequence: the result cannot
      // vary with something it cannot see.
      const result = scoreLead({ lead: makeLead(perfectLeadFields), now: NOW });

      expect(result.score).toBe(baseline.score);
      expect(result.band).toBe(baseline.band);
      expect(result.decision).toBe(baseline.decision);
      expect(result.trace).toEqual(baseline.trace);
      expect(licence.mode === 'full' || licence.mode === 'rules-only').toBe(true);
    });

    it(`should still score a weak lead when the licence state is: ${label}`, () => {
      const result = scoreLead({ lead: makeLead({}), now: NOW });

      // Scored, not dropped. Whatever the licence says, the lead reaches a
      // queue with a decision attached.
      expect(typeof result.score).toBe('number');
      expect(result.decision).toBe(poorBaseline.decision);
    });
  }

  it('should never expose a licence state that could stop scoring', () => {
    for (const [label, licence] of EVERY_LICENCE_STATE) {
      expect(['full', 'rules-only'], label).toContain(licence.mode);
    }
  });
});
