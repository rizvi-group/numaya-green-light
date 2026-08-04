/**
 * The public keys this build will accept a calibration signature from.
 *
 * ===========================================================================
 * ## These are public keys. Embedding them is correct.
 *
 * A verification key is meant to be published — it can check a signature and
 * cannot produce one. Shipping it inside a public repository leaks nothing, and
 * shipping it is the *only* way the guarantee works: a key fetched at runtime
 * could be swapped by whoever swapped the payload, which would make the whole
 * exercise a decoration. The trust anchor has to travel with the code that
 * relies on it, and the code is what the customer already chose to install.
 *
 * ## Why this is a Greenlight key and not the licensing service's org key
 *
 * The obvious anchor is the Numaya org's Ed25519 public key, published at
 * `GET /v1/orgs/current/public-key`
 * (`+VrgNZ38aH8OABL0Wt2fDlhHdc52Hy5H7ganNqf541I=`, `keyVersion: 1`). It is not
 * usable here, for two independent reasons, both measured on 2026-08-05:
 *
 *  1. **The service will not sign an arbitrary payload.** Its private half is
 *     internal and the only signing operation it exposes is the offline licence
 *     file (`GET /v1/licenses/{id}/file`), which signs licence fields —
 *     `licenseId`, `status`, `features`, `expiry` — and nothing we author. There
 *     is no endpoint that takes bytes and returns a signature over them, so
 *     there is no way to obtain a calibration signature that verifies against
 *     that key. `ConfigDownloadResponse` has no `signature` field at all: the
 *     config surface is entirely unsigned.
 *  2. **Its signature is not independently verifiable anyway.** The licence
 *     file's signature was checked against that public key over roughly 150,000
 *     candidate canonicalisations — every plausible field order, delimiter,
 *     datetime precision and JSON shape — and none verified. The service does
 *     not publish the byte string it signs, so a third party cannot confirm the
 *     signature at all. A verifier that cannot verify is not an integrity
 *     control; claiming one would be worse than claiming none.
 *
 * So Greenlight signs its own calibration, with a key it holds, and anchors on
 * that. See `verify.ts` for exactly what that does and does not prove.
 *
 * ## Rotation
 *
 * Add the new key here, ship the release, *then* start signing with it. A build
 * that predates the rotation refuses the new payload (`unknown_key`) and falls
 * back to shipped defaults — degraded, never broken. Retiring a key is the
 * reverse: stop signing with it, wait out the deployed fleet, remove the entry.
 * Never remove and re-add the same `keyId` with different bytes; mint a new id.
 * ===========================================================================
 */

/**
 * `keyId` → raw 32-byte Ed25519 public key, base64.
 *
 * Raw, not SPKI: `crypto.subtle.importKey('raw', …)` takes the bare 32 bytes
 * for Ed25519, which keeps this table readable and removes a DER prefix that
 * would be one more thing to get wrong by hand.
 */
export const CALIBRATION_PUBLIC_KEYS: Readonly<Record<string, string>> = {
  'greenlight-calibration-1': 'jPjyCrgLvAt3XsBQzUl5T7A/AszXPjL35WY93iPdDcI=',
};

/** The key new payloads are signed with. Read by the signing script only. */
export const CALIBRATION_SIGNING_KEY_ID = 'greenlight-calibration-1';

/**
 * The one signature algorithm accepted.
 *
 * Compared case-sensitively against the envelope's `alg`, and there is no
 * "choose the algorithm from the envelope" branch anywhere — an attacker-chosen
 * algorithm field is the oldest hole in signed-token design and the cheapest
 * way to close it is to have exactly one accepted value.
 */
export const CALIBRATION_SIGNATURE_ALGORITHM = 'Ed25519';
