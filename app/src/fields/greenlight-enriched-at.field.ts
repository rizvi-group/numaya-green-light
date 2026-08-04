import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { ENRICHMENT_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/enrichment-identifiers';

/**
 * When enrichment last ran against this lead.
 *
 * A real column rather than a read out of the JSON document, for the same
 * reason `greenlightSuppressedAt` is a column: it is the thing a view sorts on
 * and a filter compares against, and neither is possible through a nested key
 * in a `RAW_JSON` field.
 *
 * ## It is the *run* date, not the value date
 *
 * Each enriched value carries its own `retrievedAt` inside the document, and
 * those are what the shelf-life cache reads — a run that refreshed the industry
 * and left the headcount alone must not reset the headcount's clock, or the
 * cache would never expire and the freshness guarantee would be a lie told by
 * the code that maintains it.
 *
 * This column answers the different, operational question: has Greenlight looked
 * at this lead at all, and how long ago. Blank means never, which is what the
 * "not yet enriched" view is built on.
 *
 * Written on every run that reached a provider, **including** a run that found
 * nothing. That is deliberate — "we looked on Tuesday and there was nothing" is
 * the fact that stops the same lead being looked up again on Wednesday, and it
 * is the single largest saving against the monthly cap.
 *
 * Read-only: the engine owns it. A hand-edited date would silently move the
 * cache window for a lead nobody re-checked.
 */
export default defineField({
  universalIdentifier:
    ENRICHMENT_FIELD_UNIVERSAL_IDENTIFIERS.greenlightEnrichedAt,
  name: 'greenlightEnrichedAt',
  label: 'Last enriched',
  description:
    'When Greenlight last searched for information about this lead — including runs that found nothing. Empty means enrichment has never run on this record. Individual enriched values carry their own retrieval dates.',
  type: FieldType.DATE_TIME,
  icon: 'IconClockSearch',
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
  isUIEditable: false,
  isNullable: true,
});
