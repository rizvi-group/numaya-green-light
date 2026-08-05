import {
  defineViewField,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  OPPORTUNITY_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS,
  PIPELINE_OPPORTUNITY_FIELD_UNIVERSAL_IDENTIFIERS,
} from 'src/constants/pipeline-identifiers';

/**
 * Readiness, on the Opportunity record page, in the Deal section.
 *
 * ## Why this file exists at all
 *
 * `defineField` gives Opportunity a `greenlightReadiness` column in the database
 * and in the API. It does **not** put it on the record page. The Fields panel a
 * rep reads is a `FIELDS_WIDGET` view — "Opportunity Record Page Fields" — and
 * it draws only the view fields that view holds, so a field that is not a view
 * field on it is simply not rendered anywhere a human will look.
 *
 * This is not a theoretical hazard. Ten Person fields shipped that way: a score,
 * a decision, a trace, four suppression fields and three enrichment fields, all
 * written correctly onto every Person and none of them visible on the record a
 * salesperson had open. The only trace of them on screen was a timeline entry
 * reading "Numaya Greenlight updated 4 fields", which nobody expands. They were
 * rescued afterwards by the ten `person-record-page-*.view-field.ts` files in
 * this directory. The pipeline fields ship with theirs from the start.
 *
 * See `OPPORTUNITY_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS` in
 * `src/constants/pipeline-identifiers.ts` for why the section is one of Twenty's
 * own rather than a Greenlight one, and why positions start at 100.
 *
 * Position 100 puts readiness first of the five: it is the number the other four
 * exist to explain.
 */
export default defineViewField({
  universalIdentifier:
    OPPORTUNITY_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightReadiness,
  viewUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.opportunity.views
      .opportunityRecordPageFields.universalIdentifier,
  viewFieldGroupUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.opportunity.views
      .opportunityRecordPageFields.viewFieldGroups.deal.universalIdentifier,
  fieldMetadataUniversalIdentifier:
    PIPELINE_OPPORTUNITY_FIELD_UNIVERSAL_IDENTIFIERS.greenlightReadiness,
  position: 100,
  isVisible: true,
  size: 150,
});
