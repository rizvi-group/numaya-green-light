import {
  defineViewField,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  OPPORTUNITY_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS,
  PIPELINE_OPPORTUNITY_FIELD_UNIVERSAL_IDENTIFIERS,
} from 'src/constants/pipeline-identifiers';

/**
 * When the advice was last recomputed, in Deal, last of the four.
 *
 * On the page rather than tucked into System because it is the only thing that
 * tells a reader whether the three values above it can be trusted. Advice is
 * cached and recomputed on write or on explicit refresh, never on render, so a
 * sentence with no date beside it is a recommendation of unknown age presented
 * as current — and a rep acting on a month-old "book a discovery call" is
 * exactly the failure this feature exists to prevent.
 */
export default defineViewField({
  universalIdentifier:
    OPPORTUNITY_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightAdvisedAt,
  viewUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.opportunity.views
      .opportunityRecordPageFields.universalIdentifier,
  viewFieldGroupUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.opportunity.views
      .opportunityRecordPageFields.viewFieldGroups.deal.universalIdentifier,
  fieldMetadataUniversalIdentifier:
    PIPELINE_OPPORTUNITY_FIELD_UNIVERSAL_IDENTIFIERS.greenlightAdvisedAt,
  position: 103,
  isVisible: true,
  size: 150,
});
