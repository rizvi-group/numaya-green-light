import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { PIPELINE_OPPORTUNITY_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/pipeline-identifiers';

/**
 * The arithmetic behind `greenlightReadiness`: every exit criterion for this
 * opportunity's current stage, whether it is met, and what was looked at to
 * decide.
 *
 * ## This field is what stops readiness being a progress bar
 *
 * PIPELINE_SPEC.md refuses the meter-without-detail outright: "a readiness meter
 * that hides which criterion failed is a progress bar, and a progress bar is not
 * an instruction". The card shows "3 of 4 met — missing: close date", and it can
 * only show that because the per-criterion result is stored rather than
 * summarised away. It is the same principle as `greenlightTrace` on Person, and
 * it is a product commitment rather than a debugging aid: a scoring system that
 * will not show its working cannot be argued with, and a system that cannot be
 * argued with gets ignored rather than corrected.
 *
 * ## Why one JSON document rather than a column per criterion
 *
 * The criteria are **configuration**, not schema. They live in the Greenlight
 * configuration record, seeded with defaults and editable like any other config,
 * so the set of them changes at runtime in a workspace we do not control. A
 * column per criterion would mean a schema migration every time an admin adds
 * one — on Opportunity, an object the customer also owns.
 *
 * Atomicity is the second reason, and it is the same argument
 * `greenlight-enrichment.field.ts` records at length. Each criterion carries its
 * verdict *and* the evidence for it. Split across columns, a crash between the
 * verdict write and the evidence write leaves an unexplained verdict on the
 * record, which is precisely the state this field exists to make impossible.
 * Here the unit of storage is the whole document, written in one mutation.
 *
 * ## Shape
 *
 * ```json
 * {
 *   "version": 1,
 *   "stage": "MEETING",
 *   "evaluatedAt": "2026-08-06T09:12:44.031Z",
 *   "met": 3,
 *   "total": 4,
 *   "criteria": [
 *     {
 *       "key": "amountSet",
 *       "label": "Amount set",
 *       "met": true,
 *       "evidence": "amount = 42,000 EUR",
 *       "cost": 1
 *     },
 *     {
 *       "key": "closeDateSet",
 *       "label": "Close date set",
 *       "met": false,
 *       "evidence": "closeDate is empty",
 *       "cost": 1
 *     }
 *   ]
 * }
 * ```
 *
 * `cost` is what makes the ranking's second tier decidable: PIPELINE_SPEC.md
 * says the *lowest-cost* missing criterion wins, so that "set a close date"
 * beats "book a second meeting". Without a recorded cost the ranking would have
 * to guess, and the guess would change as criteria were reordered in config.
 *
 * `evidence` is prose about data the workspace already holds, never a claim
 * about the outside world. Nothing in this document is sourced from the web, so
 * unlike `greenlightEnrichment` it carries no source URLs — if a criterion ever
 * needs an external fact, that fact belongs in enrichment, with its provenance,
 * and this document cites the enriched value rather than restating it.
 *
 * Read-only: a hand-edited criteria document is a forged evaluation, and the
 * readiness percentage beside it would no longer be arithmetic over anything.
 * Advancing a card whose criteria are unmet is always allowed — that is the
 * fail-open promise — and it is recorded as an override rather than by rewriting
 * the evaluation to say the criteria were met.
 */
export default defineField({
  universalIdentifier:
    PIPELINE_OPPORTUNITY_FIELD_UNIVERSAL_IDENTIFIERS.greenlightCriteria,
  name: 'greenlightCriteria',
  // "Exit criteria", ~61px in the record page's 90px word-clamped label box, and
  // its first word is shared with nothing else on either object. "Stage exit
  // criteria" was the natural phrase and measures well past the budget, so it
  // would have rendered as "Stage exit …" on the record page and worse in a
  // table header. See the label note in greenlight-decision.field.ts.
  label: 'Exit criteria',
  description:
    "Greenlight's per-criterion evaluation of what this opportunity needs before it can leave its current stage: each criterion, whether it is met, and the data that decided it. This is the working behind Readiness — the percentage alone does not say which criterion failed. Criteria are defined in the Greenlight configuration record and can be edited there.",
  type: FieldType.RAW_JSON,
  icon: 'IconChecklist',
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.opportunity.universalIdentifier,
  isUIEditable: false,
  isNullable: true,
});
