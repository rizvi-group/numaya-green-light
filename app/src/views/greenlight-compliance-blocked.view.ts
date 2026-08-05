import {
  defineView,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
  ViewFilterOperand,
  ViewSortDirection,
  ViewType,
} from 'twenty-sdk/define';

import {
  BLOCKED_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS,
  BLOCKED_QUEUE_VIEW_FILTER_UNIVERSAL_IDENTIFIER,
  BLOCKED_QUEUE_VIEW_SORT_UNIVERSAL_IDENTIFIER,
  BLOCKED_QUEUE_VIEW_UNIVERSAL_IDENTIFIER,
} from 'src/constants/gate-queue-identifiers';
import {
  LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS,
  LEAD_SUPPRESSION_FIELD_UNIVERSAL_IDENTIFIERS,
} from 'src/constants/universal-identifiers';

const PERSON = STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person;

/**
 * Leads stopped on compliance grounds — in v0.1, a recorded opt-out.
 *
 * Separate from the gate queue because the two ask different questions of
 * different people. The gate queue asks a rep "were the rules right about this
 * person?" and the answer can be no. This list asks nothing: the contact told us
 * to stop, the override refuses to release them by hand
 * (`ALLOW_COMPLIANCE_OVERRIDE` in `src/gate/release-decision.ts`), and the only
 * route out is correcting the opt-out data on the record so the lead re-scores
 * and clears itself through evidence.
 *
 * Until `greenlightDecision` carried a `BLOCKED` option these leads sat in the
 * gate queue reading `GATE`, indistinguishable from a low score until somebody
 * clicked Release and got a refusal. That is a bad way to learn that a contact
 * has opted out, and it made the gate queue's count untrustworthy as a measure
 * of how much judgement work is outstanding.
 *
 * What the list is *for*, then, is oversight rather than work: how many contacts
 * are we correctly refusing to call, and is that number moving. `emails` is on
 * the table because an opted-out address showing up in an export or a sequence
 * is the incident this view exists to make findable. Sorted by `updatedAt`,
 * newest first: a lead that has just become blocked is the one worth looking at,
 * either because the opt-out is new or because somebody has just mis-edited the
 * record.
 *
 * The score column stays visible on purpose. A blocked lead is still scored, and
 * a high score next to a compliance stop is the case most likely to tempt
 * someone into trying to release it — better that they see the whole picture
 * here than discover the refusal in a snackbar.
 *
 * ## Reason and date, added
 *
 * The view originally said only *that* a lead was blocked. That was enough while
 * "blocked" had exactly one cause, but it left the list unable to answer the
 * questions actually asked of it: are these mostly spam complaints or mostly
 * bounces, and did any of them arrive after Tuesday's send. Two suppression
 * columns are now in position 2 and 3, ahead of company and email, because the
 * reason is the point of the row and burying it behind lead-quality columns
 * reproduces the original problem one column to the right.
 *
 * They are empty for a lead blocked through the *customer's* own opt-out
 * mapping rather than Greenlight's register, and that gap is informative rather
 * than a defect: a BLOCKED row with no Greenlight reason is a block that came
 * from the workspace's own data, which is a different provenance and a different
 * place to go and look.
 */
export default defineView({
  universalIdentifier: BLOCKED_QUEUE_VIEW_UNIVERSAL_IDENTIFIER,
  name: 'Greenlight Compliance Blocked',
  objectUniversalIdentifier: PERSON.universalIdentifier,
  type: ViewType.TABLE,
  icon: 'IconBan',
  position: 4,
  filters: [
    {
      universalIdentifier: BLOCKED_QUEUE_VIEW_FILTER_UNIVERSAL_IDENTIFIER,
      fieldMetadataUniversalIdentifier:
        LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS.greenlightDecision,
      operand: ViewFilterOperand.IS,
      value: ['BLOCKED'],
    },
  ],
  sorts: [
    {
      universalIdentifier: BLOCKED_QUEUE_VIEW_SORT_UNIVERSAL_IDENTIFIER,
      fieldMetadataUniversalIdentifier:
        PERSON.fields.updatedAt.universalIdentifier,
      direction: ViewSortDirection.DESC,
    },
  ],
  fields: [
    {
      universalIdentifier: BLOCKED_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.name,
      fieldMetadataUniversalIdentifier: PERSON.fields.name.universalIdentifier,
      position: 0,
      isVisible: true,
      size: 180,
    },
    {
      universalIdentifier:
        BLOCKED_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightDecision,
      fieldMetadataUniversalIdentifier:
        LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS.greenlightDecision,
      position: 1,
      isVisible: true,
      // A heading gets `size` minus 37px and "Gate decision" measures 85, so
      // this column has to be at least 122. See
      // src/fields/greenlight-decision.field.ts.
      size: 130,
    },
    {
      universalIdentifier:
        BLOCKED_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightSuppressionReason,
      fieldMetadataUniversalIdentifier:
        LEAD_SUPPRESSION_FIELD_UNIVERSAL_IDENTIFIERS.greenlightSuppressionReason,
      position: 2,
      isVisible: true,
      size: 180,
    },
    {
      universalIdentifier:
        BLOCKED_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightSuppressedAt,
      fieldMetadataUniversalIdentifier:
        LEAD_SUPPRESSION_FIELD_UNIVERSAL_IDENTIFIERS.greenlightSuppressedAt,
      position: 3,
      isVisible: true,
      size: 150,
    },
    {
      universalIdentifier:
        BLOCKED_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightScore,
      fieldMetadataUniversalIdentifier:
        LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS.greenlightScore,
      position: 4,
      isVisible: true,
      size: 120,
    },
    {
      universalIdentifier:
        BLOCKED_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.company,
      fieldMetadataUniversalIdentifier: PERSON.fields.company.universalIdentifier,
      position: 5,
      isVisible: true,
      size: 160,
    },
    {
      universalIdentifier: BLOCKED_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.emails,
      fieldMetadataUniversalIdentifier: PERSON.fields.emails.universalIdentifier,
      position: 6,
      isVisible: true,
      size: 200,
    },
    {
      universalIdentifier:
        BLOCKED_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.updatedAt,
      fieldMetadataUniversalIdentifier:
        PERSON.fields.updatedAt.universalIdentifier,
      position: 7,
      isVisible: true,
      size: 140,
    },
  ],
});
