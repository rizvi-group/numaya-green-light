import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/universal-identifiers';

/**
 * Last-run trace, pinned to the lead so "why did this score 32?" is answerable
 * from the record page without leaving it for the audit log.
 *
 * RAW_JSON, not TEXT: the trace is the same rule-by-rule array the audit row
 * stores, and it is consumed by the front component that renders the explanation
 * panel. Serialising it to a string would mean parsing it back everywhere.
 * Nothing here is user-editable, so the usual "prefer a typed field a human will
 * edit" rule does not apply.
 *
 * This duplicates the newest GreenlightAuditLog row on purpose. The audit log is
 * append-only history and gets long; this is a single denormalised cache of the
 * current state, so the record page needs one read instead of a filtered query.
 */
export default defineField({
  universalIdentifier: LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS.greenlightTrace,
  name: 'greenlightTrace',
  // "Score trace" pairs it with "Lead score" and fits the 90px record-page label
  // box; "Greenlight trace" did not. See greenlight-decision.field.ts.
  label: 'Score trace',
  description:
    "Greenlight's rule-by-rule explanation of the most recent score, plus the trace id of that run. Shape matches GreenlightAuditLog.ruleTrace. Written by the engine.",
  type: FieldType.RAW_JSON,
  icon: 'IconListDetails',
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
  isUIEditable: false,
  isNullable: true,
});
