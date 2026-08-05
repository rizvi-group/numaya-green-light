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
 *
 * ## Why no Greenlight field label begins with the word "Greenlight"
 *
 * This is the reference note for all ten Person fields the app owns.
 *
 * Twenty renders a record-page field label into a box that is exactly 90px wide
 * — `width: 90px` on the wrapping div, not a percentage — at 11.96px Inter, and
 * clamps it to one line with `-webkit-line-clamp: 1` over `white-space:
 * pre-wrap`. That is a **word-boundary** clamp, not a character one: a label
 * that does not fit loses whole trailing words. The word "Greenlight" measures
 * 58px on its own, and "Greenlight score" measures just over the 90px budget, so
 * *every* label of the form "Greenlight X" rendered as the single word
 * "Greenlight …" no matter what X was. Score, decision, trace and enrichment all
 * rendered identically on a scored record — the one screen a new user meets
 * first — and the three "Do not contact X" labels all collapsed to "Do not
 * contact …" for the same reason.
 *
 * Table column headings are a second, tighter surface: `<span>` with
 * `text-overflow: ellipsis` at 13px Inter, and the usable width is the view
 * field's `size` minus 37px — 28 for the icon and its gutter, 9 for the right
 * margin. A 110px column gives 73px, well under the 90px the record page gives,
 * so a label can clear the record page and still be cut off in a table. Both
 * surfaces had to be satisfied by the same string, so the labels below are sized
 * against the tighter of the two and the six views that carry a score or a
 * decision column had their `size`s raised to match.
 *
 * What was weighed against dropping the prefix, and what was checked rather than
 * assumed on the live instance:
 *
 *   - **The prefix is what made these fields findable.** Verified: the filter /
 *     field dropdown does *not* truncate — it renders the full label at natural
 *     width — and its search matches the label only. Typing "greenlight" there
 *     used to return the score and the decision; it now returns nothing. That is
 *     the real cost of this change and it is accepted, because the prefix was
 *     never legible on the two surfaces a rep actually reads, and because
 *     Greenlight remains discoverable through the eight sidebar views that all
 *     begin with "Greenlight", the "(Greenlight)" command-menu actions, and
 *     Settings → Data model, which shows "Numaya Greenlight" in an App column
 *     against every one of these fields.
 *   - **A suffix — "Score (Greenlight)" — was measured and rejected.** In the
 *     90px word-clamped box it renders as "Score …", which is worse than today:
 *     it spends the whole budget on the parenthetical and still loses it.
 *   - **`description` does not surface in the UI at all.** Checked on the record
 *     page (absent from the DOM), on hover (absent), and in Settings → Data
 *     model → People (the field list shows name, app and data type only). It is
 *     documentation for whoever reads the metadata API, not a tooltip, so it
 *     cannot carry meaning a truncated label lost. The descriptions here still
 *     name Greenlight, for that reader.
 *   - **The truncated label *is* recoverable on hover**, which is the one
 *     mitigation Twenty does offer: the label div is wrapped in
 *     `OverflowingTextWithTooltip`, and hovering a clamped label pops a portal
 *     node carrying the full label text. It softens the bug and does not fix it
 *     — two fields that render as the same eight characters cannot be told apart
 *     without hovering both, and nothing on screen suggests there is anything to
 *     hover.
 *   - **Icons survive truncation completely** — they sit outside the 90px box
 *     and are drawn at both surfaces. Every one of the ten fields carries a
 *     distinct icon except the two enrichment fields, which share `IconSparkles`
 *     as a family marker.
 *
 * So the labels are short, domain-worded, and chosen so that the first word
 * already separates them: "Lead score" / "Gate decision" / "Score trace", "Do
 * not contact" / "Block reason" / "Block note" / "Blocked since", "Enrich
 * status" / "Last enriched" / "Sourced data". Each measures under 90px at the
 * record-page font and under the header budget of its column, so none of them
 * truncates anywhere.
 *
 * "Gate decision" rather than the bare "Decision": it names the thing the
 * product does, and it is the same word as the "Greenlight Gate Queue" view the
 * held leads land in, so the two read as one feature.
 */
export default defineField({
  universalIdentifier: LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS.greenlightDecision,
  name: 'greenlightDecision',
  label: 'Gate decision',
  description:
    "Greenlight's gate outcome for this lead. Gated leads stay visible and can be released by a human at any time — the gate is advisory, never a hard block. Blocked is a compliance stop, such as a recorded opt-out: the lead is held and cannot be released by hand; correct the underlying data instead. Unscored means the run failed open and the lead passed through flagged.",
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
