/**
 * The provenance record — what enrichment writes, and why it has this shape.
 *
 * ===========================================================================
 * ## The shape, and the two rules that produced it
 *
 * PRODUCT_SPEC states the requirement in one line: *"No unsourced values; every
 * enriched field has source URL + date + confidence. Visually distinct from
 * human data."* Two rules fall out of it, and between them they decide
 * everything below.
 *
 * ### Rule 1 — an enriched value never lands in a human's column
 *
 * The obvious implementation is to write the industry into `Person.industry` and
 * keep the provenance somewhere alongside. It is also wrong, twice over:
 *
 *   - **It is not visually distinct.** A value in the industry column looks like
 *     every other value in the industry column. Whatever the record page shows,
 *     a table view, an export and a filter all render it as fact.
 *   - **It destroys human input.** "Only write when the column is empty" sounds
 *     like a guard, but an empty column is often a deliberate "we do not know",
 *     and once a machine value is in there, the next person to look has no way
 *     to tell that nobody chose it.
 *
 * So enriched values live in Greenlight's own field, `greenlightEnrichment`, and
 * the customer's columns are never written by this path at all. Enriched data is
 * a **separate, lower-trust tier** sitting beside the record, not mixed into it,
 * and it is distinct in the CRM because it is literally a different field —
 * read-only, named for what it is, and rendered with its sources by
 * `src/front-components/greenlight-enrichment-panel.tsx`.
 *
 * ### Rule 2 — provenance travels *with* the value, not next to it
 *
 * The alternative shape is a sidecar: values in one place, sources in another,
 * joined by field name. ARCHITECTURE.md's Path 2 step 7 even hints at it —
 * `_source_url`, `_retrieved_at`, `_confidence` per field. Rejected, because a
 * sidecar can be half-written. A crash between the value write and the source
 * write leaves an unsourced value on the record, which is the exact state the
 * requirement forbids, and no amount of care at the call site makes that
 * unrepresentable.
 *
 * Here the unit of storage is `{ value, sourceUrl, retrievedAt, confidence, … }`
 * and it is written as one JSON document in one mutation. There is no sequence
 * of events that produces a value without its source, because they are the same
 * write. The type says the same thing — every provenance member is required and
 * non-nullable — so a value with no source cannot even be constructed in memory.
 *
 * ### Why one RAW_JSON field rather than three columns per enriched field
 *
 * Five enrichable fields × four provenance members is twenty columns, growing
 * every time the catalogue grows, on an object the customer also owns. Twenty
 * columns to express one nested record is a schema fighting its data. The nested
 * document is queried by the panel, filtered on through `greenlightEnrichedAt`
 * and `greenlightEnrichmentStatus` — which *are* real columns precisely because
 * those two are the things a view needs to filter and sort on — and read by the
 * scorer through dotted paths, which Twenty and `field-access.ts` both support
 * natively.
 * ===========================================================================
 */

import { ENRICHABLE_FIELD_SPECS } from 'src/enrichment/field-specs';
import type { EvidenceSet } from 'src/enrichment/sanitise';
import {
  ENRICHMENT_ENGINE_VERSION,
  type EnrichableFieldKey,
  type EnrichedFieldProvenance,
  type EnrichmentPayload,
  type EnrichmentSource,
  type EnrichmentStatusValue,
  type ReasoningProviderName,
  type SearchProviderName,
  type VerificationState,
} from 'src/enrichment/types';

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readProvenance = (value: unknown): EnrichedFieldProvenance | null => {
  if (!isRecord(value)) {
    return null;
  }

  const { value: fieldValue, sourceUrl, retrievedAt, confidence } = value;

  // The four the requirement names. A stored entry missing any of them is not a
  // weaker record, it is an *unsourced value*, and the only safe reading of one
  // is that it does not exist. Dropping it means the field is re-fetched, which
  // is exactly right.
  if (
    typeof fieldValue !== 'string' ||
    typeof sourceUrl !== 'string' ||
    typeof retrievedAt !== 'string' ||
    typeof confidence !== 'number'
  ) {
    return null;
  }

  const parsed = value['parsedValue'];

  return {
    value: fieldValue,
    parsedValue:
      typeof parsed === 'string' || typeof parsed === 'number' ? parsed : fieldValue,
    sourceUrl,
    sourceTitle: typeof value['sourceTitle'] === 'string' ? value['sourceTitle'] : '',
    retrievedAt,
    confidence,
    verification: isVerificationState(value['verification'])
      ? value['verification']
      : 'substantiated',
    reasoningProvider: isReasoningProvider(value['reasoningProvider'])
      ? value['reasoningProvider']
      : 'none',
    reasoningModel:
      typeof value['reasoningModel'] === 'string' ? value['reasoningModel'] : '',
    searchProvider: isSearchProvider(value['searchProvider'])
      ? value['searchProvider']
      : 'none',
    engineVersion:
      typeof value['engineVersion'] === 'string' ? value['engineVersion'] : '',
  };
};

const isVerificationState = (value: unknown): value is VerificationState =>
  value === 'substantiated' || value === 'confirmed' || value === 'unconfirmed';

const isReasoningProvider = (value: unknown): value is ReasoningProviderName =>
  value === 'twenty-ai' || value === 'openai-compatible' || value === 'none';

const isSearchProvider = (value: unknown): value is SearchProviderName =>
  value === 'brave' || value === 'serper' || value === 'none';

const ENRICHABLE_KEYS = new Set<string>(
  ENRICHABLE_FIELD_SPECS.map((spec) => spec.key),
);

/**
 * Read whatever is on the record. Anything unrecognisable becomes `null`, i.e.
 * "nothing has been enriched", which makes the next run re-fetch rather than
 * throw inside an event handler.
 */
export const readEnrichmentPayload = (raw: unknown): EnrichmentPayload | null => {
  if (!isRecord(raw)) {
    return null;
  }

  const fieldsRaw = raw['fields'];
  const fields: Partial<Record<EnrichableFieldKey, EnrichedFieldProvenance>> = {};

  if (isRecord(fieldsRaw)) {
    for (const [key, value] of Object.entries(fieldsRaw)) {
      if (!ENRICHABLE_KEYS.has(key)) {
        continue;
      }

      const provenance = readProvenance(value);

      if (provenance !== null) {
        fields[key as EnrichableFieldKey] = provenance;
      }
    }
  }

  return {
    version: 1,
    runId: typeof raw['runId'] === 'string' ? raw['runId'] : '',
    runAt: typeof raw['runAt'] === 'string' ? raw['runAt'] : '',
    engineVersion:
      typeof raw['engineVersion'] === 'string' ? raw['engineVersion'] : '',
    fields,
    sources: readSources(raw['sources']),
    unresolved: Array.isArray(raw['unresolved'])
      ? raw['unresolved'].filter((key): key is EnrichableFieldKey =>
          ENRICHABLE_KEYS.has(key as string),
        )
      : [],
    notes: Array.isArray(raw['notes'])
      ? raw['notes'].filter((note): note is string => typeof note === 'string')
      : [],
  };
};

const readSources = (raw: unknown): readonly EnrichmentSource[] => {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry): EnrichmentSource[] => {
    if (!isRecord(entry) || typeof entry['url'] !== 'string') {
      return [];
    }

    return [
      {
        url: entry['url'],
        title: typeof entry['title'] === 'string' ? entry['title'] : '',
        quarantined: entry['quarantined'] === true,
      },
    ];
  });
};

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

export interface AcceptedField {
  readonly key: EnrichableFieldKey;
  readonly value: string;
  readonly parsedValue: string | number;
  readonly sourceUrl: string;
  readonly sourceTitle: string;
  readonly confidence: number;
  readonly verification: VerificationState;
}

export interface BuildPayloadInput {
  readonly runId: string;
  readonly now: Date;
  readonly previous: EnrichmentPayload | null;
  readonly accepted: readonly AcceptedField[];
  /** Everything this run asked about, so unanswered keys become `unresolved`. */
  readonly requested: readonly EnrichableFieldKey[];
  readonly evidence: EvidenceSet;
  readonly reasoningProvider: ReasoningProviderName;
  readonly reasoningModel: string;
  readonly searchProvider: SearchProviderName;
  readonly notes: readonly string[];
}

/**
 * Build the document to write.
 *
 * Merges rather than replaces: fields the previous run sourced and this run did
 * not ask about are carried forward with their original `retrievedAt` intact.
 * Rewriting the date on a value we did not re-check would reset its shelf life
 * to now — the cache would then never expire, and the freshness guarantee the
 * date exists to give would be a lie told by the code that maintains it.
 */
export const buildEnrichmentPayload = (
  input: BuildPayloadInput,
): EnrichmentPayload => {
  const retrievedAt = input.now.toISOString();
  const fields: Partial<Record<EnrichableFieldKey, EnrichedFieldProvenance>> = {
    ...(input.previous?.fields ?? {}),
  };

  for (const field of input.accepted) {
    fields[field.key] = {
      value: field.value,
      parsedValue: field.parsedValue,
      sourceUrl: field.sourceUrl,
      sourceTitle: field.sourceTitle,
      retrievedAt,
      confidence: field.confidence,
      verification: field.verification,
      reasoningProvider: input.reasoningProvider,
      reasoningModel: input.reasoningModel,
      searchProvider: input.searchProvider,
      engineVersion: ENRICHMENT_ENGINE_VERSION,
    };
  }

  const answered = new Set<string>(input.accepted.map((field) => field.key));
  const unresolvedNow = input.requested.filter((key) => !answered.has(key));

  // Carry forward previous unresolved keys that this run did not revisit, so a
  // partial run does not reset another field's back-off window.
  const carried = (input.previous?.unresolved ?? []).filter(
    (key) => !input.requested.includes(key) && fields[key] === undefined,
  );

  return {
    version: 1,
    runId: input.runId,
    runAt: retrievedAt,
    engineVersion: ENRICHMENT_ENGINE_VERSION,
    fields,
    sources: buildSources(input.evidence),
    unresolved: [...new Set([...unresolvedNow, ...carried])],
    notes: input.notes,
  };
};

/**
 * Every source consulted, including the quarantined ones.
 *
 * Recording a page we *refused* to read matters: it is the difference between
 * "nothing was found about this company" and "something was found and it was
 * trying to talk to the model". The second is a security event, and it belongs
 * on the record where an admin will meet it, not only in a log line.
 */
const buildSources = (evidence: EvidenceSet): readonly EnrichmentSource[] => [
  ...evidence.documents.map((document) => ({
    url: document.url,
    title: document.title,
    quarantined: false,
  })),
  ...evidence.quarantined.map((document) => ({
    url: document.url,
    title: document.title,
    quarantined: true,
  })),
];

/* -------------------------------------------------------------------------- */
/* Status                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The SELECT value written to `Person.greenlightEnrichmentStatus`.
 *
 * A column rather than a derived UI state because it is what the views filter
 * on, and because "enrichment stopped happening" must be visible in a list
 * without opening a record. `CAPPED` and `UNLICENSED` are separate values for
 * the same reason: they look identical to a rep and require completely different
 * actions from an admin.
 */
export const enrichmentStatusFor = (
  outcome:
    | { kind: 'enriched'; fieldsWritten: number }
    | { kind: 'skipped'; reason: string }
    | { kind: 'failed' },
): EnrichmentStatusValue => {
  if (outcome.kind === 'failed') {
    return 'FAILED';
  }

  if (outcome.kind === 'enriched') {
    return outcome.fieldsWritten > 0 ? 'ENRICHED' : 'NOTHING_FOUND';
  }

  switch (outcome.reason) {
    case 'cap_exhausted':
      return 'CAPPED';
    case 'licence_not_entitled':
      return 'UNLICENSED';
    case 'no_supported_values':
    case 'search_no_results':
      return 'NOTHING_FOUND';
    default:
      return 'SKIPPED';
  }
};

/** FNV-1a, 32-bit — the same hash `scoring-run.ts` uses, for the same reasons. */
const hash32 = (input: string): string => {
  let hash = 0x811c9dc5;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, '0');
};

/**
 * A run id that is stable for a given lead within a given minute.
 *
 * Deliberately time-bucketed rather than random: the platform can deliver the
 * same database event twice, and two audit rows carrying the same run id are
 * recognisable as one run being retried rather than as the lead having been
 * enriched twice.
 */
export const buildEnrichmentRunId = (leadRecordId: string, now: Date): string =>
  `gle-${hash32(leadRecordId)}-${hash32(now.toISOString().slice(0, 16))}`;
