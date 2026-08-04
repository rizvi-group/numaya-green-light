/**
 * The feature gate — the only sanctioned way to ask "may enrichment run".
 *
 * ===========================================================================
 * ## Deterministic scoring is not gated. There is no switch for it.
 *
 * Look for a `isScoringEnabled` here and you will not find one, and that is the
 * design rather than an omission. Greenlight's deterministic gate is the free
 * floor: it runs with no licence key, with an expired licence, with a revoked
 * licence, and during a total Numaya outage. A licence problem degrades the
 * product; it must never stop leads being scored, because the lead is the
 * customer's asset and we do not get to hold it hostage over our billing.
 *
 * The enforcement is structural, not documentary:
 *
 *  - `scoring-run.ts` does not import this module, and nothing in
 *    `src/scoring/` does either. There is no code path from a licence state to
 *    a scoring decision.
 *  - This module's only consumers are enrichment-side.
 *  - `__tests__/scoring-unaffected.test.ts` scores the same lead under every
 *    licence state this client can produce and asserts an identical result.
 *
 * ## Why this exists before enrichment does
 *
 * Enrichment lands in v0.2. Wiring speculative calls into a subsystem that does
 * not exist would mean inventing its shape now and being wrong; shipping the
 * licensing client without any consumer would mean the gate's semantics get
 * decided later, in a hurry, by whoever writes the first enrichment call — and
 * the two `valid`/`hasFeature` gotchas are exactly the sort of thing that gets
 * decided wrongly in a hurry.
 *
 * So the predicate is named, tested and documented now, and v0.2 consumes it:
 *
 * ```ts
 * const licence = await readPublishedLicenceState(store);
 *
 * if (!isEnrichmentEnabled(licence)) {
 *   return { score, scoreOnly: true, reason: enrichmentDisabledReason(licence) };
 * }
 * ```
 *
 * Note that even that call is not on the scoring path — it sits after the score
 * is computed, deciding only whether to *add* to it.
 * ===========================================================================
 */

import {
  type LicenceMode,
  type LicenceReason,
  type LicenceState,
} from 'src/licensing/types';

/**
 * The predicate v0.2's enrichment path consumes.
 *
 * Takes the resolved state rather than a raw response on purpose: by this point
 * the `valid && hasFeature` conjunction, the cache ladder and the sticky
 * activation override have all been applied. A caller cannot accidentally
 * reconstruct the wrong gate, because the only thing it is handed is the answer.
 *
 * `null` — no state has ever been published, i.e. the app has never completed a
 * licence check — reads as disabled. That is the safe direction for a paid
 * feature and the honest one: we do not know that this workspace is entitled.
 */
export const isEnrichmentEnabled = (state: LicenceState | null): boolean =>
  state !== null && state.mode === 'full';

/**
 * Why enrichment is off, for the trace and the UI. `null` when it is on.
 */
export const enrichmentDisabledReason = (
  state: LicenceState | null,
): LicenceReason | null => {
  if (state === null) {
    return 'licence_service_unreachable_grace_expired';
  }

  return state.mode === 'full' ? null : state.reason;
};

/**
 * Everything an enrichment caller needs in one read, so it never has to touch
 * `state.mode` or `state.reason` directly.
 */
export interface EnrichmentGate {
  readonly enabled: boolean;
  readonly mode: LicenceMode;
  readonly reason: LicenceReason | null;
}

export const describeEnrichmentGate = (
  state: LicenceState | null,
): EnrichmentGate => ({
  enabled: isEnrichmentEnabled(state),
  mode: state === null ? 'rules-only' : state.mode,
  reason: enrichmentDisabledReason(state),
});

/**
 * Stated as executable documentation, and asserted in the test suite.
 *
 * It exists so that a future change which *does* try to gate scoring has to
 * delete a function whose name says what it is doing, rather than quietly adding
 * an `if`.
 */
export const isDeterministicScoringLicensed = (): true => true;
