import {
  defineViewField,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  OPPORTUNITY_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS,
  PIPELINE_OPPORTUNITY_FIELD_UNIVERSAL_IDENTIFIERS,
} from 'src/constants/pipeline-identifiers';

/**
 * The next-action sentence, in Deal, directly under readiness.
 *
 * The board is where a rep normally meets this sentence, and that is an argument
 * for putting it on the record page rather than against it: somebody who opened
 * the deal from an email or from Twenty's own kanban never passed through the
 * board, and the whole point of the feature is that the recommendation is
 * wherever the deal is. See
 * `opportunity-record-page-greenlight-readiness.view-field.ts` for why a
 * standalone `defineViewField` is what makes any of these visible.
 *
 * Wider than the default 150: this field holds a sentence, not a token, and the
 * record page truncates a value that does not fit its column.
 */
export default defineViewField({
  universalIdentifier:
    OPPORTUNITY_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightNextAction,
  viewUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.opportunity.views
      .opportunityRecordPageFields.universalIdentifier,
  viewFieldGroupUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.opportunity.views
      .opportunityRecordPageFields.viewFieldGroups.deal.universalIdentifier,
  fieldMetadataUniversalIdentifier:
    PIPELINE_OPPORTUNITY_FIELD_UNIVERSAL_IDENTIFIERS.greenlightNextAction,
  position: 101,
  isVisible: true,
  size: 260,
});
