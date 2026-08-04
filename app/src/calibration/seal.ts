/**
 * Binding a cached calibration to the licence key that fetched it.
 *
 * ===========================================================================
 * ## What this is for, stated without decoration
 *
 * The calibration payload spends most of its life at rest in the workspace's own
 * key-value storage. The Ed25519 signature in `verify.ts` proves who *authored*
 * it, and is checked once, when it arrives. This adds a second, different
 * property to the copy that is kept: the cache is sealed with a secret derived
 * from the licence key, and a cache whose seal does not verify under the
 * currently-configured key is refused.
 *
 * **It does buy:** a calibration cache lifted out of a licensed workspace and
 * dropped into an unlicensed one is rejected. The unlicensed install has no key,
 * so it cannot produce a matching tag, and it falls back to shipped defaults.
 * The same applies to a workspace whose licence key has been changed or removed.
 * It is also tamper-evidence: an edited cache entry no longer verifies.
 *
 * **It does not buy:** protection against someone who *holds* a valid licence
 * key. They have the secret; they can seal whatever they like. Nothing that runs
 * entirely inside the customer's own infrastructure can prevent that, and a
 * comment claiming otherwise would be a comfortable story rather than a
 * security property. The signature is the control that survives a hostile
 * licence holder — they can forge a cache, but they cannot forge a payload that
 * verifies against the embedded public key, so they cannot manufacture a
 * *newer* calibration than the one they were sold.
 *
 * **It is licence-binding and tamper-evidence. It is not authenticity of
 * origin.** Those are different properties and this file provides the first two.
 *
 * ## Why a port rather than the key
 *
 * `src/licensing/types.ts` records a structural guarantee: no type in the
 * licensing core has a `key` field, so there is no variable in the core that
 * *could* leak one. Calibration keeps that guarantee by never receiving key
 * material either. The seal arrives as two functions, implemented at the edge in
 * `src/logic-functions/licence-cache-seal.ts`, which is the only place besides
 * the HTTP adapter that touches the raw key.
 *
 * The consequence worth noting: a `null` implementation — no licence key
 * configured — cannot seal and cannot verify, so an unlicensed workspace can
 * never present an acceptable cache. That is the correct direction of failure,
 * and it falls out of the port's shape rather than out of a check somebody has
 * to remember to write.
 * ===========================================================================
 */

/**
 * Seal and verification over the canonical form of a cache entry.
 *
 * `seal` returns `null` when it cannot produce a tag — no key, or a runtime with
 * no HMAC. The caller then declines to cache at all rather than storing an
 * unsealed entry, because an entry that can be read back without a tag check is
 * exactly the entry this whole file exists to refuse.
 */
export interface CalibrationSealPort {
  seal(canonical: string): Promise<string | null>;
  verify(canonical: string, tag: string): Promise<boolean>;
}

/**
 * The seal for a workspace with no licence key: seals nothing, accepts nothing.
 *
 * Used as the default so that a caller which forgets to wire a real seal gets
 * "no calibration" rather than "calibration with no integrity check". Failing
 * closed on the *cache* is safe precisely because failing closed there means
 * falling back to the shipped defaults, which is a fully working product.
 */
export const NO_SEAL: CalibrationSealPort = {
  seal: async () => null,
  verify: async () => false,
};
