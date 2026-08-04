import {
  defineViewField,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS,
  PERSON_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS,
} from 'src/constants/universal-identifiers';

/**
 * The gate verdict, next to the score.
 *
 * This is the field the whole product exists to set, and until this file it was
 * readable only in the gate queue or by expanding a timeline entry — never on
 * the record a rep is about to act on. It sits directly under the score because
 * the two are one sentence: "39.8, so held".
 */
export default defineViewField({
  universalIdentifier:
    PERSON_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightDecision,
  viewUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.views.personRecordPageFields
      .universalIdentifier,
  viewFieldGroupUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.views.personRecordPageFields
      .viewFieldGroups.general.universalIdentifier,
  fieldMetadataUniversalIdentifier:
    LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS.greenlightDecision,
  position: 101,
  isVisible: true,
  size: 150,
});
