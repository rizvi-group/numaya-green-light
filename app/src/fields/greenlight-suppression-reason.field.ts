import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { LEAD_SUPPRESSION_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/universal-identifiers';
import { SUPPRESSION_REASONS } from 'src/gate/suppression-decision';

/**
 * Why this person must not be contacted.
 *
 * ## One vocabulary, two consumers
 *
 * The option list is generated from `SUPPRESSION_REASONS` in
 * `src/gate/suppression-decision.ts` rather than typed out again here. That
 * module is pure — no SDK import — so the two logic functions and the two front
 * components can share it, and a code that exists in the panel but not in the
 * SELECT would be a runtime rejection that no test catches. Generating the list
 * makes the drift impossible rather than merely unlikely.
 *
 * `position` is display order only; option identity derives from `value`. New
 * reasons are appended to the array in that module and land here automatically.
 *
 * ## Why every option is red
 *
 * There is no gradient to express. "Unsubscribed" and "spam complaint" differ in
 * how expensive they were to earn, not in what they permit — every entry on this
 * list means the same thing to a rep about to send an email, and colouring some
 * of them amber would invite exactly the "this one's only a soft block" reading
 * that the field exists to prevent. Red on every option makes the whole column
 * a stop signal at a glance in a table, a filter dropdown and a record page.
 *
 * ## A reason without the flag still blocks
 *
 * The compliance rule treats a recorded reason as suppression even when
 * `greenlightSuppressed` has been unticked, and the block-list actions clear
 * both together. Untick-the-box-but-leave-the-reason is the realistic hand
 * edit, and reading it as "contactable" would silently re-enable outreach to
 * somebody whose own record still states, in writing, why we stopped.
 */
export default defineField({
  universalIdentifier:
    LEAD_SUPPRESSION_FIELD_UNIVERSAL_IDENTIFIERS.greenlightSuppressionReason,
  name: 'greenlightSuppressionReason',
  // "Block reason", not "Do not contact reason". All three satellites of the
  // flag used to open with the same fourteen characters, and the record page
  // clamps a label to 90px on a word boundary, so they rendered as three
  // identical "Do not contact …" rows. The flag itself keeps its name — it fits,
  // and it is the one that has to be unmissable — while its satellites take the
  // block-list vocabulary these descriptions have always used. See the label
  // note in greenlight-decision.field.ts.
  label: 'Block reason',
  description:
    'Why this person is on the Greenlight block list. Set alongside "Do not contact" — a reason recorded here blocks the lead even if the flag is cleared, so remove both together when lifting a suppression.',
  type: FieldType.SELECT,
  icon: 'IconBan',
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
  options: SUPPRESSION_REASONS.map((reason, index) => ({
    position: index,
    label: reason.label,
    value: reason.code,
    color: 'red',
  })),
  isNullable: true,
});
