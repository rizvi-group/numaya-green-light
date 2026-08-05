import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { NEXT_ACTION_KIND_OPTIONS } from 'src/constants/next-action-kind-options';
import { PIPELINE_PERSON_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/pipeline-identifiers';

/**
 * The Person half of `greenlightNextActionKind`. See
 * `greenlight-next-action-kind.field.ts` for the option list's ordering
 * argument, the rules for appending to it safely, and the colour scheme.
 *
 * ## The same fourteen options, deliberately, including those a lead cannot reach
 *
 * A Person in one of the four Greenlight-owned lanes has no stage, so the
 * stage-criterion moves — `SET_THE_AMOUNT`, `SET_THE_CLOSE_DATE`,
 * `LOG_THE_NOTE`, `ASSIGN_AN_OWNER`, `ADVANCE_THE_CARD` — will never be written
 * here; exit criteria are a property of an Opportunity. `STRENGTHEN_THE_RECORD`
 * is the reverse case, far more common on a lead than on a deal.
 *
 * The unreachable options stay in the list anyway, and that is a considered
 * choice rather than a copy-paste. The two fields share one vocabulary, exactly
 * as `greenlightDecision` on Person shares its vocabulary with
 * `GreenlightAuditLog.decision`: a workspace can filter either object on the
 * same value without a join, the board's card component keys its button off one
 * set of tokens rather than two, and `ACTION_KINDS` stays a single declaration.
 * Pruning the list to what is reachable today would save nothing and would
 * guarantee a schema change the first time a lead-side criterion is introduced.
 *
 * `position` is display order, so an unreachable option costs one row in a
 * dropdown and nothing else.
 */
export default defineField({
  universalIdentifier:
    PIPELINE_PERSON_FIELD_UNIVERSAL_IDENTIFIERS.greenlightNextActionKind,
  name: 'greenlightNextActionKind',
  // Same label as the Opportunity copy, for the same reason its sentence field
  // is: one concept, never on the same record page, and a second string would
  // read as a second concept. ~62px in the 90px word-clamped box, first word
  // distinct from "Next action" beside it — see the label note in
  // greenlight-decision.field.ts.
  label: 'Action type',
  description:
    "The move Greenlight is recommending on this lead, as a value a view can filter, group or sort on. Ordered by priority: clearing a compliance block outranks a gap enrichment could fill, which outranks strengthening a weak score. Nothing to do means Greenlight looked and found nothing worth saying; empty means it has never looked. Options that name a deal stage are never written to a lead.",
  type: FieldType.SELECT,
  icon: 'IconCategory',
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
  options: NEXT_ACTION_KIND_OPTIONS,
  isUIEditable: false,
  isNullable: true,
});
