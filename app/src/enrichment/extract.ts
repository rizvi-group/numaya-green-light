/**
 * Turning a model's answer into values that may be written — the hallucination
 * mitigation, and the only place in enrichment where a value is allowed to
 * become real.
 *
 * ===========================================================================
 * ## The problem, exactly
 *
 * A model asked "what industry is this company in?" will always answer. It has
 * priors about company names, it has been trained to be useful, and "I do not
 * know" is the answer it produces least often. PRODUCT_SPEC's mitigation is "no
 * unsourced values", and the only way to mean that is to check, mechanically,
 * that the value is on the page it claims to come from.
 *
 * ## The gate, in order. A candidate must pass all of it.
 *
 *  1. **Known key.** The key is on `ENRICHABLE_FIELD_SPECS` and was one of the
 *     fields this run actually asked for. Anything else is discarded — including
 *     helpful extras, which are by definition unrequested and therefore
 *     un-prompted output.
 *  2. **Known source.** `evidenceId` names a document *we* minted this run. The
 *     model is never given URLs and never asked for one, so a fabricated
 *     citation cannot resolve; there is nothing for it to point at.
 *  3. **Well-formed value.** Non-empty, within the spec's length, an integer
 *     where the spec says integer, and free of URLs and injection markers — a
 *     value is a value, not a sentence and not a link.
 *  4. **Verbatim quote.** The quote the model supplied must appear in the cited
 *     snippet. This is the model's stated working, graded against the real text.
 *  5. **Substantiation.** The *value* itself must be present in the cited
 *     snippet: every significant token for text fields, the digits for integers.
 *     This is the load-bearing check and no model participates in it.
 *
 * Step 5 is what makes "this is obviously a healthcare company" fail. If the
 * word is not on the page, there is no value. Nothing about the confidence the
 * model reports can rescue it — confidence is an *output* of this process, not
 * an input to it.
 *
 * ## What a failure costs
 *
 * Nothing to the lead. Every rejection is recorded with a reason and the run
 * writes whatever else survived, or writes nothing and reports
 * `no_supported_values`. A lead is never blocked, re-queued or flagged because a
 * model produced something unusable.
 * ===========================================================================
 */

import { findFieldSpec } from 'src/enrichment/field-specs';
import { detectInjectionMarkers } from 'src/enrichment/sanitise';
import type { EvidenceDocument } from 'src/enrichment/sanitise';
import type {
  EnrichableFieldKey,
  EnrichableFieldSpec,
} from 'src/enrichment/types';

/* -------------------------------------------------------------------------- */
/* Parsing the model's reply                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Pull a JSON object out of whatever came back.
 *
 * Tolerant of the two things every model does regardless of instruction: wrap
 * the answer in a code fence, and prepend a sentence of prose. Not tolerant of
 * anything else — a reply this cannot parse is a `malformed_response`, which
 * skips the lead rather than guessing at intent.
 */
export const parseModelJson = (raw: string): unknown => {
  const withoutFence = raw
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();

  const direct = tryParse(withoutFence);

  if (direct !== undefined) {
    return direct;
  }

  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');

  if (start === -1 || end <= start) {
    return undefined;
  }

  return tryParse(withoutFence.slice(start, end + 1));
};

const tryParse = (text: string): unknown => {
  if (text.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/* -------------------------------------------------------------------------- */
/* Candidates                                                                  */
/* -------------------------------------------------------------------------- */

export interface EnrichmentCandidate {
  readonly key: EnrichableFieldKey;
  readonly value: string;
  readonly parsedValue: string | number;
  readonly document: EvidenceDocument;
  readonly quote: string;
  /** The model's self-reported confidence, clamped. Only one input to the final score. */
  readonly claimedConfidence: number;
}

export type RejectionReason =
  | 'not_an_object'
  | 'no_fields_array'
  | 'unknown_key'
  | 'not_requested'
  | 'duplicate_key'
  | 'unknown_evidence'
  | 'value_empty'
  | 'value_too_long'
  | 'value_not_an_integer'
  | 'value_contains_url'
  | 'value_contains_instructions'
  | 'quote_not_in_snippet'
  | 'value_not_substantiated';

export interface Rejection {
  readonly key: string;
  readonly reason: RejectionReason;
}

export interface ExtractionResult {
  readonly candidates: readonly EnrichmentCandidate[];
  readonly rejections: readonly Rejection[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const URL_IN_VALUE = /https?:\/\/|www\.[a-z0-9-]+\./i;

/**
 * Run the gate over a parsed reply.
 *
 * `requested` is passed rather than assumed: a run only asks about the fields
 * that were actually missing or stale, and a value for a field we did not ask
 * about is output nobody prompted for. Accepting it would also quietly defeat
 * the shelf-life cache, which is the mechanism keeping the bill down.
 */
export const extractCandidates = (
  parsed: unknown,
  documents: readonly EvidenceDocument[],
  requested: readonly EnrichableFieldKey[],
): ExtractionResult => {
  if (!isRecord(parsed)) {
    return { candidates: [], rejections: [{ key: '', reason: 'not_an_object' }] };
  }

  const fields = parsed['fields'];

  if (!Array.isArray(fields)) {
    return { candidates: [], rejections: [{ key: '', reason: 'no_fields_array' }] };
  }

  const documentsById = new Map(documents.map((doc) => [doc.id, doc]));
  const requestedKeys = new Set<string>(requested);
  const candidates: EnrichmentCandidate[] = [];
  const rejections: Rejection[] = [];
  const seen = new Set<string>();

  for (const entry of fields) {
    if (!isRecord(entry)) {
      rejections.push({ key: '', reason: 'not_an_object' });
      continue;
    }

    const rawKey = typeof entry['key'] === 'string' ? entry['key'].trim() : '';
    const spec = findFieldSpec(rawKey);

    if (spec === null) {
      rejections.push({ key: rawKey, reason: 'unknown_key' });
      continue;
    }

    if (!requestedKeys.has(spec.key)) {
      rejections.push({ key: spec.key, reason: 'not_requested' });
      continue;
    }

    if (seen.has(spec.key)) {
      // The first answer wins. A second answer for the same field is either the
      // model hedging or two pages disagreeing, and neither is a thing to
      // resolve by taking the last one written.
      rejections.push({ key: spec.key, reason: 'duplicate_key' });
      continue;
    }

    const document = documentsById.get(
      typeof entry['evidenceId'] === 'string' ? entry['evidenceId'].trim() : '',
    );

    if (document === undefined) {
      rejections.push({ key: spec.key, reason: 'unknown_evidence' });
      continue;
    }

    const valueCheck = normaliseValue(entry['value'], spec);

    if (valueCheck.kind === 'rejected') {
      rejections.push({ key: spec.key, reason: valueCheck.reason });
      continue;
    }

    const quote = typeof entry['quote'] === 'string' ? entry['quote'] : '';
    const haystack = normaliseForMatch(`${document.title} ${document.snippet}`);

    if (quote.trim().length === 0 || !haystack.includes(normaliseForMatch(quote))) {
      rejections.push({ key: spec.key, reason: 'quote_not_in_snippet' });
      continue;
    }

    if (!isSubstantiated(valueCheck.value, spec, haystack)) {
      rejections.push({ key: spec.key, reason: 'value_not_substantiated' });
      continue;
    }

    seen.add(spec.key);
    candidates.push({
      key: spec.key,
      value: valueCheck.value,
      parsedValue: valueCheck.parsedValue,
      document,
      quote: quote.trim(),
      claimedConfidence: clampConfidence(entry['confidence']),
    });
  }

  return { candidates, rejections };
};

/* -------------------------------------------------------------------------- */
/* Value shape                                                                 */
/* -------------------------------------------------------------------------- */

type ValueCheck =
  | { kind: 'ok'; value: string; parsedValue: string | number }
  | { kind: 'rejected'; reason: RejectionReason };

const normaliseValue = (
  raw: unknown,
  spec: EnrichableFieldSpec,
): ValueCheck => {
  const asText =
    typeof raw === 'string'
      ? raw
      : typeof raw === 'number' && Number.isFinite(raw)
        ? String(raw)
        : '';
  const trimmed = asText.replace(/\s+/g, ' ').trim();

  if (trimmed.length === 0) {
    return { kind: 'rejected', reason: 'value_empty' };
  }

  if (URL_IN_VALUE.test(trimmed)) {
    return { kind: 'rejected', reason: 'value_contains_url' };
  }

  // Layer 5's own copy of the quarantine check. The evidence set has already
  // been screened, so this should be unreachable — which is exactly why it is
  // here. A value carrying instructions means a payload got through a layer
  // that was supposed to stop it, and this is the last place before the value
  // reaches a field a human will read.
  if (detectInjectionMarkers(trimmed).suspicious) {
    return { kind: 'rejected', reason: 'value_contains_instructions' };
  }

  // The kind check comes before the length check on purpose. `maxLength` for an
  // integer field bounds its *digits*, so measuring a prose answer against it
  // would report "too long" for something whose actual fault is that it is not
  // a number — and a rejection reason that names the wrong fault is worse than
  // no reason, because it sends whoever reads the log the wrong way.
  if (spec.kind === 'integer') {
    const digits = trimmed.replace(/[\s,._]/g, '');
    const parsed = Number(digits);

    if (!/^\d+$/.test(digits) || !Number.isSafeInteger(parsed) || parsed <= 0) {
      return { kind: 'rejected', reason: 'value_not_an_integer' };
    }

    if (digits.length > spec.maxLength) {
      return { kind: 'rejected', reason: 'value_too_long' };
    }

    return { kind: 'ok', value: String(parsed), parsedValue: parsed };
  }

  if (trimmed.length > spec.maxLength) {
    return { kind: 'rejected', reason: 'value_too_long' };
  }

  return { kind: 'ok', value: trimmed, parsedValue: trimmed };
};

const clampConfidence = (raw: unknown): number => {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return 0.5;
  }

  return Math.min(1, Math.max(0, Math.round(raw * 100) / 100));
};

/* -------------------------------------------------------------------------- */
/* Substantiation — the deterministic check                                    */
/* -------------------------------------------------------------------------- */

/** Lowercase, strip accents, reduce everything non-alphanumeric to a space. */
export const normaliseForMatch = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Tokens too common to carry evidence. If every word of a value is on this list
 * the value is not substantiated by finding them, which is the right answer.
 */
const STOP_TOKENS = new Set<string>([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'in', 'on', 'at', 'to', 'by',
  'with', 'from', 'is', 'are', 'was', 'were', 'its', 'their', 'inc', 'ltd',
  'llc', 'plc', 'gmbh', 'sa', 'co', 'company', 'group', 'holdings',
]);

/**
 * Is the value actually on the cited page?
 *
 * **Text**: every significant token of the value must appear in the snippet.
 *   "Healthcare technology" needs both "healthcare" and "technology" present.
 *   Tokens shorter than three characters and stop words are ignored — they would
 *   match everywhere and prove nothing — and a value made *entirely* of those is
 *   rejected, because there is then nothing left that could constitute evidence.
 *
 * **Integer**: the digits must appear, allowing for the ways a page writes a
 *   number. `40000` matches "40,000", "40 000" and "40k"; it does not match
 *   "4000" or "400000", because the whole-token comparison is on the normalised
 *   digit string rather than on a substring of it.
 *
 * Substring rather than whole-word matching for text: "manufacturing" should be
 * substantiated by "manufacturer", and the false-positive cost of a prefix match
 * inside a sixty-character value is far lower than the false-negative cost of
 * rejecting every value whose page used a different inflection.
 */
export const isSubstantiated = (
  value: string,
  spec: EnrichableFieldSpec,
  normalisedHaystack: string,
): boolean => {
  if (spec.kind === 'integer') {
    return isNumberSubstantiated(value, normalisedHaystack);
  }

  const tokens = normaliseForMatch(value)
    .split(' ')
    .filter((token) => token.length >= 3 && !STOP_TOKENS.has(token));

  if (tokens.length === 0) {
    return false;
  }

  return tokens.every((token) => normalisedHaystack.includes(stem(token)));
};

/**
 * The crudest possible stemmer: drop a trailing `s`/`ing`/`er` so "manufacturing"
 * finds "manufacturer" and "services" finds "service". Deliberately not a real
 * stemmer — this is a containment check, not linguistics, and a wrong stem costs
 * one un-enriched field.
 */
const stem = (token: string): string => {
  if (token.length > 6 && token.endsWith('ing')) {
    return token.slice(0, -3);
  }

  if (token.length > 5 && (token.endsWith('ers') || token.endsWith('ies'))) {
    return token.slice(0, -3);
  }

  if (token.length > 4 && (token.endsWith('er') || token.endsWith('es'))) {
    return token.slice(0, -2);
  }

  if (token.length > 3 && token.endsWith('s')) {
    return token.slice(0, -1);
  }

  return token;
};

const isNumberSubstantiated = (
  value: string,
  normalisedHaystack: string,
): boolean => {
  const target = Number(value);

  if (!Number.isSafeInteger(target)) {
    return false;
  }

  // The haystack is already space-separated; join digit groups so "40 000" and
  // "40,000" both collapse to "40000" before comparison.
  const joined = normalisedHaystack.replace(/(\d) (?=\d{3}\b)/g, '$1');
  const tokens = new Set(joined.split(' '));

  if (tokens.has(String(target))) {
    return true;
  }

  if (target % 1000 === 0 && tokens.has(`${target / 1000}k`)) {
    return true;
  }

  if (target % 1_000_000 === 0 && tokens.has(`${target / 1_000_000}m`)) {
    return true;
  }

  return false;
};

/* -------------------------------------------------------------------------- */
/* Confidence                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The confidence that gets written.
 *
 * Deliberately **not** the model's number. That number is a self-report from the
 * same process that produced the value, so using it verbatim would let a
 * confident hallucination look better than a hedged fact. What is written is the
 * model's claim capped by what we independently established:
 *
 *   - never above 0.95, because nothing sourced from one search snippet is
 *     near-certain;
 *   - capped at 0.6 when the verification tier could not be reached, so an
 *     `unconfirmed` value is visibly weaker on the record;
 *   - floored at 0.3, because it passed the deterministic gate and a value that
 *     is genuinely on the page is not worthless however shy the model was.
 */
export const scoreConfidence = (
  claimed: number,
  verification: 'substantiated' | 'confirmed' | 'unconfirmed',
): number => {
  const ceiling = verification === 'unconfirmed' ? 0.6 : 0.95;
  const bounded = Math.min(ceiling, Math.max(0.3, claimed));

  return Math.round(bounded * 100) / 100;
};

/* -------------------------------------------------------------------------- */
/* Verification replies                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Read the cheap tier's yes/no answers.
 *
 * Returns a map of item id to verdict. Anything unreadable yields an empty map,
 * which the caller treats as "verification unavailable" — i.e. the candidates
 * stay, capped at 0.6 and marked `unconfirmed`. A malformed verification reply
 * must not silently *approve* anything, and must not silently discard values
 * that already passed the deterministic gate either.
 */
export const parseVerification = (
  parsed: unknown,
): ReadonlyMap<string, boolean> => {
  const verdicts = new Map<string, boolean>();

  if (!isRecord(parsed)) {
    return verdicts;
  }

  const results = parsed['results'];

  if (!Array.isArray(results)) {
    return verdicts;
  }

  for (const entry of results) {
    if (!isRecord(entry)) {
      continue;
    }

    const id = entry['id'];
    const supported = entry['supported'];

    if (typeof id === 'string' && typeof supported === 'boolean') {
      verdicts.set(id, supported);
    }
  }

  return verdicts;
};
