/**
 * What the licence panel shows.
 *
 * The panel answers three questions an admin actually has — what am I running,
 * what am I not getting, and how do I fix it — and this module answers them as
 * a pure function of the published state so the answers can be tested without
 * a workspace, a network or a clock.
 *
 * ## Why "no key" and "key present but not entitled" must not read alike
 *
 * Both land in rules-only mode, and collapsing them is the obvious economy. It
 * is also the one that costs a support ticket every time: an admin who never
 * bought a licence needs a purchase route, and an admin whose key is being
 * refused needs to know *which* refusal it is before they buy a second one.
 * `describeLicenceForAdmin` already separates them; this module's job is to
 * carry that separation as far as the button.
 *
 * ## Why the call to action is data rather than markup
 *
 * `callToAction` is `null` whenever a licence is working. A panel that shows a
 * "Get a licence" button to a customer who already pays is not a small blemish
 * — it is the app failing to know something it definitely knows, in front of
 * the person who paid.
 */

import { describeLicenceForAdmin } from 'src/licensing/audit';
import { describeEnrichmentGate } from 'src/licensing/feature-gate';
import { MISSING_LICENCE_MASK } from 'src/licensing/mask';
import type {
  LicenceMode,
  LicenceReason,
  LicenceSeverity,
  LicenceState,
} from 'src/licensing/types';

export interface LicencePanelCallToAction {
  /** Button text. Named for what happens, not for the state that produced it. */
  readonly label: string;
  readonly url: string;
}

export interface LicencePanelView {
  readonly mode: LicenceMode;
  readonly reason: LicenceReason | null;
  readonly headline: string;
  readonly detail: string;
  readonly severity: LicenceSeverity;
  /** Enrichment is the only thing a licence buys. Named, not implied. */
  readonly enrichmentEnabled: boolean;
  readonly maskedKey: string;
  readonly environment: string | null;
  readonly checkedAt: string | null;
  readonly callToAction: LicencePanelCallToAction | null;
}

/**
 * The state a workspace is in before the nightly run has ever completed.
 *
 * `readPublishedLicenceState()` returns `null` both when no check has run yet
 * and when the stored value is unreadable. Treating that as "rules-only, and we
 * have not checked" is honest in both cases, and it is the same direction
 * `isEnrichmentEnabled` already fails in.
 */
const NEVER_CHECKED_HEADLINE = 'Greenlight has not checked a licence yet';

const NEVER_CHECKED_DETAIL =
  'No licence check has completed on this workspace, so enrichment is off. Deterministic scoring, the gate and the queue all work without one. If you have just installed the app, the nightly check will run within 24 hours; adding a licence key in the app settings checks immediately.';

export const buildLicencePanelView = ({
  state,
  hasKeyConfigured,
  purchaseUrl,
}: {
  readonly state: LicenceState | null;
  /** Whether `LICENCE_KEY` is set, read from the app variable, never its value. */
  readonly hasKeyConfigured: boolean;
  readonly purchaseUrl: string;
}): LicencePanelView => {
  const gate = describeEnrichmentGate(state);

  if (state === null) {
    return {
      mode: gate.mode,
      reason: gate.reason,
      headline: NEVER_CHECKED_HEADLINE,
      detail: NEVER_CHECKED_DETAIL,
      severity: 'notice',
      enrichmentEnabled: gate.enabled,
      maskedKey: hasKeyConfigured ? '' : MISSING_LICENCE_MASK,
      environment: null,
      checkedAt: null,
      // A key is configured but unverified: sending that admin to buy another
      // one would be wrong. Only the workspace with no key at all gets the
      // purchase route here.
      callToAction: hasKeyConfigured
        ? null
        : { label: 'Get a licence', url: purchaseUrl },
    };
  }

  const notice = describeLicenceForAdmin(state);

  return {
    mode: state.mode,
    reason: gate.reason,
    headline: notice.headline,
    detail: notice.detail,
    severity: state.severity,
    enrichmentEnabled: gate.enabled,
    maskedKey: state.maskedKey,
    environment: state.environment ?? null,
    checkedAt: state.checkedAt,
    callToAction: buildCallToAction(state.reason, purchaseUrl),
  };
};

/**
 * Which states earn a purchase button.
 *
 * Only the two that a purchase would actually fix: no key at all, and a key
 * whose plan does not include enrichment. Everything else — an expired licence,
 * a rejected key, an unreachable service, a wrong environment — is a state
 * where buying again either changes nothing or makes the mess worse, and where
 * `describeLicenceForAdmin`'s detail already names the real next step.
 *
 * `licensed` returns null on purpose, including while expiring: renewal is a
 * conversation with whoever holds the contract, and a button labelled "Get a
 * licence" is the wrong thing to show someone who has one.
 */
const buildCallToAction = (
  reason: LicenceReason,
  purchaseUrl: string,
): LicencePanelCallToAction | null => {
  switch (reason) {
    case 'no_licence_key':
      return { label: 'Get a licence', url: purchaseUrl };
    case 'feature_not_licensed':
      return { label: 'Add enrichment to your plan', url: purchaseUrl };
    default:
      return null;
  }
};
