import {
  defineViewField,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { ENRICHMENT_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/enrichment-identifiers';
import { PERSON_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/universal-identifiers';

/** How old the enrichment is, which is the only thing that says whether to believe it. */
export default defineViewField({
  universalIdentifier:
    PERSON_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightEnrichedAt,
  viewUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.views.personRecordPageFields
      .universalIdentifier,
  viewFieldGroupUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.views.personRecordPageFields
      .viewFieldGroups.work.universalIdentifier,
  fieldMetadataUniversalIdentifier:
    ENRICHMENT_FIELD_UNIVERSAL_IDENTIFIERS.greenlightEnrichedAt,
  position: 101,
  isVisible: true,
  size: 150,
});
