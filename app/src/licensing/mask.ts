/**
 * Licence-key masking.
 *
 * `LICENCE_KEY` is a secret application variable. Twenty keeps it out of its own
 * UI and logs, but nothing stops *us* writing it into a structured log line, an
 * audit row's `ruleTrace`, or an error message — and an audit row is queryable
 * by every workspace admin and survives forever. So the key is masked exactly
 * once, at the edge of the run, and only the mask travels inwards.
 *
 * ## Why the mask keeps no key characters at all
 *
 * The obvious mask — "first four, last four" — is the wrong trade here. A key
 * is shaped `NUMAYA-XXXXX-XXXXX-XXXXX-X`: the last group is a single character and
 * the whole secret is about nineteen base-32 characters, so showing eight of
 * them is not a redaction, it is a discount. What support actually needs from a
 * mask is only ever *"is this the same key as the one in that other log line"*,
 * and a fingerprint answers that without revealing anything.
 *
 * So the mask is:
 *
 *   `NUMAYA-*****-*****-*****-* #6f1c2a9b`
 *
 * — group *structure* preserved (which makes a malformed key obvious at a
 * glance, e.g. someone pasting an invoice number), zero secret characters, and a
 * stable 32-bit fingerprint that distinguishes two keys from one another.
 *
 * ## Why FNV-1a and not a real hash
 *
 * This module is part of the pure core and may not import `node:crypto` — the
 * same rule that keeps `src/scoring/` runnable anywhere. FNV-1a is eleven lines
 * and deterministic. It is emphatically *not* a security primitive, and it does
 * not need to be: it never guards anything, it only labels. The key's entropy is
 * not protected by the hash being strong, it is protected by the hash being
 * lossy — 32 bits out of ~95 bits of key means the fingerprint identifies a
 * gigantic equivalence class, not a key.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const fingerprint = (value: string): string => {
  let hash = FNV_OFFSET_BASIS;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    // Multiply in 32-bit space without overflowing into float precision.
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }

  return hash.toString(16).padStart(8, '0');
};

/**
 * The one product prefix that carries no information — every Greenlight key
 * starts with it, so echoing it back reveals nothing and makes the mask
 * readable. Any other leading group is masked like the rest.
 */
const NON_SECRET_PREFIX = 'NUMAYA';

export const MISSING_LICENCE_MASK = '(no licence key)';

/**
 * Mask a licence key for logging, audit rows and error messages.
 *
 * Total: an empty, whitespace-only, `undefined` or non-string input returns
 * `MISSING_LICENCE_MASK` rather than throwing, because the commonest reason to
 * call this is precisely that the admin has not set the variable yet.
 */
export const maskLicenceKey = (key: string | null | undefined): string => {
  if (typeof key !== 'string') {
    return MISSING_LICENCE_MASK;
  }

  const trimmed = key.trim();

  if (trimmed.length === 0) {
    return MISSING_LICENCE_MASK;
  }

  const shape = trimmed
    .split('-')
    .map((group, index) =>
      index === 0 && group.toUpperCase() === NON_SECRET_PREFIX
        ? NON_SECRET_PREFIX
        : '*'.repeat(group.length),
    )
    .join('-');

  return `${shape} #${fingerprint(trimmed)}`;
};

/**
 * Last line of defence: strip any occurrence of the key from text that is about
 * to be logged or stored.
 *
 * `maskLicenceKey` is the primary mechanism and this is the belt to its braces —
 * it exists because error messages are written by code we do not own. A `fetch`
 * rejection, a JSON parse error or a future SDK could all echo a request body,
 * and the URL-encoded form of a key is a plausible variant, so both are
 * replaced.
 *
 * Deliberately a no-op when there is no key: passing an empty string must not
 * turn every character of the message into a mask.
 */
export const redactLicenceKey = (
  text: string,
  key: string | null | undefined,
): string => {
  if (typeof key !== 'string') {
    return text;
  }

  const trimmed = key.trim();

  if (trimmed.length < 4) {
    return text;
  }

  const mask = maskLicenceKey(trimmed);

  return text
    .split(trimmed)
    .join(mask)
    .split(encodeURIComponent(trimmed))
    .join(mask);
};
