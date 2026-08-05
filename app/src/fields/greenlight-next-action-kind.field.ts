import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { NEXT_ACTION_KIND_OPTIONS } from 'src/constants/next-action-kind-options';
import { PIPELINE_OPPORTUNITY_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/pipeline-identifiers';

/**
 * The machine-readable half of the next action: which *move* the ranking chose,
 * as opposed to `greenlightNextAction`, which is the sentence about it.
 *
 * Two fields rather than one because they are read by different consumers. A rep
 * reads the sentence. A view filter, a kanban grouping and the card's button all
 * need a stable token, and none of them can be built on prose an LLM may have
 * rephrased. "Show me every deal blocked on compliance" is a filter on this
 * field; it is not expressible against a TEXT column at all.
 *
 * ## The options name the move, not the category
 *
 * This list was briefly six *tiers* — `MISSING_CRITERION`, `SCORE_BAND` — one per
 * category in PIPELINE_SPEC.md § "How the action is chosen". It is now fourteen
 * *actions*, generated from `ACTION_KINDS`, the same list the ranking in
 * `src/pipeline/next-action.ts` emits. Both were written at the same time by
 * people who each correctly decided the vocabulary must be declared once, and
 * who each declared it somewhere different; `src/constants/pipeline-identifiers.ts`
 * records the reconciliation and why the ranking's list won.
 *
 * The short version: `MISSING_CRITERION` tells a rep an obstacle exists,
 * `SET_THE_CLOSE_DATE` tells them what it is. The tier is always recoverable
 * from the action, and the action is never recoverable from the tier — so
 * storing the tier throws away the half people filter and group by. It is also
 * what the card's button is keyed on, and a button cannot be built from a
 * category.
 *
 * The cost is column count: a kanban grouped by this field has fourteen columns,
 * not six. That is a grouping a user chooses, and the board's own default
 * grouping is the lane, so the cost falls only where somebody asked for it.
 *
 * `position` is display order — the order these appear in a dropdown, a filter
 * list, and as kanban column order. It follows the ranking, so a board grouped
 * by action type reads left-to-right as "most in the way" to "nothing in the
 * way", the same escalation ordering `greenlightDecision` uses. Alphabetical
 * order would open with `ADVANCE_THE_CARD` and bury `CLEAR_THE_BLOCK` in the
 * middle, which is a worse answer to the only question a rep is asking.
 *
 * Generated from the array rather than hand-listed so the two cannot drift: a
 * kind added to the ranking without a label here is a type error, which is the
 * whole point of deriving it.
 *
 * ## On adding an option to this list later
 *
 * The three properties recorded against `greenlightDecision` when `BLOCKED` was
 * added to a deployed field apply here unchanged, and they are why this list can
 * grow safely:
 *
 *   - **An option's identity is its `value`.** `FieldMetadataComplexOption`
 *     carries an optional `id` which this app has never set; the build derives
 *     one deterministically from the value instead. That was verified rather
 *     than assumed on `greenlightDecision` — inserting an option at position 1
 *     produced byte-identical ids for every existing option — so the id is a
 *     function of the value and not of the order. Records already holding
 *     `STALE` are untouched by an append, and would be untouched by an insert.
 *   - **`position` is therefore display order only.** Renumbering moves a column
 *     on somebody's board; it does not touch stored data.
 *   - **Nothing backfills.** A card advised before a new option existed keeps
 *     whichever value the ranking collapsed onto at the time, until the next
 *     recompute. `greenlightAdvisedAt` is how you tell which those are.
 *
 * The one rule that is not safe to break: never change a `value` string. Do that
 * and every record holding the old one becomes unreadable to the filter, the
 * kanban grouping and the button, all silently. `ACTION_KINDS` in
 * `src/pipeline/types.ts` is the single declaration this field and the ranking
 * both read, so a divergence is a type error rather than a live-workspace
 * mystery.
 *
 * Labels and colours live in `src/constants/next-action-kind-options.ts`, which
 * explains why fourteen labels collapse onto six colours.
 */
export default defineField({
  universalIdentifier:
    PIPELINE_OPPORTUNITY_FIELD_UNIVERSAL_IDENTIFIERS.greenlightNextActionKind,
  name: 'greenlightNextActionKind',
  // "Action type", not "Next action kind" and not "Greenlight action". The
  // record page clamps a label to a 90px box on a **word** boundary, so a label
  // that overflows loses whole trailing words — which is how four Person fields
  // once rendered as the identical string "Greenlight …". See the label note in
  // greenlight-decision.field.ts.
  //
  // The first word is deliberately "Action" and not "Next": this field sits
  // directly beside "Next action" on the same record page, and two labels
  // sharing a first word are indistinguishable the moment either overflows.
  // Both measure ~62px and neither overflows today, but the pair would have been
  // one long label away from repeating the original bug.
  //
  // "type" rather than the field name's "kind" because "kind" is programmer
  // vocabulary; a rep filtering a board reads "type".
  label: 'Action type',
  description:
    "The move Greenlight is recommending on this opportunity, as a value a view can filter, group or sort on. Ordered by priority: clearing a compliance block outranks an unmet stage criterion, which outranks a gap enrichment could fill, which outranks chasing a stalled card, which outranks strengthening a weak score. Ready to advance means every exit criterion for the current stage is met; Nothing to do means Greenlight looked and found nothing worth saying; empty means it has never looked.",
  type: FieldType.SELECT,
  icon: 'IconCategory',
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.opportunity.universalIdentifier,
  options: NEXT_ACTION_KIND_OPTIONS,
  // Read-only, unlike `greenlightDecision`. Flipping a gate decision by hand is
  // the documented human override path and the engine writes an audit row for
  // it; there is no equivalent here, because overriding the advice is not a data
  // edit — it is advancing the card anyway, which the board always permits and
  // always records.
  isUIEditable: false,
  isNullable: true,
});
