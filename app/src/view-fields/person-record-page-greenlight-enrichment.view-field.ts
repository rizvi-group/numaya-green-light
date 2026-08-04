import {
  defineViewField,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { ENRICHMENT_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/enrichment-identifiers';
import { PERSON_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/universal-identifiers';

/**
 * What enrichment actually found.
 *
 * Last of the three because it is the payload: a rep reads "Enriched, two days
 * ago" first and only opens the evidence if the score surprises them.
 */
export default defineViewField({
  universalIdentifier:
    PERSON_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightEnrichment,
  viewUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.views.personRecordPageFields
      .universalIdentifier,
  viewFieldGroupUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.views.personRecordPageFields
      .viewFieldGroups.work.universalIdentifier,
  fieldMetadataUniversalIdentifier:
    ENRICHMENT_FIELD_UNIVERSAL_IDENTIFIERS.greenlightEnrichment,
  position: 102,
  isVisible: true,
  size: 150,
});
