/**
 * Canonical serialisation — the exact bytes that get signed and verified.
 *
 * A detached signature is worthless unless the signer and the verifier agree,
 * byte for byte, on what "the payload" is. JSON does not give that for free:
 * key order, whitespace and the treatment of `undefined` are all free choices,
 * and the payload makes a round trip through the licensing service's own JSON
 * storage before we see it again — a round trip that is entitled to reorder
 * keys and reformat numbers without changing meaning.
 *
 * So this module defines the agreement, and both halves import *this file*
 * rather than reimplementing it. The signer is `ops/calibration/sign.mjs`; the
 * verifier is `verify.ts`. There is no third copy.
 *
 * ---------------------------------------------------------------------------
 * ## The rules
 *
 * 1. **Object keys are sorted** by code unit, recursively. This is the whole
 *    point: a service that re-serialises our JSON may emit keys in any order,
 *    and sorting makes that reordering invisible to the signature.
 * 2. **Arrays keep their order.** Order is meaning here — `decisionMakerTitles`
 *    is scanned in sequence and the first match wins, so a reordered list is a
 *    genuinely different payload and must break the signature.
 * 3. **No insignificant whitespace**, i.e. `JSON.stringify` with no spacer.
 * 4. **`undefined` and functions are dropped**, exactly as `JSON.stringify`
 *    already drops them, so a key that is absent and a key that is explicitly
 *    `undefined` canonicalise identically. They mean the same thing to every
 *    reader downstream, so they must sign the same.
 * 5. **`null` is preserved**, because `notes: null` and an absent `notes` are
 *    both legal and both mean "no note" — but `null` survives a JSON round trip
 *    and `undefined` does not, so keeping `null` is what makes the round trip
 *    lossless.
 *
 * ## Why not JCS (RFC 8785)
 *
 * JCS is the standards-track answer and would be the right call if the payload
 * were ever exchanged with a third party's implementation. It is not: both ends
 * are this repository. JCS's remaining substance over the four rules above is
 * number canonicalisation, and the payload contains exactly two numbers, both
 * small non-negative integers, for which every JSON encoder in existence agrees.
 * Pulling in a dependency — into a bundle that ships to customer
 * infrastructure — to canonicalise `1` was not a trade worth making.
 *
 * If the payload ever grows a float, revisit this. The comment is here so that
 * decision is a decision rather than an accident.
 * ---------------------------------------------------------------------------
 */

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * Recursively rebuild a value with object keys in sorted order.
 *
 * Note the array branch preserves order and the primitive branch is the
 * identity — the sort applies to objects and nothing else.
 */
const sortValue = (value: unknown, seen: WeakSet<object>): unknown => {
  if (Array.isArray(value)) {
    // The cycle guard is checked here as well as on objects, because an array
    // that contains itself is just as recursive and just as fatal.
    if (seen.has(value)) {
      throw new TypeError('circular reference');
    }

    seen.add(value);
    const mapped = value.map((entry) => sortValue(entry, seen));
    seen.delete(value);

    return mapped;
  }

  if (typeof value === 'object' && value !== null) {
    // Without this, a cycle recurses until the stack is exhausted and the
    // `RangeError` is what `canonicalise` ends up catching. That happens to
    // produce the right answer — `null` — but by accident, at the cost of
    // however deep the runtime's stack is, and it is not a behaviour worth
    // relying on inside a nightly cron job. `delete` after the descent so a
    // value legitimately appearing twice in a *tree* is not mistaken for a
    // cycle.
    if (seen.has(value)) {
      throw new TypeError('circular reference');
    }

    seen.add(value);

    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};

    for (const key of Object.keys(source).sort()) {
      const entry = source[key];

      // Dropped rather than emitted as `null`: `JSON.stringify` drops
      // `undefined` properties too, and the two must agree or a payload that
      // has been through one `JSON.parse` would canonicalise differently from
      // the same payload in memory.
      if (entry !== undefined) {
        sorted[key] = sortValue(entry, seen);
      }
    }

    seen.delete(value);

    return sorted;
  }

  return value;
};

/**
 * The canonical UTF-8 string for a payload.
 *
 * Returns `null` rather than throwing when the value cannot be represented —
 * a circular reference, or a `BigInt`. Neither can occur in a payload that
 * arrived as parsed JSON, but this function is also called by the signing
 * script on hand-authored input, and a thrown error inside the nightly
 * verification path would be a cron run that dies rather than falls back.
 */
export const canonicalise = (value: unknown): string | null => {
  try {
    const serialised = JSON.stringify(sortValue(value, new WeakSet()) as Json);

    return typeof serialised === 'string' ? serialised : null;
  } catch {
    return null;
  }
};

/**
 * The canonical bytes. Split from `canonicalise` only so the verifier can hash
 * without a second UTF-8 conversion, and so tests can assert on the string.
 */
export const canonicalBytes = (value: unknown): Uint8Array | null => {
  const serialised = canonicalise(value);

  return serialised === null ? null : new TextEncoder().encode(serialised);
};
