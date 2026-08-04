/**
 * Signature verification for a calibration envelope.
 *
 * ===========================================================================
 * ## What this proves, and what it does not — read this before quoting it
 *
 * **It proves:** the payload now in memory is byte-identical, under the
 * canonicalisation in `canonical.ts`, to a payload signed by the holder of the
 * private half of an embedded key. Nobody between the signing step and this
 * function — the licensing service, its database, a compromised TLS path, a
 * proxy, a workspace administrator with API access — can substitute or edit the
 * calibration without the signature failing. That is a genuine end-to-end
 * authorship guarantee and it is the property worth having, because the payload
 * spends its life at rest inside a third-party service.
 *
 * **It does not prove that Numaya's licensing service signed anything.** It
 * cannot: the service has no endpoint that signs an arbitrary payload, and its
 * config download surface (`ConfigDownloadResponse`) carries no signature field
 * whatsoever. The transport integrity of the fetch is ordinary TLS to
 * `licensing.rizvigoc.com` plus licence-key authentication, and nothing more.
 * See `keys.ts` for the measurements behind that statement.
 *
 * **It does not prove freshness.** A signature is not a timestamp. Someone who
 * can control what the `validate` response returns could replay an *older*
 * genuinely-signed payload, and this function would accept it. Two things bound
 * that: `calibrationVersion` and `issuedAt` are inside the signed payload and
 * are published to the admin panel, so a rollback is visible rather than silent;
 * and the worst outcome of a successful replay is an older vocabulary, which is
 * strictly bounded by "the shipped defaults" in badness. There is no version
 * ratchet, deliberately — a ratchet would let one bad payload permanently wedge
 * a workspace, and permanently wedged is a worse failure than slightly stale.
 *
 * **It does not prove the payload is sensible.** Signing is authorship, not
 * review. `parse.ts` still validates the shape and `apply.ts` still refuses to
 * let calibration touch anything but vocabulary.
 *
 * ## Every failure lands in the same place
 *
 * Unknown key, wrong algorithm, bad base64, absent signature, no crypto in the
 * runtime, verification throwing — all of them return `rejected`, and every
 * caller of `rejected` uses the in-source defaults. There is no branch in this
 * file that can make scoring fail, and none that can make it throw.
 *
 * ## Why WebCrypto and not `node:crypto`
 *
 * `crypto.subtle` is a global. Reaching for it costs no import, so nothing here
 * depends on how the logic-function bundle treats Node built-ins — and a bundler
 * that decided to inline or stub `node:crypto` would have turned signature
 * verification into a silent no-op rather than a build error. A global that is
 * either present or absent fails loudly in the one direction that matters.
 * ===========================================================================
 */

import { canonicalBytes } from 'src/calibration/canonical';
import {
  CALIBRATION_PUBLIC_KEYS,
  CALIBRATION_SIGNATURE_ALGORITHM,
} from 'src/calibration/keys';
import {
  type CalibrationReason,
  type CalibrationVerification,
  type SignedCalibrationEnvelope,
} from 'src/calibration/types';

const reject = (
  reason: CalibrationReason,
  detail: string,
): CalibrationVerification => ({ kind: 'rejected', reason, detail });

/**
 * Base64 → bytes without `Buffer`.
 *
 * `atob` is a global in every runtime this ships to and, unlike `Buffer`, needs
 * no Node shim in a browser-ish bundle. Returns `null` on anything unparseable
 * instead of throwing, because "the signature field held garbage" is an
 * expected input here, not an exceptional one.
 */
const decodeBase64 = (value: string): Uint8Array | null => {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }

    return bytes;
  } catch {
    return null;
  }
};

/** Ed25519 signatures are always exactly 64 bytes; keys always exactly 32. */
const ED25519_SIGNATURE_BYTES = 64;
const ED25519_PUBLIC_KEY_BYTES = 32;

const subtle = (): SubtleCrypto | null => {
  const candidate = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto
    ?.subtle;

  return candidate === undefined ? null : candidate;
};

/**
 * Verify an envelope whose *shape* has already been checked by `parse.ts`.
 *
 * Split from parsing on purpose: parsing is synchronous and total, verification
 * is asynchronous and needs a runtime capability. Keeping them apart means the
 * shape tests do not need a crypto stub and the crypto tests do not need a
 * fixture with nineteen fields.
 */
export const verifyCalibrationEnvelope = async (
  envelope: SignedCalibrationEnvelope,
): Promise<CalibrationVerification> => {
  if (envelope.alg !== CALIBRATION_SIGNATURE_ALGORITHM) {
    return reject(
      'unsigned',
      `unsupported signature algorithm "${envelope.alg}"`,
    );
  }

  const publicKeyBase64 = CALIBRATION_PUBLIC_KEYS[envelope.keyId];

  // ## Why an unknown key is refused rather than trusted
  //
  // The alternative — accept any key id and verify against whatever the payload
  // supplies — verifies that the payload signed itself, which is not a
  // property. The key table is the trust anchor; a key outside it is a stranger.
  // A workspace on an older build therefore refuses a payload signed with a
  // newly rotated key and keeps shipped defaults, which is the correct
  // degradation and is why `keys.ts` says to ship the key before signing with
  // it.
  if (publicKeyBase64 === undefined) {
    return reject(
      'unknown_key',
      `no embedded public key for keyId "${envelope.keyId}"`,
    );
  }

  const signature = decodeBase64(envelope.signature);

  if (signature === null || signature.length !== ED25519_SIGNATURE_BYTES) {
    return reject(
      'signature_invalid',
      `signature is not ${ED25519_SIGNATURE_BYTES} bytes of base64`,
    );
  }

  const publicKey = decodeBase64(publicKeyBase64);

  if (publicKey === null || publicKey.length !== ED25519_PUBLIC_KEY_BYTES) {
    // An embedded key that does not decode is a build defect, not an input
    // problem. It still degrades rather than throws — a customer's nightly cron
    // is not the place to discover a typo in a constant, and the fall-back is
    // the same shipped defaults either way.
    return reject(
      'verifier_unavailable',
      `embedded public key "${envelope.keyId}" is not ${ED25519_PUBLIC_KEY_BYTES} raw bytes`,
    );
  }

  const message = canonicalBytes(envelope.payload);

  if (message === null) {
    return reject('malformed', 'payload could not be canonicalised');
  }

  const crypto = subtle();

  if (crypto === null) {
    return reject(
      'verifier_unavailable',
      'this runtime exposes no crypto.subtle, so the signature could not be checked',
    );
  }

  try {
    const key = await crypto.importKey(
      'raw',
      publicKey as unknown as BufferSource,
      { name: CALIBRATION_SIGNATURE_ALGORITHM },
      false,
      ['verify'],
    );

    const verified = await crypto.verify(
      { name: CALIBRATION_SIGNATURE_ALGORITHM },
      key,
      signature as unknown as BufferSource,
      message as unknown as BufferSource,
    );

    return verified
      ? { kind: 'verified', calibration: envelope.payload }
      : reject(
          'signature_invalid',
          'the signature does not match the payload under this build’s canonicalisation',
        );
  } catch (error) {
    // A runtime that has `crypto.subtle` but not Ed25519 throws here rather
    // than returning false. Same landing place: shipped defaults, and a reason
    // string an admin can act on.
    return reject(
      'verifier_unavailable',
      `Ed25519 verification is unavailable in this runtime: ${
        error instanceof Error ? error.name : 'unknown error'
      }`,
    );
  }
};
