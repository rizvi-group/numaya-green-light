import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { LEAD_SUPPRESSION_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/universal-identifiers';

/**
 * Provenance for the suppression, in the words of whoever recorded it.
 *
 * The closed reason list says what *kind* of block this is; it cannot say
 * "replied to the March newsletter asking to be removed, forwarded to
 * compliance@". Six categories are enough to filter and count on and nowhere
 * near enough to explain a specific record to a colleague in a year's time,
 * which is when this field earns its keep.
 *
 * Optional on the way in — a hard bounce needs no commentary and a mandatory box
 * only ever collects the word "ok". Note that the *removal* action takes the
 * opposite line and requires a note: see `MIN_UNSUPPRESSION_NOTE_LENGTH` in
 * `src/gate/suppression-decision.ts` for why the asymmetry is deliberate.
 *
 * Cleared, not preserved, when a suppression is lifted. The permanent record of
 * both the block and its removal lives in `GreenlightAuditLog`, which is
 * append-only; leaving stale provenance on a record that is contactable again
 * would be actively misleading. That is also why this stays a plain TEXT field
 * and the description warns against writing anything here that should not sit in
 * a CRM column indefinitely.
 */
export default defineField({
  universalIdentifier:
    LEAD_SUPPRESSION_FIELD_UNIVERSAL_IDENTIFIERS.greenlightSuppressionNote,
  name: 'greenlightSuppressionNote',
  // See greenlight-suppression-reason.field.ts for why the satellites of the
  // "Do not contact" flag are labelled "Block …".
  label: 'Block note',
  description:
    'Free-text provenance for the block: where the request came from, who logged it, which campaign it followed. Cleared when the suppression is lifted — the permanent history is in the Greenlight audit log. Do not record anything here about the person that does not belong in a CRM column indefinitely.',
  type: FieldType.TEXT,
  icon: 'IconMessage2',
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
  defaultValue: "''",
});
