import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/universal-identifiers';

/**
 * Why Person?
 * ===========
 *
 * Twenty ships no Lead object. The standard objects are Person, Company and
 * Opportunity, and Greenlight has to pick one to hang the gate off for v0.1.
 *
 *   Person       chosen. It is the record a rep is about to contact, which is
 *                exactly what the gate exists to stop. It already carries the
 *                signals the deterministic rules need — `jobTitle` for the
 *                decision-maker rule, `emails` / `phones` for contactability —
 *                and it relates to Company, so the ICP industry/region/size
 *                checks can be read through the relation without duplicating
 *                fields.
 *
 *   Company      rejected. A company is an input to ICP fit, not the unit of
 *                outreach. Gating a company would gate every contact at it,
 *                including ones a rep already has a live thread with.
 *
 *   Opportunity  rejected. An opportunity only exists after someone has already
 *                qualified the lead, which is downstream of the gate. Scoring it
 *                answers a different question (deal health, not lead quality).
 *
 * How this stays honest with Layer 3 field mapping
 * ------------------------------------------------
 * `defineField` binds a field to an object at *build* time — the SDK has no way
 * to attach a field to an object chosen at runtime from a config record. So the
 * mapping cannot move these three fields; what it maps is which *source* fields
 * on the lead object the rules read (`decisionMakerFieldName`,
 * `readyForOutreachFieldName`, `optOutFieldNames`) and, in
 * `GreenlightConfig.leadObjectNameSingular`, which object the workspace
 * considers the lead. v0.1 ships the score fields on Person only; the config
 * value is what a later release switches on once Company / Opportunity get their
 * own copies of these three fields. Nothing downstream should hardcode "person"
 * — read it from the config record.
 */
export default defineField({
  universalIdentifier: LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS.greenlightScore,
  name: 'greenlightScore',
  // "Lead score", not "Greenlight score". The record page renders a field label
  // into a hard 90px box and drops whole words that do not fit; "Greenlight"
  // alone is 58px of that budget, so every label beginning with it rendered as
  // "Greenlight …" and four fields were indistinguishable. See the label note in
  // greenlight-decision.field.ts for the full reasoning and the measurements.
  label: 'Lead score',
  description:
    "Greenlight's deterministic lead quality score, 0 to 100, recomputed on every create and update. Empty means the lead has not been scored yet, or the run failed open.",
  type: FieldType.NUMBER,
  icon: 'IconGauge',
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
  // Read-only from the UI: the engine owns this value, and a hand-edited score
  // that the next event overwrites is worse than no score at all. Humans change
  // the outcome by releasing a gated lead, which is logged.
  isUIEditable: false,
  isNullable: true,
});
