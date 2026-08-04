import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { ENRICHMENT_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/enrichment-identifiers';

/**
 * What happened the last time enrichment considered this lead.
 *
 * ## Why a SELECT and not a derived UI state
 *
 * Because the questions it answers are list questions. "Which leads did we fail
 * to enrich this month" and "did enrichment stop working" have to be answerable
 * from a table with a filter on it, without opening a record and without an
 * admin knowing to grep a log. A value computed in a front component is
 * invisible to every view, every export and every saved filter in the product.
 *
 * ## Why the skip reasons are separate options
 *
 * `CAPPED` and `UNLICENSED` look identical to a rep — nothing was enriched — and
 * require completely different actions from an admin: one is "wait for the first
 * of the month, or raise the cap", the other is "your licence does not include
 * this". Collapsing them into `SKIPPED` would produce a support ticket every
 * time either happened.
 *
 * `NOTHING_FOUND` is separated from `SKIPPED` for the same reason in the other
 * direction: it means the machinery worked correctly and the web had nothing to
 * say, which is a normal outcome and not a fault. A view that alarmed on it
 * would cry wolf on every lead at a company with no website.
 *
 * ## What is deliberately *not* written
 *
 * A `UNLICENSED` stamp on every lead in a rules-only workspace. That is one
 * write per lead event, forever, to record a fact that is true of the entire
 * workspace and is already on the licence panel — so the enrichment run skips
 * silently when the licence gate is closed and writes nothing at all. Same for
 * "no search provider configured": a workspace that has not opted into
 * enrichment should not have its records rewritten to say so.
 *
 * Read-only. This is engine output; the human control is the "Enrich now"
 * command, which is logged.
 */
export default defineField({
  universalIdentifier:
    ENRICHMENT_FIELD_UNIVERSAL_IDENTIFIERS.greenlightEnrichmentStatus,
  name: 'greenlightEnrichmentStatus',
  label: 'Enrichment status',
  description:
    'What happened the last time Greenlight tried to enrich this lead. Empty means it has never tried.',
  type: FieldType.SELECT,
  icon: 'IconSparkles',
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
  isUIEditable: false,
  isNullable: true,
  options: [
    { position: 0, label: 'Not run', value: 'NOT_RUN', color: 'gray' },
    { position: 1, label: 'Enriched', value: 'ENRICHED', color: 'green' },
    {
      position: 2,
      label: 'Nothing found',
      value: 'NOTHING_FOUND',
      color: 'gray',
    },
    { position: 3, label: 'Skipped', value: 'SKIPPED', color: 'gray' },
    { position: 4, label: 'Monthly cap reached', value: 'CAPPED', color: 'orange' },
    { position: 5, label: 'Not licensed', value: 'UNLICENSED', color: 'yellow' },
    { position: 6, label: 'Failed', value: 'FAILED', color: 'red' },
  ],
});
