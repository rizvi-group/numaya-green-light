import {
  defineViewField,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  LEAD_SUPPRESSION_FIELD_UNIVERSAL_IDENTIFIERS,
  PERSON_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS,
} from 'src/constants/universal-identifiers';

/** When the suppression was recorded — the date a compliance question starts from. */
export default defineViewField({
  universalIdentifier:
    PERSON_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightSuppressedAt,
  viewUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.views.personRecordPageFields
      .universalIdentifier,
  viewFieldGroupUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.views.personRecordPageFields
      .viewFieldGroups.general.universalIdentifier,
  fieldMetadataUniversalIdentifier:
    LEAD_SUPPRESSION_FIELD_UNIVERSAL_IDENTIFIERS.greenlightSuppressedAt,
  position: 105,
  isVisible: true,
  size: 150,
});
