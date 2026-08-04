/**
 * The entitlement gate: turning one `validate` response into "may enrichment
 * run, and if not, why not".
 *
 * This module exists because the obvious implementation is wrong in two
 * directions at once, and both were confirmed by live test rather than inferred
 * from the service's documented reason codes.
 *
 * ---------------------------------------------------------------------------
 * ## Gotcha 1 — `valid` and `hasFeature` are independent
 *
 * The service documents a reason code `feature_not_licensed`, which invites the
 * assumption that an unlicensed feature makes the whole validation fail. It does
 * not. Two observed responses:
 *
 * | Licence                       | `valid` | `reason`      | `hasFeature` |
 * |-------------------------------|---------|---------------|--------------|
 * | Rules-only, asked `enrichment` | `true`  | `null`        | **`false`**  |
 * | Suspended, asked `enrichment`  | `false` | `"suspended"` | **`true`**   |
 *
 * So each single-boolean check is wrong in a different and expensive way:
 *
 * - `if (response.valid)` — enables the **paid feature on a licence that does
 *   not include it**. Revenue leak, and it would never surface as a bug report
 *   because the customer is delighted.
 * - `if (response.hasFeature)` — keeps enrichment running on a **suspended**
 *   licence, because `hasFeature` still reports the policy's feature list.
 *   Suspension is the reversible lever Numaya pulls on non-payment; ignoring it
 *   makes the lever useless.
 *
 * The only correct gate is the conjunction, and it is written exactly once, in
 * `isEnrichmentEntitled` below. Nothing else in this codebase may read
 * `.hasFeature` on its own.
 *
 * ## The reason we have to invent
 *
 * When `valid: true, hasFeature: false`, the service sends `reason: null` —
 * there is nothing wrong with the licence, it simply does not include the
 * feature. That is still the single most important thing to tell an admin who is
 * wondering why enrichment is off, so we *derive* `feature_not_licensed`
 * ourselves. It is in the `LicenceReason` union for that reason and no other:
 * it never arrives over the wire.
 *
 * ---------------------------------------------------------------------------
 * ## Gotcha 4 — `license_not_found` cannot mean "the key has a typo"
 *
 * This is the one that would have cost us a customer.
 *
 * A sandbox licence is invisible to a request that does not carry
 * `X-Numaya-Environment: sandbox`. What comes back is not an error:
 *
 * ```
 * POST /v1/licenses/validate  {key, feature}            → 200 valid:false reason:license_not_found
 * POST /v1/licenses/validate  {key, feature} + sandbox  → 200 valid:true  hasFeature:true
 * ```
 *
 * A plausible rejection with a plausible reason, on the happy status code. Read
 * naively it says "bad key", the admin retypes a key that was always correct,
 * and the workspace sits in rules-only forever while every layer of the
 * fail-open design politely hides it.
 *
 * ### Why treating it as an environment problem is honest
 *
 * Because the service itself separates the two causes, and we measured where it
 * draws the line (2026-08-04, live):
 *
 * | Key                                        | Response                            |
 * |--------------------------------------------|-------------------------------------|
 * | Not a key the service knows, any shape     | **`401`**, empty body               |
 * | One character altered in a real key        | **`401`**, empty body               |
 * | A real key, wrong environment              | `200 valid:false license_not_found` |
 * | A real key, right environment              | `200 valid:true`                    |
 *
 * The key **is** the credential on these endpoints — it is sent in the request
 * body in place of an `Authorization` header — so a key the service cannot
 * resolve at all fails authentication and never reaches the licence lookup.
 * `license_not_found` is therefore only reachable by a key that authenticated:
 * it exists, it is spelled correctly, and no licence matched it *in the
 * environment this request asked for*.
 *
 * That leaves exactly two causes, and the notice in `audit.ts` names both:
 * we asked the wrong environment, or the licence was deleted from the right
 * one. What it must never say is "check the key for a typo" — the 401 above is
 * what a typo actually looks like, and it maps to `invalid_licence`, which says
 * precisely that.
 *
 * No signal here is invented. We do not guess the environment from the shape of
 * the key: customer licence keys are `NUMAYA-XXXXX-XXXXX-XXXXX-X` in **both**
 * environments and carry no sandbox marker. (The `nml_live_` / `nml_test_`
 * prefixes in the spec belong to org API keys, which Greenlight never holds.)
 * The only thing we know is which environment *we* asked for, and that is a
 * local fact we can state without inference.
 * ---------------------------------------------------------------------------
 */

import { LICENCE_NOT_FOUND_REASON } from 'src/constants/licence-identifiers';
import {
  type LicenceReason,
  type LicenceValidationResponse,
} from 'src/licensing/types';

/**
 * The reason strings the service is documented to send when `valid: false`.
 * Anything outside this set is mapped to `invalid_licence` rather than passed
 * through, so a new reason code shipped by Numaya cannot inject an unknown
 * string into audit rows the admin filters on.
 *
 * `device_not_activated` is listed even though it was never observed for our
 * policy types — see gotcha 2 in `state.ts`. If a future `NodeLocked` policy
 * does produce it, it should read as itself, not as a generic failure.
 */
const KNOWN_INVALID_REASONS: ReadonlySet<string> = new Set<LicenceReason>([
  'revoked',
  'suspended',
  'expired',
  'device_not_activated',
  'feature_not_licensed',
  'quota_exceeded',
]);

export const normaliseInvalidReason = (
  reason: string | null,
): LicenceReason => {
  // Gotcha 4. Checked before the known-reason set because the service's spelling
  // (`license_not_found`) is not a member of `LicenceReason` and would otherwise
  // fall through to `invalid_licence` — whose admin notice tells the customer to
  // check their key for a typo, which is the single most misleading thing we
  // could say about a correctly-typed key pointed at the wrong environment.
  if (reason !== null && reason.trim().toLowerCase() === LICENCE_NOT_FOUND_REASON) {
    return 'licence_not_found_in_environment';
  }

  if (reason !== null && KNOWN_INVALID_REASONS.has(reason)) {
    return reason as LicenceReason;
  }

  return 'invalid_licence';
};

/**
 * The gate. **Both** booleans, always.
 *
 * Takes a structural type rather than the full response so the cached
 * entitlement — which stores the same two booleans and nothing else about the
 * decision — goes through the identical predicate. One gate, two callers, no
 * chance of the cache path drifting from the live path.
 */
export const isEnrichmentEntitled = (entitlement: {
  readonly valid: boolean;
  readonly hasFeature: boolean;
}): boolean => entitlement.valid === true && entitlement.hasFeature === true;

/**
 * Why enrichment is on or off, for one entitlement.
 *
 * Order matters and is the whole point:
 *
 *  1. `!valid` wins outright — a suspended licence is suspended regardless of
 *     what its feature list still claims. Reporting `feature_not_licensed` for
 *     a suspended licence with the feature would send the admin to the wrong
 *     support page entirely.
 *  2. `valid && !hasFeature` is the derived `feature_not_licensed` — the
 *     licence is healthy, this capability simply is not part of it. This is the
 *     upgrade prompt, not an error.
 *  3. Otherwise: licensed.
 */
export const entitlementReason = (entitlement: {
  readonly valid: boolean;
  readonly hasFeature: boolean;
  readonly reason: string | null;
}): LicenceReason => {
  if (!entitlement.valid) {
    return normaliseInvalidReason(entitlement.reason);
  }

  if (!entitlement.hasFeature) {
    return 'feature_not_licensed';
  }

  return 'licensed';
};

/**
 * Convenience for the live path: both answers from one response.
 */
export const resolveEntitlement = (
  response: LicenceValidationResponse,
): { readonly entitled: boolean; readonly reason: LicenceReason } => ({
  entitled: isEnrichmentEntitled(response),
  reason: entitlementReason(response),
});
