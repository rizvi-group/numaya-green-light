import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/universal-identifiers';

/**
 * The gate flag itself. See greenlight-score.field.ts for why these fields live
 * on Person.
 *
 * The option values are duplicated on GreenlightAuditLog.decision on purpose:
 * this field is the *current* state of the lead, the audit row is the immutable
 * history. Keeping them as two SELECTs with the same vocabulary means a workspace
 * can filter a view on either without a join.
 *
 * ## On adding an option to a deployed field
 *
 * `BLOCKED` was added after the first three. Three properties of the SDK make
 * that safe, and all three are worth knowing before touching this list again:
 *
 *   - An option's identity is its `value`. `FieldMetadataComplexOption` carries
 *     an optional `id`, which this app has never set (nor does the SDK's own
 *     documented example); `dev:build` derives one deterministically instead.
 *     Verified rather than assumed: building this field with `BLOCKED` inserted
 *     at position 1 produced byte-identical ids for all four options, so the id
 *     is a function of the value and not of the order. Records already holding
 *     `PASS` / `GATE` / `UNSCORED` are untouched by an append, and would have
 *     been untouched by an insert too.
 *   - `position` is therefore display order only — the order options appear in a
 *     dropdown, a filter list and a kanban board. Appending at the end still
 *     leaves the existing three exactly where the user already reads them.
 *   - Nothing here backfills. Records scored before this option existed keep the
 *     `GATE` that `blocked` used to collapse onto, which is why the release path
 *     still carries its trace-parsing fallback.
 *
 * The order below is deliberately "held-ness ascending" rather than alphabetical:
 * Pass, Gate, Unscored, Blocked reads as the escalation it is, and Blocked last
 * is also the only position that does not renumber an existing option.
 */
export default defineField({
  universalIdentifier: LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS.greenlightDecision,
  name: 'greenlightDecision',
  label: 'Greenlight decision',
  description:
    'Gate outcome for this lead. Gated leads stay visible and can be released by a human at any time — the gate is advisory, never a hard block. Blocked is a compliance stop, such as a recorded opt-out: the lead is held and cannot be released by hand; correct the underlying data instead. Unscored means the run failed open and the lead passed through flagged.',
  type: FieldType.SELECT,
  icon: 'IconGavel',
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
  options: [
    { position: 0, label: 'Pass', value: 'PASS', color: 'green' },
    { position: 1, label: 'Gate', value: 'GATE', color: 'orange' },
    { position: 2, label: 'Unscored', value: 'UNSCORED', color: 'gray' },
    { position: 3, label: 'Blocked', value: 'BLOCKED', color: 'red' },
  ],
  // Editable, unlike the score: releasing a lead by flipping this to Pass is the
  // human override path from ARCHITECTURE.md Path 4, and the engine writes the
  // matching audit row.
  isNullable: true,
});
