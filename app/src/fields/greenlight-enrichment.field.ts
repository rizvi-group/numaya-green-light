import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { ENRICHMENT_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/enrichment-identifiers';

/**
 * Where enriched values live — and, deliberately, the only place they live.
 *
 * ===========================================================================
 * ## Enriched data does not go in the customer's columns
 *
 * The obvious design writes the discovered industry into `Person.industry`.
 * PRODUCT_SPEC rules it out in six words: enriched data must be *"visually
 * distinct from human data"*. A value in the industry column is not distinct
 * from a value in the industry column — not in a table view, not in an export,
 * not in a filter, and not to the rep who reads it six weeks later.
 *
 * "Only write when the column is empty" does not rescue it either. An empty
 * column is frequently a considered "we do not know", and once a machine has
 * filled it, nobody can tell that nobody chose it.
 *
 * So this field is a **separate, lower-trust tier** sitting beside the record.
 * The customer's own columns are never written on the enrichment path. What the
 * deterministic scorer reads is decided by the workspace, explicitly, through
 * the Layer 3 field mapping — appending
 * `greenlightEnrichment.fields.<key>.parsedValue` *after* the workspace's own
 * candidates, so a human value always wins and enrichment only ever fills a
 * hole. See `ENRICHED_FIELD_MAPPING_PATHS` in `src/enrichment/field-specs.ts`.
 *
 * ## Why one JSON document rather than columns per field
 *
 * Every enriched value carries four things the spec requires: the value, the
 * source URL, the retrieval date and a confidence. Five enrichable fields is
 * twenty columns, growing with the catalogue, on an object the customer also
 * owns — a schema fighting its data.
 *
 * The deeper reason is atomicity. Split across columns, a crash between the
 * value write and the source write leaves an **unsourced value** on the record,
 * which is precisely the state PRODUCT_SPEC forbids, and no discipline at the
 * call site makes that unrepresentable. Here the unit of storage is the whole
 * `{ value, sourceUrl, retrievedAt, confidence, … }` document, written in one
 * mutation. There is no sequence of events that produces a value without its
 * source, because they are the same write — and the TypeScript type says so too:
 * every provenance member is required and non-nullable.
 *
 * ## Shape
 *
 * ```json
 * {
 *   "version": 1,
 *   "runId": "gle-1a2b3c4d-5e6f7a8b",
 *   "runAt": "2026-08-03T09:12:44.031Z",
 *   "engineVersion": "0.2.0",
 *   "fields": {
 *     "industry": {
 *       "value": "Industrial automation",
 *       "parsedValue": "Industrial automation",
 *       "sourceUrl": "https://example.com/about",
 *       "sourceTitle": "About — Example Automation GmbH",
 *       "retrievedAt": "2026-08-03T09:12:44.031Z",
 *       "confidence": 0.85,
 *       "verification": "confirmed",
 *       "reasoningProvider": "twenty-ai",
 *       "reasoningModel": "twenty-agent:extractor",
 *       "searchProvider": "brave",
 *       "engineVersion": "0.2.0"
 *     }
 *   },
 *   "sources": [{ "url": "…", "title": "…", "quarantined": false }],
 *   "unresolved": ["region"],
 *   "notes": []
 * }
 * ```
 *
 * `sources` includes pages that were **refused**, flagged `quarantined: true`.
 * That is not bookkeeping: a page carrying text addressed to the model is a
 * security event, and it belongs where an admin will meet it rather than only in
 * a log they have to know to search.
 *
 * `isUIEditable: false`. The engine owns this document; a hand-edited provenance
 * record is a forged citation, which is worse than no citation at all.
 * ===========================================================================
 */
export default defineField({
  universalIdentifier:
    ENRICHMENT_FIELD_UNIVERSAL_IDENTIFIERS.greenlightEnrichment,
  name: 'greenlightEnrichment',
  label: 'Greenlight enrichment',
  description:
    'Values Greenlight sourced from the public web, each stored with the page it came from, the date it was read and a confidence. This is machine-gathered data held separately from the fields your team maintains — it never overwrites anything a person entered.',
  type: FieldType.RAW_JSON,
  icon: 'IconSparkles',
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
  isUIEditable: false,
  isNullable: true,
});
