import {
  defineView,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
  ViewFilterOperand,
  ViewSortDirection,
  ViewType,
} from 'twenty-sdk/define';

import {
  UNSCORED_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS,
  UNSCORED_QUEUE_VIEW_FILTER_UNIVERSAL_IDENTIFIER,
  UNSCORED_QUEUE_VIEW_SORT_UNIVERSAL_IDENTIFIER,
  UNSCORED_QUEUE_VIEW_UNIVERSAL_IDENTIFIER,
} from 'src/constants/gate-queue-identifiers';
import { LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/universal-identifiers';

const PERSON = STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person;

/**
 * Leads that went through unscored because Greenlight failed open.
 *
 * This is not a review queue and no override belongs on it. `unscored` means
 * the engine could not produce a score and let the lead through flagged rather
 * than holding it — the ARCHITECTURE.md golden rule in action. The lead is
 * already with the rep. Nobody has a decision to make about it.
 *
 * What it is instead is an **operational alarm with a backlog attached**, and it
 * is separate from the gate queue for exactly that reason: it is an admin's
 * problem, not a rep's. A steady trickle here means one malformed lead now and
 * then; a spike means the config record is broken, or the engine is throwing,
 * and every lead is currently bypassing the gate entirely. That is a far more
 * serious condition than a full gate queue, and burying it inside one would
 * hide it.
 *
 * Sorted newest first, because the question this view answers is "is this
 * happening right now", not "what is the oldest one". `updatedAt` is on the
 * table so an admin can tell a lead that failed open once from one that is
 * being re-scored and failing repeatedly.
 *
 * The score column is kept even though it is empty by definition: a non-empty
 * score next to an `UNSCORED` decision means the engine wrote the two fields
 * inconsistently, which is worth seeing immediately.
 */
export default defineView({
  universalIdentifier: UNSCORED_QUEUE_VIEW_UNIVERSAL_IDENTIFIER,
  name: 'Greenlight Unscored (Failed Open)',
  objectUniversalIdentifier: PERSON.universalIdentifier,
  type: ViewType.TABLE,
  icon: 'IconAlertTriangle',
  position: 3,
  filters: [
    {
      universalIdentifier: UNSCORED_QUEUE_VIEW_FILTER_UNIVERSAL_IDENTIFIER,
      fieldMetadataUniversalIdentifier:
        LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS.greenlightDecision,
      operand: ViewFilterOperand.IS,
      value: ['UNSCORED'],
    },
  ],
  sorts: [
    {
      universalIdentifier: UNSCORED_QUEUE_VIEW_SORT_UNIVERSAL_IDENTIFIER,
      fieldMetadataUniversalIdentifier:
        PERSON.fields.createdAt.universalIdentifier,
      direction: ViewSortDirection.DESC,
    },
  ],
  fields: [
    {
      universalIdentifier: UNSCORED_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.name,
      fieldMetadataUniversalIdentifier: PERSON.fields.name.universalIdentifier,
      position: 0,
      isVisible: true,
      size: 180,
    },
    {
      universalIdentifier:
        UNSCORED_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightDecision,
      fieldMetadataUniversalIdentifier:
        LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS.greenlightDecision,
      position: 1,
      isVisible: true,
      size: 110,
    },
    {
      universalIdentifier:
        UNSCORED_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightScore,
      fieldMetadataUniversalIdentifier:
        LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS.greenlightScore,
      position: 2,
      isVisible: true,
      size: 100,
    },
    {
      universalIdentifier: UNSCORED_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.company,
      fieldMetadataUniversalIdentifier: PERSON.fields.company.universalIdentifier,
      position: 3,
      isVisible: true,
      size: 160,
    },
    {
      universalIdentifier:
        UNSCORED_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.createdAt,
      fieldMetadataUniversalIdentifier:
        PERSON.fields.createdAt.universalIdentifier,
      position: 4,
      isVisible: true,
      size: 140,
    },
    {
      universalIdentifier:
        UNSCORED_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.updatedAt,
      fieldMetadataUniversalIdentifier:
        PERSON.fields.updatedAt.universalIdentifier,
      position: 5,
      isVisible: true,
      size: 140,
    },
  ],
});
