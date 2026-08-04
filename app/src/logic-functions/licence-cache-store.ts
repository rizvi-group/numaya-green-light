/**
 * The real licence store: Twenty's app key-value storage.
 *
 * Same shape and the same reasoning as `release-marker-store.ts` — this is the
 * only licensing module that imports the SDK, which is what lets `licence-run.ts`
 * and the whole of `src/licensing/` be driven by a fake in unit tests.
 *
 * `scope: 'WORKSPACE'` throughout, and it is not a detail. A licence belongs to
 * a workspace, its activation slot is claimed with the workspace id as the
 * fingerprint, and a read under a different scope silently finds nothing — which
 * would present as "the cache never survives a restart", i.e. as a permanent
 * grace-expired state that fails open forever and never says why.
 *
 * ## Reads are tolerant, writes are best-effort
 *
 * `kv.get` returns whatever was stored, which after an upgrade might be a shape
 * this version has never seen. Every read validates the couple of fields it
 * actually depends on and returns `null` / `unknown` otherwise, so a stale entry
 * degrades to "no cache" rather than to a `TypeError` inside a cron job.
 *
 * Writes swallow their errors for the same reason install-run's audit write
 * does: failing a licence check because the *cache* could not be written would
 * convert a storage blip into a lost validation, when the validation itself
 * already succeeded.
 */

import { kv } from 'twenty-sdk/logic-function';

import {
  CALIBRATION_CACHE_KV_KEY,
  CALIBRATION_STATE_KV_KEY,
  LICENCE_ACTIVATION_KV_KEY,
  LICENCE_CACHE_KV_KEY,
  LICENCE_STATE_KV_KEY,
} from 'src/constants/licence-identifiers';
import {
  type CachedCalibration,
  type CalibrationReaderPort,
  type CalibrationStorePort,
} from 'src/calibration/types';
import {
  describeError,
  logGreenlight,
} from 'src/logic-functions/greenlight-api';
import {
  type CachedLicenceValidation,
  type LicenceActivationState,
  type LicenceState,
  type LicenceStorePort,
} from 'src/licensing/types';

const SCOPE = { scope: 'WORKSPACE' } as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A cache entry is only usable if it carries the three things the offline path
 * reads: when it was taken, and the two gate booleans. Everything else is
 * cosmetic and is allowed to be missing.
 */
const readCacheEntry = (value: unknown): CachedLicenceValidation | null => {
  if (!isRecord(value)) {
    return null;
  }

  const { cachedAt, valid, hasFeature } = value;

  if (
    typeof cachedAt !== 'string' ||
    typeof valid !== 'boolean' ||
    typeof hasFeature !== 'boolean'
  ) {
    return null;
  }

  return {
    cachedAt,
    maskedKey: typeof value['maskedKey'] === 'string' ? value['maskedKey'] : '',
    valid,
    hasFeature,
    reason: typeof value['reason'] === 'string' ? value['reason'] : null,
    features: Array.isArray(value['features'])
      ? value['features'].filter((entry): entry is string => typeof entry === 'string')
      : [],
    tier: typeof value['tier'] === 'string' ? value['tier'] : null,
    daysRemaining:
      typeof value['daysRemaining'] === 'number' ? value['daysRemaining'] : null,
    expiryWarning: value['expiryWarning'] === true,
    expiryAt: typeof value['expiryAt'] === 'string' ? value['expiryAt'] : null,
  };
};

const readActivationState = (value: unknown): LicenceActivationState => {
  if (!isRecord(value)) {
    return { status: 'unknown' };
  }

  const status = value['status'];
  const at = typeof value['at'] === 'string' ? value['at'] : '';

  if (status === 'claimed' || status === 'limit_reached') {
    return { status, at };
  }

  return { status: 'unknown' };
};

export const kvLicenceStore: LicenceStorePort = {
  readCache: async () => {
    try {
      return readCacheEntry(await kv.get<unknown>(LICENCE_CACHE_KV_KEY, SCOPE));
    } catch (error) {
      logGreenlight('licence_cache_read_failed', { error: describeError(error) });

      return null;
    }
  },

  writeCache: async (entry) => {
    try {
      await kv.set(LICENCE_CACHE_KV_KEY, entry, SCOPE);
    } catch (error) {
      logGreenlight('licence_cache_write_failed', { error: describeError(error) });
    }
  },

  readActivation: async () => {
    try {
      return readActivationState(
        await kv.get<unknown>(LICENCE_ACTIVATION_KV_KEY, SCOPE),
      );
    } catch (error) {
      logGreenlight('licence_activation_read_failed', {
        error: describeError(error),
      });

      return { status: 'unknown' };
    }
  },

  writeActivation: async (state) => {
    try {
      await kv.set(LICENCE_ACTIVATION_KV_KEY, state, SCOPE);
    } catch (error) {
      logGreenlight('licence_activation_write_failed', {
        error: describeError(error),
      });
    }
  },

  publishState: async (state) => {
    try {
      await kv.set(LICENCE_STATE_KV_KEY, state, SCOPE);
    } catch (error) {
      logGreenlight('licence_state_publish_failed', { error: describeError(error) });
    }
  },
};

/* -------------------------------------------------------------------------- */
/* Calibration                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A cached calibration is only usable if it carries when it was taken and a
 * payload with a version. Everything else is allowed to be missing and is
 * defaulted, for the same reason the entitlement cache is read tolerantly: an
 * entry written by a previous release must degrade to "no calibration" — i.e.
 * to shipped defaults — rather than to a `TypeError` inside a cron job.
 *
 * The lists are *not* re-validated element by element here. They were validated
 * and normalised by `src/calibration/parse.ts` before the signature was checked,
 * and re-deriving that on every read would spend a scoring run's time to
 * re-establish a fact the write already established.
 */
const readCalibrationEntry = (value: unknown): CachedCalibration | null => {
  if (!isRecord(value)) {
    return null;
  }

  const { cachedAt, calibration, sealTag, verifiedAt, keyId } = value;

  if (typeof cachedAt !== 'string' || !isRecord(calibration)) {
    return null;
  }

  if (typeof calibration['calibrationVersion'] !== 'number') {
    return null;
  }

  // Every field the seal covers is read strictly, with no defaulting. A
  // defaulted value would change the canonical bytes the tag is checked against
  // and turn a legitimate entry into a seal mismatch — the failure would look
  // like tampering, which is the most misleading thing it could look like. An
  // entry missing any of them is simply not a sealed entry.
  if (
    typeof sealTag !== 'string' ||
    sealTag.length === 0 ||
    typeof verifiedAt !== 'string' ||
    typeof keyId !== 'string'
  ) {
    return null;
  }

  return {
    cachedAt,
    verifiedAt,
    keyId,
    sealTag,
    calibration: calibration as unknown as CachedCalibration['calibration'],
  };
};

export const kvCalibrationStore: CalibrationStorePort = {
  readCalibration: async () => {
    try {
      return readCalibrationEntry(
        await kv.get<unknown>(CALIBRATION_CACHE_KV_KEY, SCOPE),
      );
    } catch (error) {
      logGreenlight('calibration_cache_read_failed', {
        error: describeError(error),
      });

      return null;
    }
  },

  writeCalibration: async (entry) => {
    try {
      await kv.set(CALIBRATION_CACHE_KV_KEY, entry, SCOPE);
    } catch (error) {
      logGreenlight('calibration_cache_write_failed', {
        error: describeError(error),
      });
    }
  },

  clearCalibration: async () => {
    try {
      // `kv.set(key, null)` rather than a delete: the SDK's key-value surface
      // has no delete, and a stored `null` fails `readCalibrationEntry`'s record
      // check, which is exactly "no calibration". Writing an empty object would
      // not — it would parse as a record and then fail on a missing field, which
      // is the same outcome by a longer route and one more shape to reason about.
      await kv.set(CALIBRATION_CACHE_KV_KEY, null, SCOPE);
    } catch (error) {
      logGreenlight('calibration_cache_clear_failed', {
        error: describeError(error),
      });
    }
  },

  publishCalibrationState: async (state) => {
    try {
      await kv.set(CALIBRATION_STATE_KV_KEY, state, SCOPE);
    } catch (error) {
      logGreenlight('calibration_state_publish_failed', {
        error: describeError(error),
      });
    }
  },
};

/**
 * The scoring path's view: read-only, and narrower than the store above.
 *
 * A scoring run must not be handed something it could write through — the same
 * argument that keeps `readPublishedLicenceState` off `LicenceStorePort`. A run
 * that could rewrite the calibration cache would be a run that could change what
 * every *subsequent* lead is scored against, from inside a per-lead code path.
 */
export const kvCalibrationReader: CalibrationReaderPort = {
  read: () => kvCalibrationStore.readCalibration(),
};

/**
 * Read the published calibration state back, for the admin panel.
 *
 * Returns `null` rather than a synthetic "shipped defaults" state when nothing
 * has been published: "this workspace has never run a licence check" and "this
 * workspace ran one and is on shipped defaults" are different things to show a
 * human, and inventing the second would hide the first.
 */
export const readPublishedCalibrationState = async (): Promise<unknown> => {
  try {
    const value = await kv.get<unknown>(CALIBRATION_STATE_KV_KEY, SCOPE);

    return isRecord(value) && typeof value['status'] === 'string' ? value : null;
  } catch (error) {
    logGreenlight('calibration_state_read_failed', {
      error: describeError(error),
    });

    return null;
  }
};

/**
 * Read the published state back — what a future enrichment path calls before
 * consulting `isEnrichmentEnabled`. Deliberately not on `LicenceStorePort`: the
 * port is the *writer's* interface, and enrichment has no business being handed
 * something it could write through.
 */
export const readPublishedLicenceState = async (): Promise<LicenceState | null> => {
  try {
    const value = await kv.get<unknown>(LICENCE_STATE_KV_KEY, SCOPE);

    if (!isRecord(value) || typeof value['mode'] !== 'string') {
      return null;
    }

    return value as unknown as LicenceState;
  } catch (error) {
    logGreenlight('licence_state_read_failed', { error: describeError(error) });

    return null;
  }
};
