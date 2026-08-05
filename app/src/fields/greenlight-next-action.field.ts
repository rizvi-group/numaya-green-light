import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { PIPELINE_OPPORTUNITY_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/pipeline-identifiers';

/**
 * The sentence on the card. "Held: role inbox, no decision-maker on the record."
 *
 * PIPELINE_SPEC.md states the whole product in one line — "the product is not a
 * score, the product is the next move" — and this is where the next move is
 * written down. Everything else the app owns is a verdict; this is an
 * instruction.
 *
 * ## Why the sentence is stored and not rendered
 *
 * The obvious design composes the sentence in the front component from
 * `greenlightNextActionKind` and a lookup table. Two things rule it out.
 *
 * The first is that the sentence is not a function of the kind alone. It names
 * the criterion that failed, the field that is missing, the number of days the
 * card has been still — facts that live in `greenlightCriteria` and in the
 * record, and reassembling them client-side means shipping the whole evaluation
 * to the browser for every card on the board.
 *
 * The second is the AI layer. Where an LLM is configured, the agent rewrites the
 * sentence in the workspace's own language — it never reorders the ranking and
 * never asserts a fact without a source, but it does choose the words. A phrase
 * a model produced once and a rep has read since is a fact about this record,
 * not a value to regenerate on every paint. Storing it also means the board
 * renders identically with the LLM switched off, which is the commercial
 * property the spec insists on: no AI and no search provider still leaves every
 * card carrying a correct, useful action.
 *
 * ## Why this is a separate file from the Person copy
 *
 * `defineField` binds one field to one object, and the SDK's build reads one
 * `export default define…` per file — the scaffolder generates exactly that
 * shape and `extractManifestFromFile` returns a single validated manifest per
 * path. So "the same logical field on Opportunity and Person" is two definitions
 * with two permanent identifiers, and two definitions are two files.
 *
 * The Person half is `greenlight-next-action-person.field.ts`, named with a
 * suffix rather than an object prefix so that the pair sorts adjacent in the
 * directory listing and neither can be edited without the other being visible
 * one line away. The unsuffixed file is the Opportunity one because Opportunity
 * is the object this feature is built around — Person carries advice only for
 * the four lanes that precede an Opportunity existing at all.
 *
 * TEXT rather than the SDK's rich text: this is one sentence a rep reads at a
 * glance on a card, and rich text on a kanban card is a formatting surface
 * nobody asked for.
 */
export default defineField({
  universalIdentifier:
    PIPELINE_OPPORTUNITY_FIELD_UNIVERSAL_IDENTIFIERS.greenlightNextAction,
  name: 'greenlightNextAction',
  // "Next action". ~62px in the record page's 90px word-clamped label box, so it
  // renders whole on both the record page and a table header; see the label note
  // in greenlight-decision.field.ts for why no Greenlight label carries the word
  // "Greenlight" and how the budget is measured. Its first word separates it
  // from every other label on both objects, which matters because the clamp
  // drops trailing words rather than characters — two labels sharing a first
  // word are indistinguishable the moment either one overflows.
  label: 'Next action',
  description:
    "The single next move Greenlight recommends for this opportunity, written as a sentence a salesperson can act on. Derived deterministically from blockers, unmet stage exit criteria, enrichable gaps, staleness and score band, in that order of priority; where an AI provider is configured it phrases the sentence but never changes which action was chosen. See Action type for the machine-readable form.",
  type: FieldType.TEXT,
  icon: 'IconArrowRight',
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.opportunity.universalIdentifier,
  // Read-only: the engine owns the wording, and the next recompute overwrites a
  // hand-edited sentence without warning. A rep who disagrees with the advice
  // acts against it — advancing is never blocked — rather than rewriting it.
  isUIEditable: false,
  isNullable: true,
});
