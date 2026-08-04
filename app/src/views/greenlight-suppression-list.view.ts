import {
  defineView,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
  ViewFilterOperand,
  ViewSortDirection,
  ViewType,
} from 'twenty-sdk/define';

import {
  SUPPRESSION_LIST_VIEW_FIELD_UNIVERSAL_IDENTIFIERS,
  SUPPRESSION_LIST_VIEW_FILTER_UNIVERSAL_IDENTIFIER,
  SUPPRESSION_LIST_VIEW_SORT_UNIVERSAL_IDENTIFIER,
  SUPPRESSION_LIST_VIEW_UNIVERSAL_IDENTIFIER,
} from 'src/constants/gate-queue-identifiers';
import {
  LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS,
  LEAD_SUPPRESSION_FIELD_UNIVERSAL_IDENTIFIERS,
} from 'src/constants/universal-identifiers';

const PERSON = STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person;

/**
 * The block list: everyone Greenlight is refusing to contact, and why.
 *
 * ## Why this is not the compliance-blocked view
 *
 * They look similar and answer different questions.
 *
 *   - **Compliance blocked** filters on `greenlightDecision = BLOCKED`, which is
 *     the *engine's* current verdict. It is a queue about scoring: these are
 *     leads the gate is holding right now, on this run, with these rules.
 *   - **This list** filters on `greenlightSuppressed`, which is *data a human
 *     put there*. It is a register, not a queue. It survives the rule being
 *     switched off, the weight being changed, and the lead never having been
 *     scored at all.
 *
 * The two lists agree almost all the time, and the interesting cases are the
 * ones where they do not. A person on this list but absent from the blocked view
 * means the compliance rule is disabled or the lead has not been re-scored since
 * being blocked — which is exactly the misconfiguration this list makes visible
 * and the other one cannot. Merging them into one view would hide it.
 *
 * "Show me our do-not-contact list" is also a question with an owner outside
 * sales. A DPO, an auditor or whoever signs off a campaign send needs a list
 * they can read without knowing what a gate threshold is, and they should not
 * have to trust that a scoring engine ran in order to get it.
 *
 * ## The filter
 *
 * `greenlightSuppressed IS true` only. A record with a reason but a cleared flag
 * is still treated as suppressed by the scoring rule, and it deliberately does
 * *not* appear here: this view is the register as the workspace has actually
 * recorded it, and a row that scores as blocked but is missing from the block
 * list is a data-integrity problem somebody should see rather than something a
 * clever filter should paper over. The compliance-blocked view catches it.
 *
 * ## The columns
 *
 * Reason and date lead, ahead of everything about lead quality. This list is
 * read to answer "why is this person off-limits and since when", never "is this
 * a good lead" — a score column here would invite exactly the wrong instinct.
 * `emails` is present for the same reason it is on the blocked view: a
 * suppressed address turning up in an export or a sequence is the incident these
 * views exist to make findable, and you cannot grep a name against a mail log.
 *
 * Sorted by suppression date, newest first: a block recorded in the last hour is
 * the one worth looking at, either because a send has just gone wrong or because
 * somebody has just mis-edited a record.
 */
export default defineView({
  universalIdentifier: SUPPRESSION_LIST_VIEW_UNIVERSAL_IDENTIFIER,
  name: 'Greenlight Do Not Contact',
  objectUniversalIdentifier: PERSON.universalIdentifier,
  type: ViewType.TABLE,
  icon: 'IconHandStop',
  position: 5,
  filters: [
    {
      universalIdentifier: SUPPRESSION_LIST_VIEW_FILTER_UNIVERSAL_IDENTIFIER,
      fieldMetadataUniversalIdentifier:
        LEAD_SUPPRESSION_FIELD_UNIVERSAL_IDENTIFIERS.greenlightSuppressed,
      operand: ViewFilterOperand.IS,
      value: true,
    },
  ],
  sorts: [
    {
      universalIdentifier: SUPPRESSION_LIST_VIEW_SORT_UNIVERSAL_IDENTIFIER,
      fieldMetadataUniversalIdentifier:
        LEAD_SUPPRESSION_FIELD_UNIVERSAL_IDENTIFIERS.greenlightSuppressedAt,
      direction: ViewSortDirection.DESC,
    },
  ],
  fields: [
    {
      universalIdentifier: SUPPRESSION_LIST_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.name,
      fieldMetadataUniversalIdentifier: PERSON.fields.name.universalIdentifier,
      position: 0,
      isVisible: true,
      size: 180,
    },
    {
      universalIdentifier:
        SUPPRESSION_LIST_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightSuppressionReason,
      fieldMetadataUniversalIdentifier:
        LEAD_SUPPRESSION_FIELD_UNIVERSAL_IDENTIFIERS.greenlightSuppressionReason,
      position: 1,
      isVisible: true,
      size: 180,
    },
    {
      universalIdentifier:
        SUPPRESSION_LIST_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightSuppressedAt,
      fieldMetadataUniversalIdentifier:
        LEAD_SUPPRESSION_FIELD_UNIVERSAL_IDENTIFIERS.greenlightSuppressedAt,
      position: 2,
      isVisible: true,
      size: 150,
    },
    {
      universalIdentifier: SUPPRESSION_LIST_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.emails,
      fieldMetadataUniversalIdentifier: PERSON.fields.emails.universalIdentifier,
      position: 3,
      isVisible: true,
      size: 200,
    },
    {
      universalIdentifier:
        SUPPRESSION_LIST_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightSuppressionNote,
      fieldMetadataUniversalIdentifier:
        LEAD_SUPPRESSION_FIELD_UNIVERSAL_IDENTIFIERS.greenlightSuppressionNote,
      position: 4,
      isVisible: true,
      size: 240,
    },
    {
      universalIdentifier: SUPPRESSION_LIST_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.company,
      fieldMetadataUniversalIdentifier: PERSON.fields.company.universalIdentifier,
      position: 5,
      isVisible: true,
      size: 160,
    },
    {
      universalIdentifier:
        SUPPRESSION_LIST_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightDecision,
      fieldMetadataUniversalIdentifier:
        LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS.greenlightDecision,
      position: 6,
      isVisible: true,
      size: 110,
    },
  ],
});
