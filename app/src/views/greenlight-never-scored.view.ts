import {
  defineView,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
  ViewFilterOperand,
  ViewSortDirection,
  ViewType,
} from 'twenty-sdk/define';

import {
  NEVER_SCORED_VIEW_FIELD_UNIVERSAL_IDENTIFIERS,
  NEVER_SCORED_VIEW_FILTER_UNIVERSAL_IDENTIFIER,
  NEVER_SCORED_VIEW_SORT_UNIVERSAL_IDENTIFIER,
  NEVER_SCORED_VIEW_UNIVERSAL_IDENTIFIER,
} from 'src/constants/backfill-identifiers';
import { LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/universal-identifiers';

const PERSON = STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person;

/**
 * Leads nothing has ever looked at.
 *
 * ## Why this is a separate view from "Greenlight Unscored (Failed Open)"
 *
 * The two look similar and mean opposite things.
 *
 *   - `greenlightDecision = UNSCORED` — the engine ran, could not score the lead,
 *     and let it through flagged. That is the fail-open path working, and the
 *     existing view is its error backlog.
 *   - `greenlightDecision` **empty** — no engine has ever seen this record. It
 *     predates the app's installation, so it emitted no create or update event
 *     and no trigger ever fired.
 *
 * Before this view existed the second state had no surface at all. On the dev
 * workspace that produced this change, 1,200 of 1,205 people sat in it while the
 * gate queue was empty — and an empty gate queue is read by everyone, correctly
 * in every other circumstance, as "we checked and there is nothing to review".
 * That is the dangerous direction for a quality gate to fail in: silently
 * reassuring. Folding these records into the fail-open view would have hidden
 * them inside error semantics they do not have; leaving them nowhere is what
 * caused the bug.
 *
 * ## What it is for
 *
 * It is the backfill's progress bar, expressed in the customer's own CRM rather
 * than in a panel of ours. The list drains, live, as the cron works through it,
 * and when it is empty the gate is genuinely covering the workspace. That is a
 * far stronger statement than any number the app could print about itself, and it
 * keeps working if every one of our own surfaces is broken.
 *
 * Sorted oldest first — the opposite of the fail-open view, and for a reason.
 * That view asks "is this happening right now", so it shows the newest. This one
 * is a backlog being worked from one end, and the oldest records are both the
 * ones the backfill reaches first (it walks by `createdAt` ascending) and the ones
 * most likely to be stale enough to matter.
 */
export default defineView({
  universalIdentifier: NEVER_SCORED_VIEW_UNIVERSAL_IDENTIFIER,
  name: 'Greenlight Never Scored',
  objectUniversalIdentifier: PERSON.universalIdentifier,
  type: ViewType.TABLE,
  icon: 'IconEyeOff',
  position: 6,
  filters: [
    {
      universalIdentifier: NEVER_SCORED_VIEW_FILTER_UNIVERSAL_IDENTIFIER,
      fieldMetadataUniversalIdentifier:
        LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS.greenlightDecision,
      // IS_EMPTY, not `IS ['UNSCORED']`. The whole point of the view is the
      // records that carry no value at all.
      operand: ViewFilterOperand.IS_EMPTY,
      value: [],
    },
  ],
  sorts: [
    {
      universalIdentifier: NEVER_SCORED_VIEW_SORT_UNIVERSAL_IDENTIFIER,
      fieldMetadataUniversalIdentifier:
        PERSON.fields.createdAt.universalIdentifier,
      direction: ViewSortDirection.ASC,
    },
  ],
  fields: [
    {
      universalIdentifier: NEVER_SCORED_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.name,
      fieldMetadataUniversalIdentifier: PERSON.fields.name.universalIdentifier,
      position: 0,
      isVisible: true,
      size: 180,
    },
    {
      universalIdentifier:
        NEVER_SCORED_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightDecision,
      fieldMetadataUniversalIdentifier:
        LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS.greenlightDecision,
      // Kept although it is empty on every row by definition: a value appearing
      // here means the filter and the data disagree, which is worth seeing.
      position: 1,
      isVisible: true,
      // A heading gets `size` minus 37px and "Gate decision" measures 85, so
      // this column has to be at least 122. See
      // src/fields/greenlight-decision.field.ts.
      size: 130,
    },
    {
      universalIdentifier: NEVER_SCORED_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.emails,
      fieldMetadataUniversalIdentifier: PERSON.fields.emails.universalIdentifier,
      position: 2,
      isVisible: true,
      size: 180,
    },
    {
      universalIdentifier: NEVER_SCORED_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.company,
      fieldMetadataUniversalIdentifier:
        PERSON.fields.company.universalIdentifier,
      position: 3,
      isVisible: true,
      size: 160,
    },
    {
      universalIdentifier:
        NEVER_SCORED_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.createdAt,
      fieldMetadataUniversalIdentifier:
        PERSON.fields.createdAt.universalIdentifier,
      position: 4,
      isVisible: true,
      size: 140,
    },
  ],
});
