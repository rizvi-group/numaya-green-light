/**
 * What is worth asking about — the shelf-life cache and the gap analysis.
 *
 * Pure, with `now` handed in. This is the module that decides whether a lead
 * costs a provider call at all, so it is also the module that decides most of
 * the bill: every key it declines to request is a search query not issued and a
 * token not spent.
 *
 * ## Three reasons not to ask
 *
 *  1. **A human already answered.** If the lead's own columns carry a value for
 *     a field, enrichment leaves it alone — permanently, not until it goes
 *     stale. Human-entered data is not something this app refreshes.
 *  2. **We already answered, recently enough.** A previously enriched value
 *     inside its shelf life is a cache hit. ARCHITECTURE.md's Path 2
 *     requirements list "field shelf-life cache miss (value is stale)" as a
 *     precondition for running at all, and this is it.
 *  3. **We already looked and found nothing.** A field that could not be sourced
 *     is recorded as `unresolved`, and is not asked about again for a week. This
 *     one matters more than it looks: without it, a lead whose industry is
 *     simply not on the public web would consume a run on every single update
 *     event, forever, and would be the single largest line in the monthly cap.
 *
 * ## Which mapping is used to check (1)
 *
 * The scoring engine's `DEFAULT_FIELD_MAPPING`, deliberately, and **not** the
 * workspace's configured Layer 3 mapping. The recommended configuration appends
 * `greenlightEnrichment.fields.<key>.parsedValue` to each mapping so the scorer
 * can read enriched values — and if this module used that same mapping, an
 * enriched value would read as "a human already answered" and the field would
 * never be refreshed after its first successful run. Reading the stock mapping
 * keeps "does a person hold an opinion about this field" and "have we cached an
 * answer" as two separate questions, answered from two separate places.
 */

import { DEFAULT_FIELD_MAPPING } from 'src/scoring';

import { ENRICHABLE_FIELD_SPECS } from 'src/enrichment/field-specs';
import type { ExtractionSubject } from 'src/enrichment/prompt';
import type {
  EnrichableFieldKey,
  EnrichmentPayload,
} from 'src/enrichment/types';

/**
 * How long a failed lookup suppresses the next attempt at the same field.
 *
 * Seven days, or the field's shelf life if that is shorter. A week is long
 * enough that a bulk import does not spend the month's allowance discovering the
 * same absence repeatedly, and short enough that a company which has just
 * launched a website is picked up in the same quarter.
 */
export const UNRESOLVED_RETRY_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface EnrichmentPlanInput {
  /** The lead record as delivered, untyped on purpose. */
  readonly lead: Record<string, unknown>;
  readonly existing: EnrichmentPayload | null;
  readonly defaultShelfLifeDays: number;
  readonly fieldShelfLifeDays: Readonly<Partial<Record<string, number>>>;
  readonly now: Date;
  /**
   * An admin pressed the button. Freshness is ignored; the human-value rule and
   * the licence, cap and breaker checks are not. "Re-fetch this now" is a
   * legitimate request; "overwrite what I typed" and "ignore my spend cap" are
   * not, and the same button cannot be allowed to mean all three.
   */
  readonly force: boolean;
}

export interface EnrichmentPlan {
  /** Fields to ask about. Empty means no provider call. */
  readonly requested: readonly EnrichableFieldKey[];
  /** Skipped because a person already answered. */
  readonly humanHeld: readonly EnrichableFieldKey[];
  /** Skipped because a cached enriched value is still inside its shelf life. */
  readonly fresh: readonly EnrichableFieldKey[];
  /** Skipped because a recent run looked and found nothing. */
  readonly recentlyUnresolved: readonly EnrichableFieldKey[];
  readonly subject: ExtractionSubject;
  /** The search query, or null when there is nothing identifying to search for. */
  readonly query: string | null;
}

/* -------------------------------------------------------------------------- */
/* Reading the lead                                                            */
/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Resolve a dotted path, then flatten to a string.
 *
 * A deliberately smaller cousin of `src/scoring/field-access.ts`: that module
 * has to record observations for the trace and handle composite CRM types
 * generically, and none of that is needed to answer the one question here, which
 * is "is there anything in this field or not". Importing the reader would drag
 * the trace machinery into a bundle that has no trace to write.
 */
const readPath = (record: Record<string, unknown>, path: string): unknown => {
  const segments = path.split('.');
  let cursor: unknown = record;

  for (const segment of segments) {
    if (!isRecord(cursor)) {
      return undefined;
    }

    cursor = cursor[segment];
  }

  return cursor;
};

const PLACEHOLDERS = new Set(['', '-', '—', 'n/a', 'na', 'none', 'unknown', 'null']);

/** Is there a real, non-placeholder value at any of these paths? */
const hasValue = (
  record: Record<string, unknown>,
  candidates: readonly string[],
): boolean =>
  candidates.some((path) => {
    const value = readPath(record, path);

    if (value === undefined || value === null) {
      return false;
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) && value !== 0;
    }

    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      return !PLACEHOLDERS.has(value.trim().toLowerCase());
    }

    if (Array.isArray(value)) {
      return value.length > 0;
    }

    if (isRecord(value)) {
      // Composite CRM fields (`{ primaryEmail, … }`, `{ firstName, … }`).
      // Present if any string leaf is non-placeholder.
      return Object.values(value).some(
        (leaf) =>
          typeof leaf === 'string' && !PLACEHOLDERS.has(leaf.trim().toLowerCase()),
      );
    }

    return false;
  });

export const readSubject = (lead: Record<string, unknown>): ExtractionSubject => ({
  personName: readDisplayText(lead, DEFAULT_FIELD_MAPPING.contactName),
  companyName: readDisplayText(lead, DEFAULT_FIELD_MAPPING.companyName),
});

const readDisplayText = (
  record: Record<string, unknown>,
  candidates: readonly string[],
): string => {
  for (const path of candidates) {
    const value = readPath(record, path);

    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim().slice(0, 120);
    }

    if (isRecord(value)) {
      const parts = Object.values(value)
        .filter((leaf): leaf is string => typeof leaf === 'string')
        .map((leaf) => leaf.trim())
        .filter((leaf) => leaf.length > 0);

      if (parts.length > 0) {
        return parts.join(' ').slice(0, 120);
      }
    }
  }

  return '';
};

/* -------------------------------------------------------------------------- */
/* Freshness                                                                   */
/* -------------------------------------------------------------------------- */

const shelfLifeMsFor = (
  key: EnrichableFieldKey,
  input: EnrichmentPlanInput,
): number => {
  const configured = input.fieldShelfLifeDays[key];
  const days =
    typeof configured === 'number' && Number.isFinite(configured) && configured > 0
      ? configured
      : input.defaultShelfLifeDays;

  const safeDays = Number.isFinite(days) && days > 0 ? days : 30;

  return safeDays * DAY_MS;
};

/**
 * An unparseable `retrievedAt` reads as **stale**, i.e. worth re-fetching.
 *
 * That is the expensive direction and it is still the right one: a corrupt
 * timestamp read as fresh would pin a wrong value on a lead permanently, with
 * nothing short of a manual edit able to dislodge it. Paying for one extra
 * lookup is the cheaper mistake.
 */
const isFresh = (retrievedAt: string, shelfLifeMs: number, now: Date): boolean => {
  const at = Date.parse(retrievedAt);

  if (!Number.isFinite(at)) {
    return false;
  }

  return now.getTime() - at < shelfLifeMs;
};

/* -------------------------------------------------------------------------- */
/* The plan                                                                    */
/* -------------------------------------------------------------------------- */

export const planEnrichment = (input: EnrichmentPlanInput): EnrichmentPlan => {
  const requested: EnrichableFieldKey[] = [];
  const humanHeld: EnrichableFieldKey[] = [];
  const fresh: EnrichableFieldKey[] = [];
  const recentlyUnresolved: EnrichableFieldKey[] = [];

  const existingFields = input.existing?.fields ?? {};
  const unresolved = new Set<string>(input.existing?.unresolved ?? []);
  const lastRunAt = input.existing?.runAt ?? null;

  for (const spec of ENRICHABLE_FIELD_SPECS) {
    const candidates = DEFAULT_FIELD_MAPPING[spec.key];

    if (hasValue(input.lead, candidates)) {
      humanHeld.push(spec.key);
      continue;
    }

    const cached = existingFields[spec.key];

    if (
      !input.force &&
      cached !== undefined &&
      isFresh(cached.retrievedAt, shelfLifeMsFor(spec.key, input), input.now)
    ) {
      fresh.push(spec.key);
      continue;
    }

    if (
      !input.force &&
      cached === undefined &&
      unresolved.has(spec.key) &&
      lastRunAt !== null &&
      isFresh(
        lastRunAt,
        Math.min(UNRESOLVED_RETRY_DAYS * DAY_MS, shelfLifeMsFor(spec.key, input)),
        input.now,
      )
    ) {
      recentlyUnresolved.push(spec.key);
      continue;
    }

    requested.push(spec.key);
  }

  const subject = readSubject(input.lead);

  return {
    requested,
    humanHeld,
    fresh,
    recentlyUnresolved,
    subject,
    query: buildSearchQuery(subject, requested),
  };
};

/**
 * The one search query a run is allowed.
 *
 * One, not one per field. A query per field would multiply the search bill by
 * five for results that overlap almost completely — a company profile page
 * answers industry, region and headcount in the same paragraph. The keywords are
 * derived from what is actually being asked so the query does not go fishing for
 * a headcount nobody wanted.
 *
 * `null` when there is no company *and* no person name. There is nothing honest
 * to search for, and "search the empty string" is how a provider quota gets
 * spent on noise.
 */
export const buildSearchQuery = (
  subject: ExtractionSubject,
  requested: readonly EnrichableFieldKey[],
): string | null => {
  if (subject.companyName.length === 0 && subject.personName.length === 0) {
    return null;
  }

  const keywords = new Set<string>();

  for (const key of requested) {
    switch (key) {
      case 'industry':
        keywords.add('industry');
        break;
      case 'region':
        keywords.add('headquarters');
        break;
      case 'employeeCount':
        keywords.add('number of employees');
        break;
      case 'jobTitle':
      case 'seniority':
        keywords.add('job title');
        break;
      default:
        break;
    }
  }

  // The company is the better search subject: it has a public footprint, and a
  // person's name alone is a query that returns homonyms. The person's name is
  // only added when a title is being asked for, which is the one question the
  // company page cannot answer.
  const subjectTerms =
    subject.companyName.length > 0
      ? [
          subject.companyName,
          ...(requested.includes('jobTitle') || requested.includes('seniority')
            ? [subject.personName]
            : []),
        ]
      : [subject.personName];

  const query = [...subjectTerms, ...keywords]
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .join(' ')
    .slice(0, 300);

  return query.length === 0 ? null : query;
};
