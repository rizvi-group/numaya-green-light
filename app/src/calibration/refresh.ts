/**
 * The calibration half of a licence run: read what the `validate` response
 * carried, verify it, cache it, publish what an admin should see.
 *
 * ===========================================================================
 * ## Why this rides on the existing nightly revalidation
 *
 * It costs nothing. `runLicenceRevalidation` already calls
 * `POST /v1/licenses/validate` once a night at 03:17 UTC, and the response
 * already carries `customerMetadata` — the calibration arrives in bytes we were
 * fetching anyway. There is no second endpoint, no second credential, no second
 * timeout to tune, and no new failure mode: a run that could not reach Numaya
 * could not have fetched calibration either, and both fall back together.
 *
 * That was not the original plan. The plan was `GET /v1/licenses/{id}/config`,
 * which is the endpoint built for exactly this and which Greenlight cannot call
 * — it refuses licence-key credentials by design. `src/calibration/types.ts`
 * has the measurements and the service's own documentation of that refusal.
 *
 * ## Ordering: entitlement first, always
 *
 * `refreshCalibration` runs *after* the licence state is resolved and published,
 * and takes the resolved entitlement as an input. Two reasons, and the second is
 * the load-bearing one:
 *
 *  1. An unentitled licence should not have its calibration refreshed, and
 *     asking the entitlement is how we know.
 *  2. **Nothing in this file may be able to delay or fail the entitlement.**
 *     Enrichment gating, the audit row and the admin notice all depend on the
 *     licence state being published; a signature verification that hung or threw
 *     ahead of it would turn a word list into a dependency of the paid feature.
 *     Running afterwards makes that structurally impossible rather than merely
 *     unlikely.
 *
 * ## Every path ends in a published state
 *
 * Including the paths that fail. An admin who cannot tell the difference between
 * "calibration is off" and "calibration broke and nobody said" has been given
 * nothing, so `not_provisioned`, `signature_invalid`, `unknown_key` and
 * `verifier_unavailable` are all published as distinct reasons — even though all
 * four behave identically, which is to say the product keeps working on shipped
 * defaults.
 * ===========================================================================
 */

import { canonicalise } from 'src/calibration/canonical';
import { readCalibrationEnvelope } from 'src/calibration/parse';
import { NO_SEAL, type CalibrationSealPort } from 'src/calibration/seal';
import {
  calibratedState,
  countCalibration,
  resolveCalibration,
  shippedDefaultsState,
} from 'src/calibration/state';
import {
  type CachedCalibration,
  type CalibrationState,
  type CalibrationStorePort,
  type SealedCalibrationBody,
} from 'src/calibration/types';
import { verifyCalibrationEnvelope } from 'src/calibration/verify';

/**
 * The canonical bytes a cache entry's seal covers.
 *
 * Shared by the writer here and the reader in `scoring-run.ts` — one function,
 * so the two cannot disagree about what is inside the MAC. `canonicalise`
 * sorts keys recursively, which is what makes the tag survive the round trip
 * through the workspace's key-value store.
 */
export const sealedCalibrationBody = (
  body: SealedCalibrationBody,
): string | null =>
  canonicalise({
    cachedAt: body.cachedAt,
    verifiedAt: body.verifiedAt,
    keyId: body.keyId,
    calibration: body.calibration,
  });

export interface RefreshCalibrationInput {
  readonly store: CalibrationStorePort;
  /**
   * Binds the cached copy to this workspace's licence key. Defaults to
   * `NO_SEAL`, which cannot produce a tag — and an entry that cannot be sealed
   * is not written at all, so the default is "no cache" rather than "a cache
   * nothing checks".
   */
  readonly seal?: CalibrationSealPort;
  /**
   * `customerMetadata` from the live `validate` response, or `undefined` when
   * the run had no live response at all — an outage, or no licence key.
   */
  readonly metadata: unknown;
  /** Whether a live answer was received. `false` means "do not touch the cache". */
  readonly live: boolean;
  /** The resolved entitlement: `state.mode === 'full'`. */
  readonly entitled: boolean;
  readonly now: Date;
}

export interface RefreshCalibrationOutcome {
  readonly state: CalibrationState;
  /** Non-null only when a fresh payload was verified and written this run. */
  readonly written: CachedCalibration | null;
  /** For the structured log line. Never contains payload content. */
  readonly detail: string | null;
}

/**
 * Fetch-verify-cache, as one function with no exceptions and no clock read.
 *
 * ## Why an unentitled run clears the cache
 *
 * This is the one place the paid boundary is enforced, and it is enforced by
 * deletion rather than by a flag. The scoring path then needs no entitlement
 * check of its own: a cache that exists is a cache that was written while the
 * licence resolved to `full`. See `src/calibration/state.ts`, "Why there is no
 * entitlement check here", for why keeping a licence lookup out of the per-lead
 * path is worth a deletion.
 *
 * The cost is that a licence restored after a lapse waits one nightly cycle
 * before calibration returns. That is a day of shipped-default scoring — the
 * full working product — against the alternative of a workspace keeping a paid
 * vocabulary for three days after it stopped paying for it.
 *
 * ## Why a failed verification does *not* clear the cache
 *
 * A payload that arrives corrupted is evidence about *that response*, not about
 * the payload verified last night. Discarding a good cached calibration because
 * a proxy mangled one nightly response would let a single bad night undo a
 * working install. The bad payload is refused, the reason is published, and the
 * previously verified cache continues to age out on its own 72-hour clock — so
 * a genuinely revoked or permanently-broken calibration still expires, it just
 * does not vanish on the first hiccup.
 */
export const refreshCalibration = async (
  input: RefreshCalibrationInput,
): Promise<RefreshCalibrationOutcome> => {
  if (!input.entitled) {
    await clearQuietly(input.store);

    const state = shippedDefaultsState('not_licensed', input.now);
    await publish(input.store, state);

    return { state, written: null, detail: null };
  }

  if (!input.live) {
    // No live answer: nothing new to say about calibration, so republish what
    // the cache currently amounts to. Publishing a *failure* here would report
    // the outage twice — the licence state already says it — and would blank the
    // version number the admin panel is showing.
    //
    // The state is derived through `resolveCalibration`, the same function the
    // scoring path uses, rather than assembled here. That is the whole point:
    // a cache past 72h is no longer applied to leads, and a panel that said
    // "calibration v1" while the engine was quietly on shipped defaults would be
    // worse than a panel that said nothing. One function, one answer.
    const cached = await readQuietly(input.store);
    const { state } = resolveCalibration({ cached, now: input.now });

    await publish(input.store, state);

    return { state, written: null, detail: null };
  }

  const read = readCalibrationEnvelope(input.metadata);

  if (read.kind === 'rejected') {
    const state = shippedDefaultsState(read.reason, input.now);
    await publish(input.store, state);

    return { state, written: null, detail: read.detail };
  }

  const verification = await verifyCalibrationEnvelope(read.envelope);

  if (verification.kind === 'rejected') {
    const state = shippedDefaultsState(verification.reason, input.now);
    await publish(input.store, state);

    return { state, written: null, detail: verification.detail };
  }

  const body: SealedCalibrationBody = {
    cachedAt: input.now.toISOString(),
    verifiedAt: input.now.toISOString(),
    keyId: read.envelope.keyId,
    calibration: verification.calibration,
  };

  const canonical = sealedCalibrationBody(body);
  const sealTag =
    canonical === null ? null : await (input.seal ?? NO_SEAL).seal(canonical);

  // No tag, no cache. Writing an unsealed entry would mean a subsequent read
  // either has to accept it — defeating the seal entirely — or reject it, which
  // is what happens anyway. Not writing is the same outcome with one fewer
  // shape in the store.
  if (sealTag === null) {
    const state = shippedDefaultsState('cache_unsealed', input.now);
    await publish(input.store, state);

    return {
      state,
      written: null,
      detail: 'calibration verified but could not be sealed to this licence key',
    };
  }

  const entry: CachedCalibration = { ...body, sealTag };

  await writeQuietly(input.store, entry);

  const state = calibratedState(entry, 'live', 0, input.now);
  await publish(input.store, state);

  return {
    state,
    written: entry,
    detail: `calibration v${verification.calibration.calibrationVersion} verified against ${read.envelope.keyId}`,
  };
};

/**
 * A count summary safe to put in a log line.
 *
 * The payload itself is never logged: it is a few hundred kilobytes of word
 * lists, and a nightly cron that dumps it into the platform's log stream would
 * be indistinguishable from a bug.
 */
export const describeCalibration = (
  outcome: RefreshCalibrationOutcome,
): Record<string, unknown> => ({
  calibrationStatus: outcome.state.status,
  calibrationReason: outcome.state.reason,
  calibrationSource: outcome.state.source,
  calibrationVersion: outcome.state.calibrationVersion,
  calibrationKeyId: outcome.state.keyId,
  calibrationRefreshedAt: outcome.state.refreshedAt,
  ...(outcome.written === null
    ? {}
    : { calibrationCounts: countCalibration(outcome.written.calibration) }),
  ...(outcome.detail === null ? {} : { calibrationDetail: outcome.detail }),
});

/* -------------------------------------------------------------------------- */
/* Storage, swallowed                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Storage failures are absorbed here rather than at the adapter, so that a
 * *test double* that throws is handled identically to the real store, which
 * logs and returns. A calibration cache is a convenience; failing a licence run
 * over one would be trading the load-bearing thing for the optional one.
 */
const readQuietly = async (
  store: CalibrationStorePort,
): Promise<CachedCalibration | null> => {
  try {
    return await store.readCalibration();
  } catch {
    return null;
  }
};

const writeQuietly = async (
  store: CalibrationStorePort,
  entry: CachedCalibration,
): Promise<void> => {
  try {
    await store.writeCalibration(entry);
  } catch {
    // Swallowed: the state published below still says what was verified, and
    // the next run re-verifies from the same source.
  }
};

/**
 * A clear that fails leaves a workspace calibrated for up to another 72 hours,
 * after which the age check in `resolveCalibration` retires it regardless. So
 * the failure is bounded by the freshness ladder rather than open-ended, and
 * failing the licence run over it would trade a bounded problem for an
 * unbounded one.
 */
const clearQuietly = async (store: CalibrationStorePort): Promise<void> => {
  try {
    await store.clearCalibration();
  } catch {
    // Swallowed. See above.
  }
};

const publish = async (
  store: CalibrationStorePort,
  state: CalibrationState,
): Promise<void> => {
  try {
    await store.publishCalibrationState(state);
  } catch {
    // Swallowed for the same reason. The admin panel shows a stale state for a
    // night; nothing about scoring changes.
  }
};
