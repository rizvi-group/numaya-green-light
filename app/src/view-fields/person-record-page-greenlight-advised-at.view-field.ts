import {
  defineViewField,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  PERSON_RECORD_PAGE_PIPELINE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS,
  PIPELINE_PERSON_FIELD_UNIVERSAL_IDENTIFIERS,
} from 'src/constants/pipeline-identifiers';

/**
 * When the lead's advice was last recomputed, in General, last of the three.
 *
 * It sits on the same record page as "Last enriched", and the two are
 * deliberately different clocks rather than a redundancy: enrichment is
 * rate-limited by the monthly cap and can be months old, while advice moves on
 * every write. A reader who cannot see both cannot tell a stale recommendation
 * from a stale fact, and the two are fixed in completely different ways.
 */
export default defineViewField({
  universalIdentifier:
    PERSON_RECORD_PAGE_PIPELINE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightAdvisedAt,
  viewUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.views.personRecordPageFields
      .universalIdentifier,
  viewFieldGroupUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.views.personRecordPageFields
      .viewFieldGroups.general.universalIdentifier,
  fieldMetadataUniversalIdentifier:
    PIPELINE_PERSON_FIELD_UNIVERSAL_IDENTIFIERS.greenlightAdvisedAt,
  position: 112,
  isVisible: true,
  size: 150,
});
