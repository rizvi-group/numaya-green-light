import {
  defineView,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
  ViewFilterOperand,
  ViewSortDirection,
  ViewType,
} from 'twenty-sdk/define';

import {
  ENRICHED_LEADS_VIEW_FIELD_UNIVERSAL_IDENTIFIERS,
  ENRICHED_LEADS_VIEW_FILTER_UNIVERSAL_IDENTIFIER,
  ENRICHED_LEADS_VIEW_SORT_UNIVERSAL_IDENTIFIER,
  ENRICHED_LEADS_VIEW_UNIVERSAL_IDENTIFIER,
  ENRICHMENT_FIELD_UNIVERSAL_IDENTIFIERS,
} from 'src/constants/enrichment-identifiers';
import { LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/universal-identifiers';

const PERSON = STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person;

/**
 * Every lead enrichment has touched — and, more importantly, every lead it
 * tried to touch and could not.
 *
 * ## Why the filter is not `status = ENRICHED`
 *
 * Because the interesting rows are the other ones. A view of successes tells an
 * admin that a thing they are paying for is working; a view that also carries
 * `CAPPED`, `FAILED` and `NOTHING_FOUND` tells them *when it stops*, which is
 * the question they will actually have. The filter is therefore "status is not
 * empty" — expressed as `IS_NOT_EMPTY` on the status column, so it shows every
 * lead the enrichment path has reached a verdict on and nothing else.
 *
 * A workspace with no enrichment licence sees an empty list, because the run
 * writes nothing at all when the gate is closed. That is the correct emptiness:
 * a page of `UNLICENSED` rows would be one write per lead, forever, to record a
 * fact about the workspace rather than about any lead.
 *
 * ## The columns
 *
 * Status first, because it is what the view is for. `Last enriched` second, so
 * "when did this stop" is answerable by reading down one column. The lead score
 * is there because the whole point of enrichment is to make that score
 * mean something — an admin comparing a column of enriched leads against their
 * scores is doing the exact evaluation that justifies the feature's cost. Job
 * title and company are the human context that makes a row identifiable.
 *
 * The enrichment document itself is deliberately **not** a column. It is a
 * nested JSON record whose whole value is in the sources it carries, and a table
 * cell renders it as unreadable text; it belongs in the enrichment panel, where
 * each value is shown with its link, its date and its confidence.
 *
 * Sorted by `Last enriched`, newest first — the same reasoning as the unscored
 * queue. The question is "is this happening right now", not "what is oldest".
 */
export default defineView({
  universalIdentifier: ENRICHED_LEADS_VIEW_UNIVERSAL_IDENTIFIER,
  name: 'Greenlight Enrichment',
  objectUniversalIdentifier: PERSON.universalIdentifier,
  type: ViewType.TABLE,
  icon: 'IconSparkles',
  position: 5,
  filters: [
    {
      universalIdentifier: ENRICHED_LEADS_VIEW_FILTER_UNIVERSAL_IDENTIFIER,
      fieldMetadataUniversalIdentifier:
        ENRICHMENT_FIELD_UNIVERSAL_IDENTIFIERS.greenlightEnrichmentStatus,
      operand: ViewFilterOperand.IS_NOT_EMPTY,
      value: '',
    },
  ],
  sorts: [
    {
      universalIdentifier: ENRICHED_LEADS_VIEW_SORT_UNIVERSAL_IDENTIFIER,
      fieldMetadataUniversalIdentifier:
        ENRICHMENT_FIELD_UNIVERSAL_IDENTIFIERS.greenlightEnrichedAt,
      direction: ViewSortDirection.DESC,
    },
  ],
  fields: [
    {
      universalIdentifier: ENRICHED_LEADS_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.name,
      fieldMetadataUniversalIdentifier: PERSON.fields.name.universalIdentifier,
      position: 0,
      isVisible: true,
      size: 180,
    },
    {
      universalIdentifier:
        ENRICHED_LEADS_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightEnrichmentStatus,
      fieldMetadataUniversalIdentifier:
        ENRICHMENT_FIELD_UNIVERSAL_IDENTIFIERS.greenlightEnrichmentStatus,
      position: 1,
      isVisible: true,
      size: 150,
    },
    {
      universalIdentifier:
        ENRICHED_LEADS_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightEnrichedAt,
      fieldMetadataUniversalIdentifier:
        ENRICHMENT_FIELD_UNIVERSAL_IDENTIFIERS.greenlightEnrichedAt,
      position: 2,
      isVisible: true,
      size: 150,
    },
    {
      universalIdentifier:
        ENRICHED_LEADS_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightScore,
      fieldMetadataUniversalIdentifier:
        LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS.greenlightScore,
      position: 3,
      isVisible: true,
      size: 110,
    },
    {
      universalIdentifier: ENRICHED_LEADS_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.jobTitle,
      fieldMetadataUniversalIdentifier: PERSON.fields.jobTitle.universalIdentifier,
      position: 4,
      isVisible: true,
      size: 160,
    },
    {
      universalIdentifier: ENRICHED_LEADS_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.company,
      fieldMetadataUniversalIdentifier: PERSON.fields.company.universalIdentifier,
      position: 5,
      isVisible: true,
      size: 160,
    },
  ],
});
