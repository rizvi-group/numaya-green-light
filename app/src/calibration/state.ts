/**
 * Resolving "am I running shipped defaults or calibration vNN, and when did it
 * last refresh?" — one pure function, `now` injected, no I/O.
 *
 * ===========================================================================
 * ## The same ladder as the entitlement, for the same reasons
 *
 * Calibration is cached beside the entitlement in workspace key-value storage
 * and walks the identical 24h / 72h freshness ladder from
 * `src/licensing/cache.ts`. Sharing the arithmetic is not laziness — the two
 * caches are refreshed by the *same nightly run*, so any second ladder would
 * differ from this one only by drifting out of step with it.
 *
 * Where the two differ is what the far end of the ladder means, and the
 * difference is the whole point:
 *
 *   | Age        | Entitlement                  | Calibration                 |
 *   |------------|------------------------------|-----------------------------|
 *   | `< 24h`    | used as-is                   | used as-is                  |
 *   | `24–72h`   | rules-only ("grace")         | **still used**              |
 *   | `> 72h`    | rules-only + loud warning    | shipped defaults            |
 *
 * The entitlement tightens at 24h because trusting a stale one risks serving a
 * paid feature to a revoked licence, and revocation has to work. Calibration
 * carries no such risk: it is a word list. Dropping it the moment Numaya has a
 * bad night would make a customer's scores move for a reason that has nothing to
 * do with their data, which is a worse outcome than a slightly old vocabulary.
 * So calibration survives the grace window and is only abandoned past 72h, at
 * which point "we have not spoken to Numaya in three days" is a real statement
 * about the install and the admin should be seeing shipped-default behaviour
 * they can reason about.
 *
 * Note the asymmetry is safe in both directions: past 72h calibration falls back
 * to the shipped defaults, which is a *working product*, not a degraded one.
 * There is no branch below that can stop a lead being scored.
 * ===========================================================================
 */

import { classifyCache } from 'src/licensing/cache';
import {
  type CachedCalibration,
  type Calibration,
  type CalibrationCounts,
  type CalibrationReason,
  type CalibrationState,
} from 'src/calibration/types';

export const countCalibration = (
  calibration: Calibration,
): CalibrationCounts => ({
  decisionMakerTitles: calibration.decisionMakerTitles.length,
  influencerTitles: calibration.influencerTitles.length,
  roleInboxLocalParts: calibration.roleInboxLocalParts.length,
  placeholderValues: calibration.placeholderValues.length,
  industrySynonyms: Object.keys(calibration.industrySynonyms).length,
});

/**
 * The state to publish when no usable calibration exists.
 *
 * Every field that describes a payload is `null` rather than zero or empty
 * string: "there is no calibration" and "there is a calibration with nothing in
 * it" must not render the same in the admin panel, and a zero count is exactly
 * how the second one would look.
 */
export const shippedDefaultsState = (
  reason: CalibrationReason,
  now: Date,
): CalibrationState => ({
  status: 'shipped_defaults',
  reason,
  source: 'none',
  calibrationVersion: null,
  issuedAt: null,
  refreshedAt: null,
  checkedAt: now.toISOString(),
  cacheAgeMs: null,
  keyId: null,
  counts: null,
});

export const calibratedState = (
  entry: CachedCalibration,
  source: 'live' | 'cache',
  cacheAgeMs: number | null,
  now: Date,
): CalibrationState => ({
  status: 'calibrated',
  reason: 'calibrated',
  source,
  calibrationVersion: entry.calibration.calibrationVersion,
  issuedAt: entry.calibration.issuedAt.length > 0 ? entry.calibration.issuedAt : null,
  refreshedAt: entry.verifiedAt,
  checkedAt: now.toISOString(),
  cacheAgeMs,
  keyId: entry.keyId,
  counts: countCalibration(entry.calibration),
});

/**
 * Age at which a cached calibration stops being used. Deliberately the
 * entitlement's *outer* limit, not its inner one — see the table above.
 */
export const CALIBRATION_MAX_AGE_MS = 72 * 60 * 60 * 1000;

export interface ResolveCalibrationInput {
  /** The cached payload, or `null` when none has ever been stored. */
  readonly cached: CachedCalibration | null;
  readonly now: Date;
}

export interface ResolvedCalibration {
  readonly state: CalibrationState;
  /** The payload the scoring path should use, or `null` for shipped defaults. */
  readonly calibration: Calibration | null;
}

/**
 * What the scoring path should use right now, and what the admin should be told.
 *
 * ===========================================================================
 * ## Why there is no entitlement check here
 *
 * Because the *existence of the cache is* the entitlement check, and moving it
 * to the writer is what keeps a licence lookup out of the per-lead scoring path.
 *
 * `refreshCalibration` writes the cache only while the licence resolves to
 * `full`, and **deletes it** the moment a nightly run finds the entitlement
 * gone. So a present, fresh cache already means "this workspace was entitled at
 * its last successful licence check". Re-deriving that per lead would mean a
 * second key-value read on the hot path to re-establish a fact the nightly run
 * has already written down.
 *
 * The consequence is a revocation latency of at most 24 hours — one nightly
 * cycle — which is exactly the latency enrichment revocation already has and is
 * documented as having, for the same reason: the alternative is putting a
 * network call to Numaya in front of a customer's scoring path, which is the
 * coupling the fail-open rule exists to prevent.
 *
 * The reverse case costs the customer one night. A renewed licence re-fetches on
 * the next run, and until then the workspace scores on shipped defaults — the
 * full working product, exactly as an unlicensed install always has.
 * ===========================================================================
 */
export const resolveCalibration = (
  input: ResolveCalibrationInput,
): ResolvedCalibration => {
  if (input.cached === null) {
    return {
      state: shippedDefaultsState('not_provisioned', input.now),
      calibration: null,
    };
  }

  const { ageMs } = classifyCache(input.cached.cachedAt, input.now);

  // An unreadable `cachedAt` is treated as expired rather than as fresh. The
  // opposite choice would make a corrupt timestamp mean "trust this forever",
  // which is the one thing a freshness check must never be talked into.
  if (ageMs === null || ageMs >= CALIBRATION_MAX_AGE_MS) {
    return {
      state: {
        ...shippedDefaultsState('stale', input.now),
        cacheAgeMs: ageMs,
        calibrationVersion: input.cached.calibration.calibrationVersion,
        keyId: input.cached.keyId,
      },
      calibration: null,
    };
  }

  return {
    state: calibratedState(
      input.cached,
      ageMs === 0 ? 'live' : 'cache',
      ageMs,
      input.now,
    ),
    calibration: input.cached.calibration,
  };
};
