import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { PIPELINE_OPPORTUNITY_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/pipeline-identifiers';

/**
 * How much of the current stage's exit criteria this deal has met, 0 to 100.
 *
 * ## Why Opportunity, when everything else Greenlight owns is on Person
 *
 * `greenlight-score.field.ts` records why the gate hangs off Person, and one of
 * the three rejected candidates was Opportunity, on the grounds that "an
 * opportunity only exists after someone has already qualified the lead, which is
 * downstream of the gate. Scoring it answers a different question (deal health,
 * not lead quality)."
 *
 * That reasoning stands and this field is the different question. Readiness is
 * not a second lead score and must never be read as one: the lead score asks
 * *should we spend time on this person*, readiness asks *what is left before
 * this deal can move to the next stage*. They are computed from disjoint inputs
 * — the score from ICP fit and contactability, readiness from Twenty's own
 * `amount`, `closeDate`, Tasks, Notes and relations — and a deal can sit at 100
 * readiness with a mediocre score, or the reverse, without either being wrong.
 *
 * ## A percentage, and the percentage is not the product
 *
 * PIPELINE_SPEC.md is explicit that "a readiness meter that hides which
 * criterion failed is a progress bar, and a progress bar is not an instruction".
 * This column exists so a view can sort and filter on it — neither is possible
 * against a key inside `greenlightCriteria`'s JSON, which is the same argument
 * that gave `greenlightEnrichedAt` its own column. The card never shows this
 * number alone; it shows "3 of 4 met — missing: close date", and the arithmetic
 * behind that sentence is in `greenlightCriteria`.
 *
 * A percentage rather than the raw met/total pair because a pair cannot be
 * sorted. Two of three and four of six are the same readiness and a rep working
 * a sorted board wants them adjacent.
 *
 * ## Stored, not derived on render
 *
 * Every other Greenlight number is recomputed on every event. This one is cached
 * deliberately: the board is one logic-function call for a whole workspace, and
 * PIPELINE_SPEC.md's performance section is blunt about why — a workspace with
 * 1,205 people cannot issue 1,205 REST reads to paint a screen against a limit
 * of 100 requests a minute. The criteria predicates read Tasks, Notes and
 * relations, so evaluating them per card per render is precisely the shape that
 * limit forbids. `greenlightAdvisedAt` is how a reader tells whether this number
 * is stale.
 *
 * Read-only from the UI, like the score. A hand-typed readiness is a claim about
 * criteria that were not checked, and the next recompute overwrites it silently.
 * A rep who disagrees does not edit the number — they drag the card, which is
 * always allowed and always recorded.
 */
export default defineField({
  universalIdentifier:
    PIPELINE_OPPORTUNITY_FIELD_UNIVERSAL_IDENTIFIERS.greenlightReadiness,
  name: 'greenlightReadiness',
  // "Readiness", not "Greenlight readiness" and not "Stage readiness". The
  // record page renders a field label into a hard 90px box at 11.96px Inter and
  // drops whole trailing words that do not fit — see the label note in
  // greenlight-decision.field.ts for the measurements. "Greenlight" alone spends
  // 58px of that budget; "Stage readiness" measures ~88px, which clears the box
  // by two pixels and would not survive a font fallback or the tighter table
  // header budget of `size` minus 37px. "Readiness" is ~53px, fits both
  // surfaces, and its first word already separates it from every other label on
  // the Opportunity record page.
  label: 'Readiness',
  description:
    "Percentage of the current stage's exit criteria this opportunity has met, as computed by Greenlight. See Exit criteria for which individual criteria are met and which are not — this number on its own does not say what is missing. Recomputed on write and on explicit refresh, never on render.",
  type: FieldType.NUMBER,
  icon: 'IconProgressCheck',
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.opportunity.universalIdentifier,
  isUIEditable: false,
  isNullable: true,
});
