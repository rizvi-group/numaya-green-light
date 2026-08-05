import {
  defineField,
  FieldType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { PIPELINE_PERSON_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/pipeline-identifiers';

/**
 * The Person half of `greenlightNextAction`. Same meaning, different object,
 * different permanent identifier — see `greenlight-next-action.field.ts` for why
 * the sentence is stored rather than rendered, and why one logical field spanning
 * two objects is two files.
 *
 * ## What advice on a Person is *for*
 *
 * Four of the board's nine lanes are Person records with no Opportunity behind
 * them: Captured, Enriching, Held and Qualified. Those cards need an action as
 * much as a deal does — arguably more, because a Held lead is a lead nobody is
 * working — and there is no Opportunity row to cache it on. "Held: role inbox,
 * no decision-maker on the record" is advice about a lead, and the card in the
 * Held lane is the only place it will ever be read.
 *
 * ## Why the value is not simply copied forward on handoff
 *
 * Dragging a Qualified card across the handoff line creates the Opportunity, and
 * the temptation is to carry this sentence over to it. It must not be carried
 * over. The two fields answer questions in different frames: the Person sentence
 * is about whether this lead is worth contacting, the Opportunity sentence is
 * about what this *deal* needs to reach its next stage. The instant the
 * Opportunity exists the correct action is recomputed against the New stage's
 * exit criteria, and a stale lead-quality sentence sitting on a live deal would
 * be worse than an empty one, because a rep would act on it.
 *
 * Both copies stay on their records afterwards. A Person that has become a deal
 * still carries the reason it was ever qualified, which is the same reason the
 * score and the trace are not cleared on handoff.
 */
export default defineField({
  universalIdentifier:
    PIPELINE_PERSON_FIELD_UNIVERSAL_IDENTIFIERS.greenlightNextAction,
  name: 'greenlightNextAction',
  // Deliberately the same label as the Opportunity copy. They are never on the
  // same record page, they mean the same thing to the reader, and giving the
  // Person one a different string would make the one concept read as two. ~62px
  // in the 90px word-clamped box; see the label note in
  // greenlight-decision.field.ts.
  label: 'Next action',
  description:
    "The single next move Greenlight recommends for this lead, written as a sentence a salesperson can act on. Derived deterministically from blockers, enrichable gaps, staleness and score band, in that order of priority; where an AI provider is configured it phrases the sentence but never changes which action was chosen. Recomputed independently of the opportunity's own next action once this lead becomes a deal.",
  type: FieldType.TEXT,
  icon: 'IconArrowRight',
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
  isUIEditable: false,
  isNullable: true,
});
