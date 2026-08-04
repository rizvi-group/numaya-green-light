import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { LEAD_SUPPRESSION_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/universal-identifiers';

/**
 * When this person went onto the block list.
 *
 * Separate from Twenty's own `updatedAt` for the reason every audit column is
 * separate from `updatedAt`: any edit to the record moves that one, so it cannot
 * answer "how long has this person been off-limits". That question has real
 * consequences — a suppression predating an import explains why a list is
 * smaller than expected, and a suppression dated after a campaign send is an
 * incident rather than a statistic.
 *
 * Written by the "Do not contact" action and **not rewritten when the reason is
 * amended**: relabelling a manual block as a legal request does not change the
 * date the person stopped being contactable. See `decideSuppress` in
 * `src/gate/suppression-decision.ts`.
 *
 * `DATE_TIME` rather than `DATE` because unsubscribes cluster inside the hour
 * after a send, and "which of these came in before we stopped the campaign" is
 * a question a date alone cannot answer.
 *
 * Nullable and UI-editable, like the rest of the suppression set: a rep
 * backfilling a suppression they are recording late needs to be able to say when
 * it actually happened.
 */
export default defineField({
  universalIdentifier:
    LEAD_SUPPRESSION_FIELD_UNIVERSAL_IDENTIFIERS.greenlightSuppressedAt,
  name: 'greenlightSuppressedAt',
  label: 'Do not contact since',
  description:
    'When this person was added to the Greenlight block list. Set automatically by the "Do not contact" action, and left untouched when the reason is later amended — this is the date contact stopped, not the date the record was last edited.',
  type: FieldType.DATE_TIME,
  icon: 'IconCalendarOff',
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
  isNullable: true,
});
