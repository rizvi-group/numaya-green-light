import {
  defineViewField,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  LEAD_SUPPRESSION_FIELD_UNIVERSAL_IDENTIFIERS,
  PERSON_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS,
} from 'src/constants/universal-identifiers';

/**
 * "Do not contact", on the record.
 *
 * The suppression fields are the one set here that is *human input* rather than
 * engine output, which makes their invisibility worse than the score's: a rep
 * could not see that a person had asked not to be contacted, and could not set
 * the flag from the record either. General, because it outranks everything else
 * on the page.
 */
export default defineViewField({
  universalIdentifier:
    PERSON_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightSuppressed,
  viewUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.views.personRecordPageFields
      .universalIdentifier,
  viewFieldGroupUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.views.personRecordPageFields
      .viewFieldGroups.general.universalIdentifier,
  fieldMetadataUniversalIdentifier:
    LEAD_SUPPRESSION_FIELD_UNIVERSAL_IDENTIFIERS.greenlightSuppressed,
  position: 102,
  isVisible: true,
  size: 150,
});
