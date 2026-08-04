/**
 * `resolveLicenceState` — the entire licensing decision, as one pure function.
 *
 * Everything impure happened before this call: the HTTP adapter turned the wire
 * into a `LicenceValidateOutcome`, the store read the cache, the run masked the
 * key and read the clock. What is left is arithmetic and a decision table, which
 * is why every interesting case in this module has a test rather than a comment
 * promising it works.
 *
 * ===========================================================================
 * ## The golden rule this module exists to protect
 *
 * *Greenlight never hard-blocks on a licence state.* Every branch below returns
 * either `full` or `rules-only`, and `rules-only` is a fully working product:
 * deterministic scoring, the gate, the queue, the audit trail. There is no
 * branch that stops scoring, and there is deliberately no way to express one —
 * `LicenceMode` has two members and neither of them is "off".
 *
 * The earlier draft of the integration spec proposed a hard block once the
 * offline grace window expired. It is withdrawn: a Numaya-side outage lasting
 * three days would then start silently dropping a customer's leads on the floor,
 * which is a far worse outcome for them *and* for us than three days of
 * unlicensed enrichment would have been for us alone.
 *
 * ===========================================================================
 * ## Gotcha 2 — activation is not a precondition for validity
 *
 * The service documents a `device_not_activated` reason, which invites the
 * classic recovery loop: validate, see `device_not_activated`, call `activate`,
 * validate again. For our policies that loop is dead code. Validating a
 * brand-new Trial licence **before any activation at all** returned
 * `valid: true, activatedCount: 0`. Activation on `Trial` and `Subscription`
 * types is slot consumption, not a gate.
 *
 * So this module never treats a missing activation as invalidating, never
 * re-validates after activating, and `activate` is called exactly once, at
 * install, from `licence-run.ts`. `device_not_activated` remains in the reason
 * vocabulary only because a future `NodeLocked` policy might genuinely produce
 * it, and it should then read as itself.
 *
 * ## Why activation state is sticky, and why that is not a contradiction
 *
 * Gotcha 2 says validity does not depend on activation. Gotcha 3 says exceeding
 * the activation limit is a bare `409` on the `activate` call. Put together,
 * they have a consequence that neither states on its own:
 *
 *   A workspace whose activation was refused with `409` — because the licence
 *   is already bound to a different workspace — will still get
 *   `valid: true, hasFeature: true` from `validate`, because validation does not
 *   check slots for these licence types.
 *
 * If the `409` were only handled at install time, the very next nightly run
 * would see a healthy validation and quietly switch enrichment back on. The
 * activation limit would be unenforceable in practice. So the `409` is persisted
 * (`LicenceActivationState`) and re-applied on every resolution, *after* the
 * entitlement decision, as an override. It is cleared only by a subsequent
 * successful `activate` — i.e. by the admin actually freeing a slot or buying a
 * seat, and reinstalling.
 *
 * ===========================================================================
 * ## The decision table
 *
 * | Input                                     | Mode         | Reason                                      | Source  |
 * |-------------------------------------------|--------------|---------------------------------------------|---------|
 * | No `LICENCE_KEY`                          | `rules-only` | `no_licence_key`                            | `none`  |
 * | Live: `valid && hasFeature`               | `full`       | `licensed`                                  | `live`  |
 * | Live: `valid && !hasFeature`              | `rules-only` | `feature_not_licensed` *(derived)*          | `live`  |
 * | Live: `!valid`                            | `rules-only` | `suspended` / `expired` / `revoked` / …     | `live`  |
 * | Live: `!valid`, `license_not_found`       | `rules-only` | `licence_not_found_in_environment`          | `live`  |
 * | `401` — key refused as a credential       | `rules-only` | `invalid_licence` *(no cache fallback)*     | `none`  |
 * | `404` on activate — wrong environment     | `rules-only` | `licence_not_found_in_environment`          | `none`  |
 * | Failure, cache `< 24h`                    | as cached    | as cached                                   | `cache` |
 * | Failure, cache `24–72h`                   | `rules-only` | `licence_service_unreachable` *(or 429/…)*  | `grace` |
 * | Failure, cache `> 72h` or never validated | `rules-only` | `…_grace_expired` *(or 429/…)*              | `none`  |
 * | Any of the above + sticky `409`           | `rules-only` | `max_activations_reached`                   | *kept*  |
 * ===========================================================================
 */

import {
  classifyCache,
  type CacheFreshness,
} from 'src/licensing/cache';
import {
  entitlementReason,
  isEnrichmentEntitled,
} from 'src/licensing/entitlement';
import {
  type CachedLicenceValidation,
  type LicenceActivationState,
  type LicenceCallFailure,
  type LicenceEnvironmentName,
  type LicenceKeyPresence,
  type LicenceReason,
  type LicenceSeverity,
  type LicenceState,
  type LicenceValidateOutcome,
  type LicenceValidationResponse,
} from 'src/licensing/types';

/* -------------------------------------------------------------------------- */
/* Severity                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How loudly the admin hears about a reason.
 *
 * `feature_not_licensed` is a **notice**, not a problem: the licence is healthy
 * and the customer simply has not bought enrichment. Rendering that in red next
 * to a genuine revocation would train admins to ignore the red.
 *
 * `no_licence_key` is likewise a notice. Running Greenlight unlicensed is a
 * supported configuration — it is the free floor, not a fault.
 */
const REASON_SEVERITY: Readonly<Record<LicenceReason, LicenceSeverity>> = {
  licensed: 'ok',
  no_licence_key: 'notice',
  feature_not_licensed: 'notice',
  // A `problem`, and deliberately the same rank as a revocation. The whole
  // failure mode is that it looks survivable — a 200, a plausible reason, a
  // product that keeps working — so the one place it is allowed to be loud is
  // here. See gotcha 4 in `entitlement.ts`.
  licence_not_found_in_environment: 'problem',
  expired: 'problem',
  revoked: 'problem',
  suspended: 'problem',
  quota_exceeded: 'warning',
  device_not_activated: 'warning',
  max_activations_reached: 'problem',
  invalid_licence: 'problem',
  licence_service_rate_limited: 'warning',
  licence_response_malformed: 'warning',
  licence_service_unreachable: 'warning',
  licence_service_unreachable_grace_expired: 'problem',
};

const SEVERITY_RANK: Readonly<Record<LicenceSeverity, number>> = {
  ok: 0,
  notice: 1,
  warning: 2,
  problem: 3,
};

const worst = (a: LicenceSeverity, b: LicenceSeverity): LicenceSeverity =>
  SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;

/**
 * Renewal is a deadline, so it escalates on its own clock rather than waiting
 * for the licence to actually break. `expiryWarning` is the service's own flag;
 * the seven-day floor is ours, because a Trial is fourteen days long and a
 * warning that only fires on the service's schedule may arrive too late for a
 * purchase order to clear.
 */
export const EXPIRY_WARNING_DAYS = 7;

const isExpiringSoon = (
  daysRemaining: number | null,
  expiryWarning: boolean,
): boolean =>
  expiryWarning || (daysRemaining !== null && daysRemaining <= EXPIRY_WARNING_DAYS);

/* -------------------------------------------------------------------------- */
/* Failure → reason                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What to tell the admin when we could not get a fresh answer and the cache no
 * longer covers us.
 *
 * A `429` and a `503` are not the same event and must not read the same. "The
 * licence service is unreachable" sends someone to check DNS and firewalls; if
 * the truth is that we are being rate-limited, that is an hour of their day
 * spent on the wrong system. The mode is identical in every case — rules-only —
 * so the only thing this choice affects is whether the message is useful.
 */
const failureReason = (
  failure: LicenceCallFailure,
  covered: boolean,
): LicenceReason => {
  switch (failure.kind) {
    case 'rate_limited':
      return 'licence_service_rate_limited';
    case 'malformed_response':
      return 'licence_response_malformed';
    case 'key_rejected':
      // A 401 is the service refusing the key as a credential — measured live
      // as what a typo'd or unknown key actually produces. Reporting it as
      // "cannot reach the licensing service" would send an admin to check DNS
      // and firewalls over a mistyped key.
      return 'invalid_licence';
    case 'licence_not_found':
      // `activate`'s out-of-band form of gotcha 4: a 404 rather than a 200 with
      // a reason, but the same cause and the same fix.
      return 'licence_not_found_in_environment';
    default:
      return covered
        ? 'licence_service_unreachable'
        : 'licence_service_unreachable_grace_expired';
  }
};

/**
 * Whether a failure is the service *answering* rather than the service being
 * unavailable.
 *
 * Definitive failures skip the cache → grace ladder entirely. The ladder exists
 * to ride out an outage; there is no outage to ride out when the service has
 * told us the key is refused or the licence is not in this environment, and
 * serving `full` from a cache for another 24 hours would only delay the notice
 * that fixes it. This is the same treatment `valid: false` already gets.
 */
const isDefinitive = (failure: LicenceCallFailure): boolean =>
  failure.kind === 'key_rejected' || failure.kind === 'licence_not_found';

/* -------------------------------------------------------------------------- */
/* Cache entry                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The snapshot written after a successful live validation.
 *
 * Note what is stored: the two gate booleans, the reason, and the renewal
 * fields. Not the key, not the licence id, not the activation counts. The cache
 * is read by the offline path to answer one question — "may enrichment run" —
 * and storing more than that only widens what a storage dump reveals.
 */
export const buildCacheEntry = (
  response: LicenceValidationResponse,
  maskedKey: string,
  now: Date,
): CachedLicenceValidation => ({
  cachedAt: now.toISOString(),
  maskedKey,
  valid: response.valid,
  hasFeature: response.hasFeature,
  reason: response.reason,
  features: response.features,
  tier: response.tier,
  daysRemaining: response.daysRemaining,
  expiryWarning: response.expiryWarning,
  expiryAt: response.expiryAt,
});

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

export interface ResolveLicenceStateInput {
  /** Whether a key is configured, and its mask. Never the key itself. */
  readonly presence: LicenceKeyPresence;
  /** `null` when no call was attempted — i.e. when there is no key. */
  readonly outcome: LicenceValidateOutcome | null;
  readonly cached: CachedLicenceValidation | null;
  readonly activation: LicenceActivationState;
  /**
   * Which environment the call was routed to. Required rather than defaulted:
   * a resolver that quietly assumes `production` is exactly the silent
   * misrouting this whole module now exists to make visible.
   */
  readonly environment: LicenceEnvironmentName;
  readonly now: Date;
}

export interface ResolvedLicence {
  readonly state: LicenceState;
  /** Non-null only after a live validation. Nothing else may write the cache. */
  readonly cacheWrite: CachedLicenceValidation | null;
}

const emptyState = (
  input: ResolveLicenceStateInput,
  reason: LicenceReason,
): LicenceState => ({
  mode: 'rules-only',
  reason,
  source: 'none',
  severity: REASON_SEVERITY[reason],
  maskedKey: input.presence.maskedKey,
  environment: input.environment,
  checkedAt: input.now.toISOString(),
  cacheAgeMs: null,
  failureKind: null,
  observedValid: null,
  observedHasFeature: null,
  tier: null,
  daysRemaining: null,
  expiryWarning: false,
  expiryAt: null,
  features: [],
});

/**
 * Applied last, over any entitlement decision. See "Why activation state is
 * sticky" above — without this, the `409` is unenforceable because `validate`
 * does not consult activation slots for our licence types.
 *
 * It cannot override `no_licence_key`: a workspace with no key has nothing to
 * say about activation, and reporting `max_activations_reached` there would be
 * nonsense left over from a previous key.
 */
const applyActivationOverride = (
  state: LicenceState,
  activation: LicenceActivationState,
): LicenceState => {
  if (activation.status !== 'limit_reached') {
    return state;
  }

  if (state.reason === 'no_licence_key') {
    return state;
  }

  return {
    ...state,
    mode: 'rules-only',
    reason: 'max_activations_reached',
    severity: worst(state.severity, REASON_SEVERITY['max_activations_reached']),
  };
};

const resolveFromLive = (
  input: ResolveLicenceStateInput,
  response: LicenceValidationResponse,
): ResolvedLicence => {
  const reason = entitlementReason(response);
  const entitled = isEnrichmentEntitled(response);

  const severity = isExpiringSoon(response.daysRemaining, response.expiryWarning)
    ? worst(REASON_SEVERITY[reason], 'warning')
    : REASON_SEVERITY[reason];

  const state: LicenceState = {
    mode: entitled ? 'full' : 'rules-only',
    reason,
    source: 'live',
    severity,
    maskedKey: input.presence.maskedKey,
    environment: input.environment,
    checkedAt: input.now.toISOString(),
    cacheAgeMs: 0,
    failureKind: null,
    observedValid: response.valid,
    observedHasFeature: response.hasFeature,
    tier: response.tier,
    daysRemaining: response.daysRemaining,
    expiryWarning: response.expiryWarning,
    expiryAt: response.expiryAt,
    features: response.features,
  };

  return {
    state: applyActivationOverride(state, input.activation),
    // The cache records what the service said, not what we decided. A sticky
    // 409 must not be baked into the entitlement snapshot, or clearing the 409
    // would leave a poisoned cache behind for up to 24 hours.
    cacheWrite: buildCacheEntry(response, input.presence.maskedKey, input.now),
  };
};

const resolveFromCache = (
  input: ResolveLicenceStateInput,
  failure: LicenceCallFailure,
  cached: CachedLicenceValidation,
  freshness: CacheFreshness,
  ageMs: number,
): ResolvedLicence => {
  const covered = freshness === 'grace';

  // `fresh` is the only branch that may still return `full`. Beyond 24h the
  // entitlement is not trusted for the paid feature — see cache.ts for why the
  // two failure directions are not symmetric.
  const reason: LicenceReason =
    freshness === 'fresh' ? entitlementReason(cached) : failureReason(failure, covered);

  const mode = freshness === 'fresh' && isEnrichmentEntitled(cached) ? 'full' : 'rules-only';

  const baseSeverity =
    freshness === 'fresh'
      ? // Serving from cache is itself worth a notice: the admin should be able
        // to tell "validated tonight" from "we have not reached Numaya since
        // Tuesday", even while nothing is degraded.
        worst(REASON_SEVERITY[reason], 'notice')
      : REASON_SEVERITY[reason];

  const severity = isExpiringSoon(cached.daysRemaining, cached.expiryWarning)
    ? worst(baseSeverity, 'warning')
    : baseSeverity;

  const state: LicenceState = {
    mode,
    reason,
    source: freshness === 'fresh' ? 'cache' : freshness === 'grace' ? 'grace' : 'none',
    severity,
    maskedKey: input.presence.maskedKey,
    environment: input.environment,
    checkedAt: input.now.toISOString(),
    cacheAgeMs: ageMs,
    failureKind: failure.kind,
    observedValid: cached.valid,
    observedHasFeature: cached.hasFeature,
    tier: cached.tier,
    daysRemaining: cached.daysRemaining,
    expiryWarning: cached.expiryWarning,
    expiryAt: cached.expiryAt,
    features: cached.features,
  };

  return {
    state: applyActivationOverride(state, input.activation),
    // A failed call never writes the cache. Refreshing `cachedAt` on a failure
    // would make the 24h and 72h windows unreachable — the cache would look
    // permanently fresh while never being re-validated, which is the exact
    // opposite of what the window is for.
    cacheWrite: null,
  };
};

export const resolveLicenceState = (
  input: ResolveLicenceStateInput,
): ResolvedLicence => {
  if (!input.presence.hasKey) {
    return {
      state: applyActivationOverride(
        emptyState(input, 'no_licence_key'),
        input.activation,
      ),
      cacheWrite: null,
    };
  }

  if (input.outcome !== null && input.outcome.kind === 'validated') {
    return resolveFromLive(input, input.outcome.response);
  }

  // No outcome with a key present means the caller could not even attempt the
  // call (no base URL configured, for instance). Treat it as a transport
  // failure so it walks the identical cache ladder rather than inventing a
  // fifteenth branch that would need its own tests.
  const failure: LicenceCallFailure =
    input.outcome === null
      ? { kind: 'transport_failure', detail: 'validation not attempted' }
      : input.outcome;

  // The service answered. There is nothing to wait out, so no cache ladder.
  if (isDefinitive(failure)) {
    const reason = failureReason(failure, false);

    return {
      state: applyActivationOverride(
        { ...emptyState(input, reason), failureKind: failure.kind },
        input.activation,
      ),
      cacheWrite: null,
    };
  }

  const { freshness, ageMs } = classifyCache(input.cached?.cachedAt, input.now);

  if (input.cached === null || freshness === null || ageMs === null) {
    const reason = failureReason(failure, false);

    return {
      state: applyActivationOverride(
        { ...emptyState(input, reason), failureKind: failure.kind },
        input.activation,
      ),
      cacheWrite: null,
    };
  }

  return resolveFromCache(input, failure, input.cached, freshness, ageMs);
};
