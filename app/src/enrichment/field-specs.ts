/**
 * The enrichable field catalogue: what may be asked for, in what shape.
 *
 * One table, read by three consumers that must not disagree — the prompt (what
 * the model is asked), the extractor (what is accepted back) and the gap
 * analysis (what is worth asking about at all). Keeping them keyed off the same
 * array is what stops the classic drift where a field is prompted for and then
 * silently discarded, or accepted without ever being requested.
 *
 * Every entry answers a *firmographic* question. Nothing here is a contact
 * detail: see the note on `EnrichableFieldKey` for why that boundary is a hard
 * one rather than a starting point.
 */

import type {
  EnrichableFieldKey,
  EnrichableFieldSpec,
} from 'src/enrichment/types';

export const ENRICHABLE_FIELD_SPECS: readonly EnrichableFieldSpec[] = [
  {
    key: 'industry',
    label: 'Industry',
    question: "What industry does this person's employer operate in?",
    kind: 'text',
    maxLength: 60,
  },
  {
    key: 'region',
    label: 'Region',
    question: 'Which country or region is the employer headquartered in?',
    kind: 'text',
    maxLength: 60,
  },
  {
    key: 'employeeCount',
    label: 'Employee count',
    question: 'Approximately how many people does the employer employ?',
    kind: 'integer',
    maxLength: 12,
  },
  {
    key: 'jobTitle',
    label: 'Job title',
    question: 'What is this person’s job title at that employer?',
    kind: 'text',
    maxLength: 120,
  },
  {
    key: 'seniority',
    label: 'Seniority',
    question:
      'What seniority level does that job title correspond to (for example: C-level, VP, Director, Manager, Individual contributor)?',
    kind: 'text',
    maxLength: 40,
  },
];

const SPEC_BY_KEY: ReadonlyMap<string, EnrichableFieldSpec> = new Map(
  ENRICHABLE_FIELD_SPECS.map((spec) => [spec.key, spec]),
);

export const findFieldSpec = (key: string): EnrichableFieldSpec | null =>
  SPEC_BY_KEY.get(key) ?? null;

export const isEnrichableFieldKey = (key: unknown): key is EnrichableFieldKey =>
  typeof key === 'string' && SPEC_BY_KEY.has(key);

/**
 * The dotted paths a workspace adds to its Layer 3 field mapping to let the
 * deterministic scorer read enriched values.
 *
 * Published from here rather than hard-coded in the config seed because the
 * shape of the provenance blob is this module's business, and a path written out
 * by hand somewhere else is a path that goes stale the first time the blob's
 * version changes.
 *
 * The ordering is the important part: the enriched path goes **after** the
 * workspace's own candidates in every mapping, never before. `field-access.ts`
 * tries candidates in order and takes the first that yields a value, so a human
 * value always wins and enrichment only ever fills a hole. That is the same
 * promise the storage shape makes — enrichment never overwrites a person — held
 * at the read side as well as the write side.
 */
export const enrichedFieldMappingPath = (key: EnrichableFieldKey): string =>
  `greenlightEnrichment.fields.${key}.parsedValue`;

export const ENRICHED_FIELD_MAPPING_PATHS: Readonly<
  Record<EnrichableFieldKey, string>
> = Object.freeze(
  Object.fromEntries(
    ENRICHABLE_FIELD_SPECS.map((spec) => [
      spec.key,
      enrichedFieldMappingPath(spec.key),
    ]),
  ) as Record<EnrichableFieldKey, string>,
);
