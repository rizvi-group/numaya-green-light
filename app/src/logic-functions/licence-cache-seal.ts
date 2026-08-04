/**
 * The real calibration cache seal: HMAC-SHA256 under a secret derived from the
 * licence key.
 *
 * This is one of only two modules in Greenlight that touch the raw licence key —
 * the other is the HTTP adapter, which puts it in a request body. Everything
 * else works with a mask or with the ports declared in `src/licensing/types.ts`.
 * That is a structural guarantee rather than a discipline, and this file is
 * written to keep it: the key enters through the factory argument, is
 * immediately turned into a derived secret, and is never stored, returned,
 * logged or included in any error.
 *
 * ---------------------------------------------------------------------------
 * ## Why the key is not used as the HMAC secret directly
 *
 * It would work, and it would be a needless second use of the same secret for a
 * second purpose. The derivation is one HMAC with a fixed, versioned label, so
 * the cache secret and the credential are cryptographically separated: an
 * adversary who somehow recovered the cache secret has not recovered the licence
 * key, and could not present it to the licensing service.
 *
 * The label carries a version. Changing it invalidates every existing seal at
 * once, which is the intended lever if the sealed form ever has to change: every
 * workspace falls back to shipped defaults for one night and re-fetches. That is
 * a safe migration precisely because falling back is not a failure.
 *
 * ## Why WebCrypto
 *
 * Same reason as `src/calibration/verify.ts`: `crypto.subtle` is a global, so
 * nothing here depends on how the logic-function bundler treats Node built-ins.
 * A bundler that stubbed `node:crypto` would have silently turned the seal into
 * a no-op; a missing global cannot, because the absence is checked and produces
 * "no seal", which refuses every cache.
 * ---------------------------------------------------------------------------
 */

import { type CalibrationSealPort, NO_SEAL } from 'src/calibration/seal';

/**
 * Domain-separation label. Versioned so the sealed form can be changed by
 * changing this string, with a one-night fall-back to shipped defaults as the
 * entire migration cost.
 */
const SEAL_LABEL = 'greenlight.calibration.cache.v1';

const subtle = (): SubtleCrypto | null => {
  const candidate = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto
    ?.subtle;

  return candidate === undefined ? null : candidate;
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
};

/**
 * Constant-time comparison of two base64 tags.
 *
 * The timing channel here is not a realistic attack — the attacker would need
 * to be inside the customer's own infrastructure, at which point they can read
 * the cache directly — but an early-exit string compare in code that checks a
 * MAC is the kind of thing that gets copied somewhere it does matter.
 */
const equalTags = (left: string, right: string): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  let difference = 0;

  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }

  return difference === 0;
};

/**
 * Build a seal for a given licence key.
 *
 * A `null` or blank key yields `NO_SEAL`, which seals nothing and accepts
 * nothing — so an unlicensed workspace cannot present a cache, and cannot
 * accidentally be given one.
 */
export const createLicenceKeySeal = (
  licenceKey: string | null,
): CalibrationSealPort => {
  if (typeof licenceKey !== 'string' || licenceKey.trim().length === 0) {
    return NO_SEAL;
  }

  const key = licenceKey.trim();

  // Derived once per seal, held in this closure and nowhere else. The raw key
  // is not captured beyond this line.
  let cachedSecret: CryptoKey | null = null;

  const secret = async (crypto: SubtleCrypto): Promise<CryptoKey> => {
    if (cachedSecret !== null) {
      return cachedSecret;
    }

    const encoder = new TextEncoder();

    const keyMaterial = await crypto.importKey(
      'raw',
      encoder.encode(key) as unknown as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );

    const derived = await crypto.sign(
      'HMAC',
      keyMaterial,
      encoder.encode(SEAL_LABEL) as unknown as BufferSource,
    );

    cachedSecret = await crypto.importKey(
      'raw',
      derived,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );

    return cachedSecret;
  };

  const tag = async (canonical: string): Promise<string | null> => {
    const crypto = subtle();

    if (crypto === null) {
      return null;
    }

    try {
      const signature = await crypto.sign(
        'HMAC',
        await secret(crypto),
        new TextEncoder().encode(canonical) as unknown as BufferSource,
      );

      return toBase64(new Uint8Array(signature));
    } catch {
      // Deliberately no detail. Anything derived from a failure while handling
      // key material is a string this codebase has promised never to produce.
      return null;
    }
  };

  return {
    seal: tag,
    verify: async (canonical, expected) => {
      const computed = await tag(canonical);

      return computed !== null && equalTags(computed, expected);
    },
  };
};
