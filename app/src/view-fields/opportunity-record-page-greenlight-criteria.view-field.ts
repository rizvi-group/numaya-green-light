import {
  defineViewField,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  OPPORTUNITY_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS,
  PIPELINE_OPPORTUNITY_FIELD_UNIVERSAL_IDENTIFIERS,
} from 'src/constants/pipeline-identifiers';

/**
 * The criteria document, in System.
 *
 * It is raw JSON and no rep needs it day to day, which is the argument for
 * System rather than an argument for leaving it off the page — the same call the
 * score trace got on Person. System is where Twenty already keeps the fields you
 * go looking for only when something above them looks wrong, and "why does this
 * deal say 3 of 4 when the close date is clearly set" is that kind of question.
 *
 * Omitting it would leave the readiness percentage unauditable from the record,
 * and PIPELINE_SPEC.md is explicit that a readiness meter which hides the failed
 * criterion is a progress bar rather than an instruction. The board renders the
 * document as readable rows; this is the raw copy, on the record, for the reader
 * who does not believe the board.
 */
export default defineViewField({
  universalIdentifier:
    OPPORTUNITY_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightCriteria,
  viewUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.opportunity.views
      .opportunityRecordPageFields.universalIdentifier,
  viewFieldGroupUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.opportunity.views
      .opportunityRecordPageFields.viewFieldGroups.system.universalIdentifier,
  fieldMetadataUniversalIdentifier:
    PIPELINE_OPPORTUNITY_FIELD_UNIVERSAL_IDENTIFIERS.greenlightCriteria,
  position: 100,
  isVisible: true,
  size: 150,
});
