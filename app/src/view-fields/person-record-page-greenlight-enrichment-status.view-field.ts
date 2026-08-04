import {
  defineViewField,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { ENRICHMENT_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/enrichment-identifiers';
import { PERSON_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/universal-identifiers';

/**
 * Whether enrichment ran, in Work.
 *
 * Enrichment answers questions about the person's employer and role, which is
 * what the Work section already holds — and "Not run" is a materially different
 * lead from "Enriched" when a rep is deciding whether to trust the score.
 */
export default defineViewField({
  universalIdentifier:
    PERSON_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightEnrichmentStatus,
  viewUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.views.personRecordPageFields
      .universalIdentifier,
  viewFieldGroupUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.views.personRecordPageFields
      .viewFieldGroups.work.universalIdentifier,
  fieldMetadataUniversalIdentifier:
    ENRICHMENT_FIELD_UNIVERSAL_IDENTIFIERS.greenlightEnrichmentStatus,
  position: 100,
  isVisible: true,
  size: 150,
});
