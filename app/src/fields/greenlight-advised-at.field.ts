import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { PIPELINE_OPPORTUNITY_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/pipeline-identifiers';

/**
 * When the advice on this opportunity was last recomputed.
 *
 * ## The cache key, not a decoration
 *
 * PIPELINE_SPEC.md's performance section is the reason this column exists.
 * The board is **one** logic-function call for a whole workspace, because a
 * workspace with 1,205 people cannot issue 1,205 REST reads to paint a screen
 * against Twenty's limit of 100 requests per minute. Advice is therefore cached
 * on the record and recomputed on write or on explicit refresh, never on render
 * — and a cache with no timestamp cannot be invalidated, only rebuilt wholesale,
 * which is the thing the limit forbids.
 *
 * So this is the field the board reads to decide whether a card's sentence can
 * be trusted or has to be recomputed. Empty means the record has never been
 * advised, which is a different and useful state: it is how "cards the engine
 * has never looked at" is expressed as a filter, and it is why
 * `greenlightNextActionKind` has a `HEALTHY` option rather than treating an empty
 * kind as "nothing to do".
 *
 * A real column rather than a key inside `greenlightCriteria`'s document, for
 * the reason `greenlightEnrichedAt` is a column: it is the thing a view sorts on
 * and a filter compares against, and neither is possible through a nested JSON
 * key.
 *
 * ## It is the *recompute* date, not the date anything changed
 *
 * Written on every evaluation that completed, **including** one that produced
 * exactly the same sentence as before. That is deliberate and it is the same
 * discipline `greenlightEnrichedAt` follows: "we recomputed this on Tuesday and
 * nothing had changed" is precisely the fact that stops the card being
 * recomputed again on Wednesday. Advancing the timestamp only when the advice
 * changed would make a stable card look permanently stale and would defeat the
 * cache entirely on exactly the cards that need it least.
 *
 * Read-only: the engine owns it. A hand-edited date silently moves the
 * recompute window for a card nobody re-evaluated, which is a lie told by the
 * mechanism that exists to say how fresh the advice is.
 */
export default defineField({
  universalIdentifier:
    PIPELINE_OPPORTUNITY_FIELD_UNIVERSAL_IDENTIFIERS.greenlightAdvisedAt,
  name: 'greenlightAdvisedAt',
  // "Advised on", ~60px in the record page's 90px word-clamped label box.
  //
  // "Last advised" was the obvious choice — it mirrors "Last enriched", which
  // already ships on Person — and it was rejected for exactly that reason: on
  // the Person record page the two would sit near each other sharing a first
  // word, and the clamp drops trailing words, so the pair would collapse to the
  // same "Last …" the moment either surface got tighter. That is the bug
  // recorded in greenlight-decision.field.ts, and it is not worth reintroducing
  // for a parallelism only the developer notices.
  label: 'Advised on',
  description:
    "When Greenlight last recomputed the next action and readiness for this opportunity — including recomputations that produced no change. Empty means this record has never been advised. Advice is refreshed on write and on explicit refresh, never on render, so a date well in the past means the card is showing a cached recommendation.",
  type: FieldType.DATE_TIME,
  icon: 'IconClockBolt',
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.opportunity.universalIdentifier,
  isUIEditable: false,
  isNullable: true,
});
