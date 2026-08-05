import { ACTION_KINDS, type ActionKind } from 'src/pipeline/types';

/**
 * The SELECT options for `greenlightNextActionKind`, on both Opportunity and
 * Person.
 *
 * ## Why this is generated rather than written out
 *
 * The values are `ACTION_KINDS` from `src/pipeline/types.ts` — the exact list
 * the ranking emits. Hand-listing them in two field files would mean three
 * copies of one vocabulary, which is how the six-tier and fourteen-action
 * versions of this list came to exist simultaneously in the first place (see the
 * note in `pipeline-identifiers.ts`). Here the array drives the options and
 * `PRESENTATION` is a total record over the union, so adding a kind to the
 * ranking without deciding how it reads is a type error rather than a card that
 * renders a raw token to a customer.
 *
 * ## Why the labels are imperative
 *
 * These strings appear as a chip on a record page, as a filter value, and as a
 * kanban column header. In all three places the reader is a salesperson asking
 * "what do I do", so the label is the instruction — "Set the close date", not
 * "Close date missing". The declarative form describes the record; the
 * imperative form describes their afternoon.
 *
 * They deliberately echo the opening of the corresponding deterministic sentence
 * in `src/pipeline/next-action.ts`. Chip and sentence being the same words means
 * a rep who has learned the board can scan the chip alone and skip the prose.
 *
 * ## Colour is the tier, and it is the only signal that survives distance
 *
 * Fourteen labels are unreadable at arm's length on a dense board; six colours
 * are not. So colour collapses the actions back to the ranking tier they came
 * from — red for a compliance stop (the same red as a blocked gate decision,
 * because it is the same event seen from the other side), orange for work only a
 * human can do, blue for work the engine can do unattended, yellow for time
 * passing, green for a card with nothing in its way, grey for one the engine has
 * looked at and had no opinion about.
 *
 * That recovers the tier grouping the six-option version would have given,
 * without giving up the specificity of the action. It is the one place the two
 * competing designs both turned out to be right about something.
 *
 * `position` is the ranking order: blockers first, then human work roughly in
 * the order a deal encounters it, then engine work, then time, then the
 * nothing-to-do states. Display order only — an option's identity is its
 * `value`, and ids are derived deterministically from that value, so appending
 * later moves nothing that already exists.
 *
 * ## `as const satisfies`, not a type annotation
 *
 * `defineField` wants `FieldMetadataComplexOption[]`, whose `color` is the
 * SDK's `TagColor` union. Both of those types are *declared* in
 * `twenty-sdk/dist/define/index.d.ts` and neither is *exported*, so they cannot
 * be named here. Annotating `color: string` instead is not equivalent — `.map`
 * would widen it and `defineField` would reject the array.
 *
 * `as const` keeps each colour as its own literal type so the mapped array
 * still satisfies the SDK's union structurally, and `satisfies` keeps the
 * exhaustiveness check over `ActionKind` that an `as const` alone would throw
 * away. A colour that is not in the SDK's palette is caught by `defineField`
 * at the call site rather than here, which is later than ideal and is the
 * price of the missing export.
 */
const PRESENTATION = {
  // Compliance. Terminal: when this is the kind, it is the only action the
  // ranking returned, and nothing else on the card applies.
  CLEAR_THE_BLOCK: { label: 'Clear the block', color: 'red' },

  // Work only a person can do, ordered as a deal meets it: identify the
  // account, reach someone, reach the right someone, own it, meet, then the
  // commercial facts, then the write-up.
  LINK_THE_COMPANY: { label: 'Link the company', color: 'orange' },
  FIND_AN_EMAIL: { label: 'Find an email', color: 'orange' },
  FIND_THE_BUYER: { label: 'Find the buyer', color: 'orange' },
  ASSIGN_AN_OWNER: { label: 'Assign an owner', color: 'orange' },
  BOOK_A_MEETING: { label: 'Book a meeting', color: 'orange' },
  SET_THE_AMOUNT: { label: 'Set the amount', color: 'orange' },
  SET_THE_CLOSE_DATE: { label: 'Set the close date', color: 'orange' },
  LOG_THE_NOTE: { label: 'Write up the meeting', color: 'orange' },

  // "Strengthen the record" is the score-band action: the lead passes, but the
  // weakest passing rule is worth fixing. Orange rather than its own colour
  // because the fix is the rep's, same as the rest of this group.
  STRENGTHEN_THE_RECORD: { label: 'Strengthen the record', color: 'orange' },

  // The engine can do this one unattended, which is the whole distinction blue
  // carries: a rep scanning for blue is scanning for work they can delegate to
  // the app with one click.
  ENRICH_THE_RECORD: { label: 'Enrich the record', color: 'blue' },

  CHASE_THE_STAGE: { label: 'Chase this one', color: 'yellow' },

  // Not "Advance" — the board never advances a card and the label should not
  // imply it has. "Ready to advance" states the criteria are met and leaves the
  // move to a person.
  ADVANCE_THE_CARD: { label: 'Ready to advance', color: 'green' },

  // Grey, not green. A green "nothing to do" next to a green "ready to advance"
  // would read as praise for a card that is merely uninteresting, and the two
  // mean opposite things about whether to look at it.
  NOTHING_TO_DO: { label: 'Nothing to do', color: 'gray' },
} as const satisfies Record<ActionKind, { label: string; color: string }>;

export const NEXT_ACTION_KIND_OPTIONS = ACTION_KINDS.map((kind, position) => ({
  position,
  value: kind,
  label: PRESENTATION[kind].label,
  color: PRESENTATION[kind].color,
}));
