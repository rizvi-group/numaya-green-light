import { buildLicencePanelView } from 'src/licensing/panel';
import { maskLicenceKey, MISSING_LICENCE_MASK } from 'src/licensing/mask';
import { resolveLicenceState } from 'src/licensing/state';
import type {
  LicenceActivationState,
  LicenceState,
  LicenceValidateOutcome,
} from 'src/licensing/types';
import {
  NOW,
  SANDBOX_TRIAL_KEY,
  validationResponse,
} from 'src/licensing/__tests__/fixtures';
import { describe, expect, it } from 'vitest';

const PURCHASE_URL = 'https://example.test/buy';

const stateFor = (
  outcome: LicenceValidateOutcome | null,
  hasKey = true,
  activation: LicenceActivationState = { status: 'unknown' },
): LicenceState =>
  resolveLicenceState({
    presence: { hasKey, maskedKey: maskLicenceKey(SANDBOX_TRIAL_KEY) },
    outcome,
    cached: null,
    activation,
    environment: 'production',
    now: NOW,
  }).state;

const viewFor = (state: LicenceState | null, hasKeyConfigured = true) =>
  buildLicencePanelView({ state, hasKeyConfigured, purchaseUrl: PURCHASE_URL });

describe('buildLicencePanelView', () => {
  describe('the purchase route', () => {
    it('should offer a licence when the workspace has no key', () => {
      const view = viewFor(stateFor(null, false), false);

      expect(view.reason).toBe('no_licence_key');
      expect(view.enrichmentEnabled).toBe(false);
      expect(view.callToAction).toEqual({
        label: 'Get a licence',
        url: PURCHASE_URL,
      });
    });

    it('should offer enrichment as an upgrade when the plan excludes it', () => {
      const view = viewFor(
        stateFor({
          kind: 'validated',
          response: validationResponse({ hasFeature: false, features: ['rules'] }),
        }),
      );

      expect(view.reason).toBe('feature_not_licensed');
      expect(view.callToAction).toEqual({
        label: 'Add enrichment to your plan',
        url: PURCHASE_URL,
      });
    });

    it('should never offer a licence to a workspace that already has a working one', () => {
      const view = viewFor(
        stateFor({ kind: 'validated', response: validationResponse({}) }),
      );

      expect(view.enrichmentEnabled).toBe(true);
      expect(view.callToAction).toBeNull();
    });

    /**
     * The states where buying again fixes nothing. Each of these has a specific
     * remedy that `describeLicenceForAdmin` already names — re-enter the key,
     * switch environment, wait for the service — and a purchase button next to
     * that advice would send an admin to spend money on the wrong problem.
     */
    it('should not offer a licence when a purchase would not fix the state', () => {
      const rejected = viewFor(stateFor({ kind: 'key_rejected', statusCode: 401 }));
      const unreachable = viewFor(
        stateFor({ kind: 'service_unavailable', statusCode: 503 }),
      );

      expect(rejected.callToAction).toBeNull();
      expect(unreachable.callToAction).toBeNull();
    });
  });

  describe('before any check has run', () => {
    it('should say so rather than claim a licence problem', () => {
      const view = viewFor(null, false);

      expect(view.headline).toMatch(/has not checked/i);
      expect(view.enrichmentEnabled).toBe(false);
      expect(view.checkedAt).toBeNull();
      expect(view.maskedKey).toBe(MISSING_LICENCE_MASK);
      expect(view.callToAction).not.toBeNull();
    });

    it('should not sell a second licence to somebody whose key is merely unverified', () => {
      const view = viewFor(null, true);

      expect(view.enrichmentEnabled).toBe(false);
      expect(view.callToAction).toBeNull();
    });
  });

  it('should never carry an unmasked key', () => {
    const view = viewFor(
      stateFor({ kind: 'validated', response: validationResponse({}) }),
    );

    expect(JSON.stringify(view)).not.toContain(SANDBOX_TRIAL_KEY);
  });
});
