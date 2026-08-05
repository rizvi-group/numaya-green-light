import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { LEAD_SUPPRESSION_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/universal-identifiers';

/**
 * The block-list flag. See `greenlight-score.field.ts` for why these fields live
 * on Person.
 *
 * ## Why Greenlight ships this field at all
 *
 * Twenty does no email management: no unsubscribe handling, no bounce tracking,
 * no do-not-contact list. The compliance rule used to read an opt-out flag only
 * through the customer's Layer 3 mapping (`optOutFieldNames` on
 * `GreenlightConfig`), and on a stock workspace that mapping points at nothing.
 * `read.booleanAny('optedOut')` returned `null`, the rule returned `pass`, and
 * the lead collected the full 15 points. The single compliance check in the
 * product could not fire on a default install and inflated every score while
 * failing to do so.
 *
 * Shipping this column is the structural fix: the rule can now fail, because
 * there is now somewhere for the answer to live.
 *
 * ## Why this one *is* UI-editable, unlike the score fields
 *
 * `greenlightScore` / `greenlightDecision` / `greenlightTrace` are engine output.
 * A hand-edited score is overwritten by the next event, so allowing the edit
 * would be a lie.
 *
 * Suppression is the exact opposite: it is human-maintained input. Somebody
 * replies "take me off your list" and a rep has to be able to act on that in the
 * ten seconds they have, on the record they are already looking at, without a
 * command menu, a panel, or an admin. Nothing in the engine ever writes these
 * four columns, so nothing in the engine can overwrite a hand edit. The audited
 * "Do not contact" action exists for the case where a recorded reason matters;
 * the field stays editable for the case where speed matters more.
 *
 * ## What happens when it changes
 *
 * A change here re-scores the lead. `SCORING_TRIGGER_PERSON_FIELDS` in
 * `src/logic-functions/scoring-run.ts` lists this field explicitly — it is the
 * one exception to that list being free of Greenlight-owned names, and the loop
 * still terminates because the scoring run writes only the three engine-owned
 * fields, none of which is on the trigger list. Without the exception, blocking
 * somebody would leave them sitting in the queue still marked as cleared.
 *
 * ## Why a BOOLEAN with a `false` default rather than a nullable one
 *
 * `false` here is a real assertion — "Greenlight's own do-not-contact register
 * has no entry for this person" — and the compliance rule pays full credit for
 * it. A nullable column would make "unknown" the resting state of every record
 * in the workspace, which would drop the compliance rule out of every score it
 * is supposed to be part of. Genuinely-unknown is still representable and still
 * handled: it is what the rule sees when neither this column nor a mapped
 * customer opt-out column is present on the record at all, and it produces
 * `not_applicable` — excluded from the score entirely rather than paid out.
 */
export default defineField({
  universalIdentifier:
    LEAD_SUPPRESSION_FIELD_UNIVERSAL_IDENTIFIERS.greenlightSuppressed,
  name: 'greenlightSuppressed',
  // Unchanged, and deliberately so: it is the only one of the four suppression
  // labels that already fitted the record page's 90px label box, and it is the
  // one a rep must be able to read without hovering. Its three satellites moved
  // to "Block …" so that they stop colliding with it — see
  // greenlight-suppression-reason.field.ts.
  label: 'Do not contact',
  description:
    'On when this person must not be contacted: they unsubscribed, hard bounced, complained, were blocked by hand, made a legal request, or arrived on a do-not-contact import. Greenlight blocks the lead outright while this is on, and the block cannot be released by hand — clear this field instead. Edit it directly, or use the audited "Do not contact" action when the reason needs to be on record.',
  type: FieldType.BOOLEAN,
  icon: 'IconHandStop',
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
  defaultValue: false,
});
