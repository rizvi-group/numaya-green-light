import {
  defineView,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
  ViewFilterOperand,
  ViewSortDirection,
  ViewType,
} from 'twenty-sdk/define';

import {
  GATE_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS,
  GATE_QUEUE_VIEW_FILTER_UNIVERSAL_IDENTIFIER,
  GATE_QUEUE_VIEW_SORT_UNIVERSAL_IDENTIFIER,
  GATE_QUEUE_VIEW_UNIVERSAL_IDENTIFIER,
} from 'src/constants/gate-queue-identifiers';
import { LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/universal-identifiers';

const PERSON = STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person;

/**
 * The gate queue: leads the gate is holding for a human to judge.
 *
 * ## Which decision states belong here
 *
 * The engine emits four (`src/scoring/types.ts`): `approved`, `gated`,
 * `blocked`, `unscored`. They are three different jobs for three different
 * people, so they do not belong in one list:
 *
 *   - `gated` — **this queue.** A judgement call for a rep: the lead scored
 *     below the threshold, and a human decides whether the rules were right
 *     about this particular person. This is the only state where the answer is
 *     genuinely "it depends", and the only one where the Art. 22 override is the
 *     point.
 *
 *   - `unscored` — **its own view** (`greenlight-unscored.view.ts`). Not a
 *     judgement call at all: the engine failed open, the lead already went
 *     through to the rep, and what is needed is an admin fixing whatever broke.
 *     Mixing it in here would tell a rep to make a decision about a lead that is
 *     not being held, and would bury an outage inside a work list.
 *
 *   - `approved` — no queue. Nothing to do.
 *
 *   - `blocked` — **its own view** (`greenlight-compliance-blocked.view.ts`).
 *     Not a judgement call either: the contact has opted out, the override
 *     refuses to release them by hand, and the route out is correcting the
 *     underlying data. `greenlightDecision` now carries a `BLOCKED` option of
 *     its own, so the `IS GATE` filter below excludes them without needing to
 *     read the trace. Note what this does *not* change: a lead scored before
 *     that option existed still reads `GATE` and so still appears here. It is
 *     still unreleasable — the override falls back to parsing
 *     `greenlightTrace` for exactly this case — and it moves out of this queue
 *     the next time it is re-scored.
 *
 * ## Why these columns and this sort
 *
 * A rep should be able to see why a lead is held without opening it. The honest
 * position is that they can *infer* it here rather than read it: `greenlightScore`
 * says how far below the threshold the lead landed, and the three columns after
 * it are the inputs the rules actually weigh — an empty `jobTitle` is the
 * decision-maker rule failing, an empty `company` is the ICP rules failing, an
 * empty `emails` is contactability failing. There is no field on Person carrying
 * the engine's one-line summary; `greenlightTrace` is RAW_JSON and unreadable at
 * column width.
 *
 * Sorted by score, highest first. A held lead scoring 39 against a threshold of
 * 40 is the one most likely to be a rules problem rather than a bad lead, so it
 * is where a reviewer's attention is worth most. Oldest-first would be fairer to
 * the leads and worse for the reviewer.
 */
export default defineView({
  universalIdentifier: GATE_QUEUE_VIEW_UNIVERSAL_IDENTIFIER,
  name: 'Greenlight Gate Queue',
  objectUniversalIdentifier: PERSON.universalIdentifier,
  type: ViewType.TABLE,
  icon: 'IconGavel',
  position: 2,
  filters: [
    {
      universalIdentifier: GATE_QUEUE_VIEW_FILTER_UNIVERSAL_IDENTIFIER,
      fieldMetadataUniversalIdentifier:
        LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS.greenlightDecision,
      operand: ViewFilterOperand.IS,
      value: ['GATE'],
    },
  ],
  sorts: [
    {
      universalIdentifier: GATE_QUEUE_VIEW_SORT_UNIVERSAL_IDENTIFIER,
      fieldMetadataUniversalIdentifier:
        LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS.greenlightScore,
      direction: ViewSortDirection.DESC,
    },
  ],
  fields: [
    {
      universalIdentifier: GATE_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.name,
      fieldMetadataUniversalIdentifier: PERSON.fields.name.universalIdentifier,
      position: 0,
      isVisible: true,
      size: 180,
    },
    {
      universalIdentifier:
        GATE_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightScore,
      fieldMetadataUniversalIdentifier:
        LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS.greenlightScore,
      position: 1,
      isVisible: true,
      // A column heading gets `size` minus 37px — 28 for the icon and its gutter,
      // 9 for the right margin. That was measured on the instance after 110 was
      // tried and "Gate decision" still ellipsised at 83px of usable width. So
      // "Lead score" at 69px needs 106 to render at all and 120 to render with a
      // margin worth having on a machine whose font stack is not Inter. See the
      // label note in src/fields/greenlight-decision.field.ts.
      size: 120,
    },
    {
      universalIdentifier:
        GATE_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.greenlightDecision,
      fieldMetadataUniversalIdentifier:
        LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS.greenlightDecision,
      position: 2,
      isVisible: true,
      // "Gate decision" measures 85px, so this column has to be at least 122.
      size: 130,
    },
    {
      universalIdentifier: GATE_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.jobTitle,
      fieldMetadataUniversalIdentifier:
        PERSON.fields.jobTitle.universalIdentifier,
      position: 3,
      isVisible: true,
      size: 180,
    },
    {
      universalIdentifier: GATE_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.company,
      fieldMetadataUniversalIdentifier: PERSON.fields.company.universalIdentifier,
      position: 4,
      isVisible: true,
      size: 160,
    },
    {
      universalIdentifier: GATE_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.emails,
      fieldMetadataUniversalIdentifier: PERSON.fields.emails.universalIdentifier,
      position: 5,
      isVisible: true,
      size: 200,
    },
    {
      universalIdentifier: GATE_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.createdAt,
      fieldMetadataUniversalIdentifier:
        PERSON.fields.createdAt.universalIdentifier,
      position: 6,
      isVisible: true,
      size: 140,
    },
  ],
});
