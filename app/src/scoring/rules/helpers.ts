/** Small shared primitives for rules. Pure, no I/O, no clock. */

export const normalise = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, ' ');

const escapeForRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whole-token keyword match, so "lead" does not match "leadership" and
 * "vp" does not match "vps".
 *
 * ## The boundary is Unicode-aware, and it has to be
 *
 * The boundary class is `\p{L}\p{N}` — any letter or number in any script — not
 * `a-z0-9`. The ASCII form was wrong, and it was wrong in the direction that
 * costs a lead: an accented letter is not in `a-z0-9`, so it counted as a word
 * *separator*, and every accented word silently split into fragments that could
 * match a keyword on their own.
 *
 * Found live, not by reasoning: with the multilingual calibration pack loaded, a
 * lead titled "Sócio Proprietário" matched the keyword **`cio`** — because the
 * "ó" before it read as a boundary. The verdict happened to be right for that
 * title, but the same flaw promotes "Gerente de Negócio" to C-level, because
 * "negócio" ends in "cio" preceded by an accent. A mid-level manager scored as a
 * decision-maker is exactly the twenty-point error this rule exists to avoid.
 *
 * For pure-ASCII input the two forms are identical, which is why every
 * pre-existing test passes unchanged. The difference only appears where the
 * shipped English vocabulary never reached.
 */
export const containsKeyword = (haystack: string, keyword: string): boolean => {
  const needle = normalise(keyword);

  if (needle.length === 0) {
    return false;
  }

  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeForRegex(needle)}([^\\p{L}\\p{N}]|$)`,
    'iu',
  );

  return pattern.test(normalise(haystack));
};

export const firstKeywordMatch = (
  haystack: string,
  keywords: readonly string[],
): string | null => keywords.find((keyword) => containsKeyword(haystack, keyword)) ?? null;

/** Case-insensitive membership against a configured list. */
export const matchesList = (
  values: readonly string[],
  allowed: readonly string[],
): string | null => {
  const allowedSet = new Set(allowed.map(normalise));

  return values.find((value) => allowedSet.has(normalise(value))) ?? null;
};

const EMAIL_PATTERN =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

export interface ParsedEmail {
  readonly address: string;
  readonly localPart: string;
  readonly domain: string;
}

export const parseEmail = (raw: string): ParsedEmail | null => {
  const address = raw.trim();

  if (address.length === 0 || address.length > 254) {
    return null;
  }

  if (!EMAIL_PATTERN.test(address)) {
    return null;
  }

  const separator = address.lastIndexOf('@');
  const localPart = address.slice(0, separator);
  const domain = address.slice(separator + 1);

  if (localPart.length > 64) {
    return null;
  }

  return { address, localPart: localPart.toLowerCase(), domain: domain.toLowerCase() };
};

/** Strip the local part down to its base, so `sales+eu` is still `sales`. */
export const emailLocalRoot = (localPart: string): string => {
  const withoutTag = localPart.split('+')[0] ?? localPart;
  return withoutTag.replace(/[._-]+$/, '');
};

export const MILLISECONDS_PER_DAY = 86_400_000;

export const daysBetween = (earlier: Date, later: Date): number =>
  (later.getTime() - earlier.getTime()) / MILLISECONDS_PER_DAY;

export const roundTo = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

export const clamp01 = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
};
