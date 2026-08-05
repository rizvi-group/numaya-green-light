import {
  defineViewField,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  PERSON_RECORD_PAGE_PIPELINE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS,
  PIPELINE_PERSON_FIELD_UNIVERSAL_IDENTIFIERS,
} from 'src/constants/pipeline-identifiers';

/**
 * The lead's action type, in General, beside the sentence it classifies.
 *
 * The coloured chip is what makes a Held lead legible at a glance next to the
 * gate decision two rows above it: the decision says the gate stopped this lead,
 * this says what would unstop it. See
 * `person-record-page-greenlight-next-action.view-field.ts` for why the three
 * Person advice fields are on the record page at all.
 */
export default defineViewField({
  universalIdentifier:
    PERSON_RECORD_PAGE_PIPELINE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightNextActionKind,
  viewUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.views.personRecordPageFields
      .universalIdentifier,
  viewFieldGroupUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.views.personRecordPageFields
      .viewFieldGroups.general.universalIdentifier,
  fieldMetadataUniversalIdentifier:
    PIPELINE_PERSON_FIELD_UNIVERSAL_IDENTIFIERS.greenlightNextActionKind,
  position: 111,
  isVisible: true,
  size: 180,
});
