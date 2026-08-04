/**
 * The vocabulary of licence-delivered scoring calibration.
 *
 * ===========================================================================
 * ## What calibration is, and what it is emphatically not
 *
 * Greenlight ships as readable JavaScript, its `.ts` sources travel inside the
 * published tarball, and the repository is going public. A fork can therefore
 * delete the licence check in an afternoon. The answer to that is *not*
 * obfuscation — it is to make a licence deliver data that a fork cannot
 * reproduce, while the product keeps working perfectly without it.
 *
 * Calibration is that data: expanded decision-maker and influencer title
 * vocabularies, a shared-inbox and placeholder lexicon, and an industry synonym
 * taxonomy. All of it is accumulated grind, none of it is algorithm. A fork gets
 * the twenty-five English titles in `src/scoring/defaults.ts` and mis-scores
 * every German `Geschäftsführer` and every Brazilian `Sócio`.
 *
 * ## The rule this module must never break
 *
 * **Fail-open is the product's promise and calibration must not weaken it.**
 * Every type below is optional at the point of use, and every failure — absent,
 * stale, unlicensed, malformed, unsigned, wrongly signed — resolves to exactly
 * one behaviour: the in-source defaults, unchanged, with no error surfaced to
 * the lead. An unlicensed workspace scores a lead byte-for-byte identically to
 * how it scored that lead before this feature existed. `apply.ts` is the only
 * consumer and it is a pure function whose fall-back branch is the identity.
 *
 * Nothing server-side is load-bearing. If `licensing.rizvigoc.com` disappeared
 * permanently, Greenlight would keep scoring on shipped defaults forever.
 *
 * ## Where it arrives from — and why it is not the config endpoint
 *
 * The licensing service publishes `GET /v1/licenses/{id}/config`, and the
 * obvious design is to call it. It cannot be called. Both config endpoints
 * (`/v1/licenses/{id}/config` and `/v1/products/{id}/config`) **reject a licence
 * key as a credential** — measured on 2026-08-05 as a bare `401` for the licence
 * key in the `X-Numaya-License-Key` header, as an `Authorization: Bearer` value,
 * and as a `?key=` query parameter. The service's own Configurations guide says
 * so in as many words:
 *
 *   > Both config endpoints require an API key or JWT — the credential a
 *   > *license key* holder would present is turned away. […] if your product
 *   > ships to a customer's own infrastructure (not a SaaS you host yourself),
 *   > the product binary itself can never call these two endpoints directly.
 *
 * Greenlight runs inside the customer's Twenty instance and may never carry an
 * org-scoped management credential, so that door is shut. The guide's two
 * suggested workarounds are a self-hosted relay (forbidden: no Rizvi
 * infrastructure may be load-bearing) and baking the config into the release
 * (self-defeating: a public tarball hands the calibration to the fork).
 *
 * What *is* reachable with nothing but the customer's licence key is the
 * `validate` response, which Greenlight already calls nightly. It carries
 * `customerMetadata` — an org-authored JSON object, set when the licence is
 * issued — straight back to the key holder. That is the delivery channel, and it
 * costs no additional request. See `src/licensing/parse.ts`.
 *
 * ## What integrity can honestly be claimed
 *
 * See `verify.ts`. Short version: the envelope is signed by *us* with a key we
 * hold, not by the licensing service, because the service has no endpoint that
 * will sign an arbitrary payload. That is a real end-to-end authorship
 * guarantee and it is not the same guarantee as "Numaya signed this".
 * ===========================================================================
 */

/* -------------------------------------------------------------------------- */
/* The payload                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The calibration pack itself — pure data, no behaviour, no thresholds.
 *
 * Note what is absent: weights, band thresholds, the gate threshold, and every
 * rule identifier. Those are either scoring logic or the workspace's own
 * configuration, and neither is ours to deliver. Calibration only ever supplies
 * *vocabulary* — the lists a rule matches against — so the worst a hostile or
 * corrupted payload could do is match more or fewer job titles. It cannot move a
 * threshold, disable a rule, or change what a score means.
 */
export interface Calibration {
  /** Shape version. A payload from a future shape is refused, not guessed at. */
  readonly schemaVersion: number;
  /** Content version, shown to the admin as "calibration v3". Monotonic. */
  readonly calibrationVersion: number;
  readonly issuedAt: string;
  readonly notes: string | null;
  readonly decisionMakerTitles: readonly string[];
  readonly influencerTitles: readonly string[];
  readonly roleInboxLocalParts: readonly string[];
  readonly placeholderValues: readonly string[];
  /**
   * Canonical industry term → the free-text variants that mean the same thing.
   *
   * Used to *expand* a workspace's own ICP target list, never to replace it: an
   * admin who types "Construction" gets `bau`, `bâtiment`, `edilizia` and
   * `construcción` matched too. This is what turns the 40 idle ICP points into
   * points that actually fire against real free-text industry columns.
   */
  readonly industrySynonyms: Readonly<Record<string, readonly string[]>>;
}

/** The only schema version this build understands. */
export const CALIBRATION_SCHEMA_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* The signed envelope                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What actually travels: the payload plus a detached signature over its
 * canonical form.
 *
 * `keyId` rather than a bare key so rotation is a data change and not a release.
 * A payload naming a key this build does not carry is refused — see
 * `verify.ts`, "Why an unknown key is refused rather than trusted".
 */
export interface SignedCalibrationEnvelope {
  readonly alg: string;
  readonly keyId: string;
  readonly signature: string;
  readonly payload: Calibration;
}

/* -------------------------------------------------------------------------- */
/* Verification outcome                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Why calibration is or is not in use, as a closed vocabulary.
 *
 * Closed rather than free text because these values reach an admin-facing panel
 * and an audit row, and because every single one of them resolves to the same
 * *behaviour* — shipped defaults — so the only thing distinguishing them is how
 * clearly they explain themselves to the person reading.
 */
export type CalibrationReason =
  /** Verified and in use. */
  | 'calibrated'
  /** No licence key configured, or the licence is not entitled. */
  | 'not_licensed'
  /** Licensed, but this licence carries no calibration. */
  | 'not_provisioned'
  /** Present but not a readable envelope. */
  | 'malformed'
  /** Present, readable, but carries no signature at all. */
  | 'unsigned'
  /** Signed with a key id this build does not know. */
  | 'unknown_key'
  /** Signature did not verify against the embedded public key. */
  | 'signature_invalid'
  /** A payload shape from a future release. */
  | 'schema_unsupported'
  /** Verification could not run — no crypto primitive in this runtime. */
  | 'verifier_unavailable'
  /** Cached calibration older than the offline grace window. */
  | 'stale'
  /**
   * A cached payload whose seal does not verify under the configured licence
   * key: moved between workspaces, edited in place, or left behind by a key
   * that has since been changed or removed.
   */
  | 'cache_unsealed';

export type CalibrationVerification =
  | { readonly kind: 'verified'; readonly calibration: Calibration }
  | { readonly kind: 'rejected'; readonly reason: CalibrationReason; readonly detail: string };

/* -------------------------------------------------------------------------- */
/* Cache + published state                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What survives between runs, beside the entitlement cache and on the same
 * ladder.
 *
 * The verified payload is stored, not the envelope: re-verifying on every lead
 * would spend an Ed25519 check per scoring run to re-derive a fact the nightly
 * run already established, and the signature has no value once the bytes are
 * inside the workspace's own key-value storage — anything able to tamper with
 * that store is already inside the trust boundary the signature protects.
 * `keyId` and `verifiedAt` are kept so the admin panel can say what was checked
 * and when.
 */
export interface CachedCalibration {
  readonly cachedAt: string;
  readonly verifiedAt: string;
  readonly keyId: string;
  /**
   * HMAC over this entry's canonical form, under a secret derived from the
   * licence key. See `seal.ts` for exactly what it does and does not prove —
   * it is licence-binding and tamper-evidence, not authenticity of origin.
   *
   * An entry with no tag is not accepted. There is no "unsealed" mode.
   */
  readonly sealTag: string;
  readonly calibration: Calibration;
}

/**
 * The bytes the seal is computed over: everything in a cache entry except the
 * tag itself.
 *
 * Declared as its own type so the sealing side and the verifying side cannot
 * drift — a field added to `CachedCalibration` and not to this shape would be
 * a field outside the seal, which is the quiet way a MAC stops covering what
 * everyone assumes it covers.
 */
export type SealedCalibrationBody = Omit<CachedCalibration, 'sealTag'>;

export type CalibrationSource = 'live' | 'cache' | 'none';

/**
 * The admin-facing answer to "am I running shipped defaults or calibration
 * vNN, and when did it last refresh?".
 *
 * Published to key-value storage on every nightly run and read by the licence
 * panel. Deliberately a separate record from `LicenceState`: a workspace can be
 * perfectly licensed and still be on shipped defaults (its licence predates
 * calibration provisioning), and collapsing the two would make that state
 * unreadable.
 */
export interface CalibrationState {
  readonly status: 'calibrated' | 'shipped_defaults';
  readonly reason: CalibrationReason;
  readonly source: CalibrationSource;
  readonly calibrationVersion: number | null;
  readonly issuedAt: string | null;
  /** When the payload was last fetched and verified. Null on shipped defaults. */
  readonly refreshedAt: string | null;
  readonly checkedAt: string;
  readonly cacheAgeMs: number | null;
  readonly keyId: string | null;
  /** Sizes of each list, so the panel can show what arrived without dumping it. */
  readonly counts: CalibrationCounts | null;
}

export interface CalibrationCounts {
  readonly decisionMakerTitles: number;
  readonly influencerTitles: number;
  readonly roleInboxLocalParts: number;
  readonly placeholderValues: number;
  readonly industrySynonyms: number;
}

/**
 * Read-only access to the cached payload, for the scoring path.
 *
 * A reader, never a writer: the scoring run must not be handed something it
 * could use to change what future runs score against, for the same reason
 * `readPublishedLicenceState` is not on `LicenceStorePort`.
 */
export interface CalibrationReaderPort {
  read(): Promise<CachedCalibration | null>;
}

/**
 * The writer's side, used only by the nightly licence run.
 *
 * Separate from `LicenceStorePort` rather than bolted onto it, because the two
 * have different failure consequences and different lifetimes: a licence cache
 * that fails to write costs an entitlement re-check, whereas a calibration cache
 * that fails to write costs a vocabulary that the very next run replaces. Both
 * swallow their errors, and keeping them apart means neither can be made to fail
 * the other.
 */
export interface CalibrationStorePort {
  readCalibration(): Promise<CachedCalibration | null>;
  writeCalibration(entry: CachedCalibration): Promise<void>;
  /**
   * Drop the cached payload entirely.
   *
   * Called on exactly one transition — a nightly run finding the licence no
   * longer entitled — and it is what lets the scoring path skip an entitlement
   * check: the cache's *existence* carries that fact. See
   * `src/calibration/state.ts`, "Why there is no entitlement check here".
   */
  clearCalibration(): Promise<void>;
  publishCalibrationState(state: CalibrationState): Promise<void>;
}
