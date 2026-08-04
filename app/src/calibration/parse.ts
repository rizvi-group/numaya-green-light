/**
 * Reading a calibration envelope out of whatever the licensing service sent.
 *
 * The input is the `customerMetadata` object from a `validate` response — a
 * free-form JSON document, authored by us but stored, re-serialised and
 * returned by a service we do not deploy in lockstep with this app. It is
 * untrusted in the ordinary sense (it crossed a network) and unstable in the
 * boring sense (a future release may put other things beside ours in there).
 *
 * So parsing is **total**: it never throws, it never returns `undefined`, and
 * every malformed shape becomes a named rejection rather than a `TypeError`
 * inside a customer's nightly cron job.
 *
 * ## Why the envelope lives under one namespaced key
 *
 * `customerMetadata.greenlightCalibration`, not the root. The field is the
 * licence's general-purpose metadata bag and there is every chance it will one
 * day also carry a customer reference, a support tier, or a flag for some
 * feature that does not exist yet. Owning one key means none of that collides
 * with us and none of it changes the bytes we verify — the signature covers the
 * envelope, not its surroundings, so a sibling key appearing next to ours must
 * not invalidate a payload. Namespacing is what makes that true.
 *
 * ## Every list is normalised here, once
 *
 * Entries are lower-cased, trimmed and de-duplicated at the boundary rather
 * than at the point of use. `src/scoring/rules/helpers.ts` normalises again on
 * every comparison and would cope regardless — but doing it here means the
 * counts shown to an admin are the counts that actually take effect, and a
 * payload with `"CEO"` and `"ceo"` in it does not read as 200 titles when it
 * carries 199.
 */

import {
  CALIBRATION_SCHEMA_VERSION,
  type Calibration,
  type CalibrationVerification,
  type SignedCalibrationEnvelope,
} from 'src/calibration/types';

/** The key our envelope occupies inside the licence's metadata bag. */
export const CALIBRATION_METADATA_KEY = 'greenlightCalibration';

export type EnvelopeRead =
  | { readonly kind: 'envelope'; readonly envelope: SignedCalibrationEnvelope }
  | {
      readonly kind: 'rejected';
      readonly reason: Extract<
        CalibrationVerification,
        { kind: 'rejected' }
      >['reason'];
      readonly detail: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const reject = (
  reason: Extract<CalibrationVerification, { kind: 'rejected' }>['reason'],
  detail: string,
): EnvelopeRead => ({ kind: 'rejected', reason, detail });

/**
 * A list of lowercase, trimmed, de-duplicated non-empty strings.
 *
 * Non-strings are dropped rather than rejected: one bad entry in a list of two
 * hundred should cost that entry, not the whole calibration. A list that is not
 * an array at all is a different matter and is handled by the caller.
 */
const readStringList = (value: unknown): readonly string[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }

  const seen = new Set<string>();

  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue;
    }

    const normalised = entry.trim().toLowerCase().replace(/\s+/g, ' ');

    if (normalised.length > 0) {
      seen.add(normalised);
    }
  }

  return [...seen];
};

/**
 * The synonym taxonomy: canonical term → variants.
 *
 * A canonical whose variant list is unusable is dropped whole rather than kept
 * empty, because an empty variant list would expand a workspace's ICP by
 * nothing while still appearing in the admin panel's count as if it had done
 * something.
 */
const readSynonyms = (
  value: unknown,
): Readonly<Record<string, readonly string[]>> | null => {
  if (!isRecord(value)) {
    return null;
  }

  const table: Record<string, readonly string[]> = {};

  for (const [rawCanonical, rawVariants] of Object.entries(value)) {
    const canonical = rawCanonical.trim().toLowerCase().replace(/\s+/g, ' ');

    if (canonical.length === 0) {
      continue;
    }

    const variants = readStringList(rawVariants);

    if (variants === null) {
      continue;
    }

    // The canonical is never one of its own variants — it is already matched
    // directly — and letting it in would double-count in the admin panel.
    //
    // The self-reference is stripped *before* the emptiness check, not after.
    // Stripping afterwards left `{ construction: ['construction'] }` surviving
    // as an empty cluster: harmless for scoring, but it inflated the synonym
    // count the admin panel shows, which is the one thing this filter exists to
    // stop.
    const distinct = variants.filter((variant) => variant !== canonical);

    if (distinct.length === 0) {
      continue;
    }

    table[canonical] = distinct;
  }

  return table;
};

const readInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;

const readPayload = (raw: unknown): Calibration | { readonly error: string } => {
  if (!isRecord(raw)) {
    return { error: 'payload is not a JSON object' };
  }

  const schemaVersion = readInteger(raw['schemaVersion']);

  if (schemaVersion === null) {
    return { error: 'payload has no non-negative integer schemaVersion' };
  }

  const calibrationVersion = readInteger(raw['calibrationVersion']);

  if (calibrationVersion === null) {
    return { error: 'payload has no non-negative integer calibrationVersion' };
  }

  const decisionMakerTitles = readStringList(raw['decisionMakerTitles']);
  const influencerTitles = readStringList(raw['influencerTitles']);
  const roleInboxLocalParts = readStringList(raw['roleInboxLocalParts']);
  const placeholderValues = readStringList(raw['placeholderValues']);
  const industrySynonyms = readSynonyms(raw['industrySynonyms']);

  // Absent is fine and means "this pack has no opinion about that list" — the
  // shipped default survives for it. Present-but-not-an-array is not fine: it
  // means the payload is a shape we do not understand, and guessing would be
  // how a calibration silently stops applying half of itself.
  if (
    (raw['decisionMakerTitles'] !== undefined && decisionMakerTitles === null) ||
    (raw['influencerTitles'] !== undefined && influencerTitles === null) ||
    (raw['roleInboxLocalParts'] !== undefined && roleInboxLocalParts === null) ||
    (raw['placeholderValues'] !== undefined && placeholderValues === null) ||
    (raw['industrySynonyms'] !== undefined && industrySynonyms === null)
  ) {
    return { error: 'one or more calibration lists were not of the expected type' };
  }

  return {
    schemaVersion,
    calibrationVersion,
    issuedAt:
      typeof raw['issuedAt'] === 'string' && raw['issuedAt'].length > 0
        ? raw['issuedAt']
        : '',
    notes: typeof raw['notes'] === 'string' ? raw['notes'] : null,
    decisionMakerTitles: decisionMakerTitles ?? [],
    influencerTitles: influencerTitles ?? [],
    roleInboxLocalParts: roleInboxLocalParts ?? [],
    placeholderValues: placeholderValues ?? [],
    industrySynonyms: industrySynonyms ?? {},
  };
};

/**
 * Pull the envelope out of a licence's `customerMetadata`.
 *
 * Returns `not_provisioned` — not an error — when the key is simply absent.
 * That is the normal state of every licence issued before calibration existed,
 * and of every rules-only licence, and it must read as "nothing to do here"
 * rather than as a fault in the admin panel.
 */
export const readCalibrationEnvelope = (metadata: unknown): EnvelopeRead => {
  if (!isRecord(metadata)) {
    return reject('not_provisioned', 'licence carries no metadata');
  }

  const raw = metadata[CALIBRATION_METADATA_KEY];

  if (raw === undefined || raw === null) {
    return reject(
      'not_provisioned',
      `licence metadata has no "${CALIBRATION_METADATA_KEY}" entry`,
    );
  }

  if (!isRecord(raw)) {
    return reject(
      'malformed',
      `"${CALIBRATION_METADATA_KEY}" is not a JSON object`,
    );
  }

  const signature = raw['signature'];
  const keyId = raw['keyId'];
  const alg = raw['alg'];

  if (typeof signature !== 'string' || signature.length === 0) {
    return reject('unsigned', 'envelope carries no signature');
  }

  if (typeof keyId !== 'string' || keyId.length === 0) {
    return reject('unsigned', 'envelope names no signing key');
  }

  if (typeof alg !== 'string' || alg.length === 0) {
    return reject('unsigned', 'envelope names no signature algorithm');
  }

  const payload = readPayload(raw['payload']);

  if ('error' in payload) {
    return reject('malformed', payload.error);
  }

  // Checked after parsing rather than before, so a future-shaped payload
  // reports *why* it was refused — "schema 2, this build understands 1" — with
  // the version it actually carried, rather than reporting the same generic
  // "malformed" a truncated blob would.
  if (payload.schemaVersion !== CALIBRATION_SCHEMA_VERSION) {
    return reject(
      'schema_unsupported',
      `payload schemaVersion ${payload.schemaVersion}; this build understands ${CALIBRATION_SCHEMA_VERSION}`,
    );
  }

  return { kind: 'envelope', envelope: { alg, keyId, signature, payload } };
};
