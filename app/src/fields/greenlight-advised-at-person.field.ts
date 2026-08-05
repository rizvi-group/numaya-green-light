import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { PIPELINE_PERSON_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/pipeline-identifiers';

/**
 * The Person half of `greenlightAdvisedAt`. See
 * `greenlight-advised-at.field.ts` for why the timestamp exists at all — it is
 * the board's cache key, not a decoration — and why it advances even when the
 * advice did not change.
 *
 * ## Three "when did Greenlight last…" columns on one object, and why that is
 * not two too many
 *
 * Person now carries `greenlightEnrichedAt`, `greenlightSuppressedAt` and this.
 * They are not variations on a theme; they are three independent clocks that go
 * out of step in ways a reader has to be able to see:
 *
 *   - `greenlightEnrichedAt` — when the app last went to the public web. It is
 *     rate-limited by the monthly enrichment cap and can be months old.
 *   - `greenlightSuppressedAt` — when a human recorded a do-not-contact. It
 *     never moves on its own.
 *   - this — when the app last worked out what to do next. It moves on every
 *     write to the record and on every explicit refresh, so it is normally the
 *     newest of the three by a wide margin.
 *
 * Collapsing them would mean an enrichment run that found nothing making the
 * advice look fresh, which is the precise misreading the board must not invite.
 */
export default defineField({
  universalIdentifier:
    PIPELINE_PERSON_FIELD_UNIVERSAL_IDENTIFIERS.greenlightAdvisedAt,
  name: 'greenlightAdvisedAt',
  // "Advised on", matching the Opportunity copy. The first word is deliberately
  // not "Last": "Last enriched" already ships on this same record page, and two
  // labels sharing a first word are one tight surface away from rendering as the
  // same clamped string. See the label note in greenlight-decision.field.ts.
  label: 'Advised on',
  description:
    "When Greenlight last recomputed the next action for this lead — including recomputations that produced no change. Empty means this record has never been advised. Separate from Last enriched, which records when the app last searched the public web, and normally much more recent than it.",
  type: FieldType.DATE_TIME,
  icon: 'IconClockBolt',
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
  isUIEditable: false,
  isNullable: true,
});
