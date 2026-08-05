import {
  defineViewField,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  OPPORTUNITY_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS,
  PIPELINE_OPPORTUNITY_FIELD_UNIVERSAL_IDENTIFIERS,
} from 'src/constants/pipeline-identifiers';

/**
 * The action type, in Deal, beside the sentence it classifies.
 *
 * Visible rather than hidden, even though the sentence above it says the same
 * thing in words. It is a coloured SELECT chip, so it is the part of the pair a
 * reader takes in without reading — red for a compliance stop, green for nothing
 * to do — and it is the only one of the two that tells a rep what they can
 * filter a view on. See `greenlight-next-action-kind.field.ts` for why the two
 * fields are separate at all.
 */
export default defineViewField({
  universalIdentifier:
    OPPORTUNITY_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightNextActionKind,
  viewUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.opportunity.views
      .opportunityRecordPageFields.universalIdentifier,
  viewFieldGroupUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.opportunity.views
      .opportunityRecordPageFields.viewFieldGroups.deal.universalIdentifier,
  fieldMetadataUniversalIdentifier:
    PIPELINE_OPPORTUNITY_FIELD_UNIVERSAL_IDENTIFIERS.greenlightNextActionKind,
  position: 102,
  isVisible: true,
  size: 180,
});
