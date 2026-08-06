import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';
import { defineFrontComponent } from 'twenty-sdk/define';
import {
  AppPath,
  enqueueSnackbar,
  navigate,
  openCommandConfirmationModal,
} from 'twenty-sdk/front-component';

import { ENRICH_LEAD_REQUEST_CLIENT_PATH } from 'src/constants/enrichment-identifiers';
import { NEXT_ACTION_KIND_OPTIONS } from 'src/constants/next-action-kind-options';
import {
  PIPELINE_CLIENT_PATH,
  PIPELINE_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/pipeline-identifiers';
import {
  PIPELINE_LANES,
  type ActionKind,
  type CriterionResult,
  type PipelineCard,
  type PipelineLane,
  type RankedAction,
  type StageReadiness,
} from 'src/pipeline/types';
import {
  HANDOFF_FROM,
  HANDOFF_TO,
  LANE_LABELS,
  type BoardResponse,
  type CaptureResponse,
  type LaneSummary,
  type PipelineErrorResponse,
  type PipelineRequest,
  type PipelineResponse,
} from 'src/pipeline/wire';

/**
 * The board — the screen the product is judged on.
 *
 * ## The defect this closes
 *
 * Everything Greenlight did before this file was correct and disconnected. The
 * gate queue held leads, the ICP page explained why scores looked the way they
 * did, the record page carried a trace, and the command menu could enrich. Four
 * surfaces, and the one question a salesperson actually has — *what do I do
 * about this lead, right now* — was left in their head. The customer's words for
 * that were that the features "burden the sales person with thinking and
 * connecting the dots". So the unit of this screen is not a status and not a
 * score: it is a sentence and the button that acts on it.
 *
 * ## One request paints the whole thing
 *
 * `{ action: 'board' }` returns nine lanes, their true totals and up to fifty
 * cards each, already ranked. Nothing on this screen fetches per card and
 * nothing recomputes advice on render. That is not a performance preference, it
 * is the only shape that works: Twenty's REST limit is a hundred requests a
 * minute and a live workspace has around 1,200 people, so a board that read a
 * record at a time would rate-limit itself before it finished painting once.
 *
 * The three things that do make further requests all begin with a click —
 * refreshing, recomputing advice, moving or capturing a card — and none of them
 * patches the lane totals up locally from a partial answer. Recomputing asks for
 * the lanes in the same response (`withLanes`) and repaints from it; moving and
 * capturing re-read the board, because both write and the record they wrote is
 * not the only thing that changed. When an advise response comes back without
 * lanes — an older server, or a caller that did not ask — the board is re-read
 * exactly as it always was, which is the fail-open path and not a fallback worth
 * apologising for.
 *
 * ## Saying "nothing to do" once
 *
 * A card in Proposal or Customer genuinely has nothing to say, and for a while
 * this file said so four times on one card: an empty readiness bar labelled "not
 * applicable", the readiness summary, a chip reading "Nothing to do", and the
 * action sentence. Each string was defensible on its own; stacked, they made the
 * two lanes where the board has no opinion look broken rather than quiet.
 *
 * The survivor is the action sentence, everywhere, and the reasoning is set out
 * on `Readiness` and on `KIND_CHIP` below. In short: it is the only one of the
 * four the AI layer may have rewritten into the workspace's own language, it is
 * the slot a rep already reads for the instruction, and it is the only one that
 * distinguishes a closed deal from a stage with no checklist. The readiness
 * summary is not thrown away — it moves under "Why this", which is where a
 * question that starts "but why is there nothing to tick" belongs.
 *
 * ## Why the AI rewrite is a separate, named button
 *
 * `withNarrative` spends a model call and a search query **per card**. A board
 * that asked for it on every repaint would quietly bill a customer for looking
 * at their own pipeline, which is a defect no amount of better wording excuses.
 * So it is off by default, it is never implied by any other control, and asking
 * for it goes through a confirmation that says what it costs before it runs.
 * The plain recompute beside it is free and does the same ranking.
 *
 * ## Advance is a button, not a drag
 *
 * Recorded here because it is the decision most likely to be revisited.
 *
 * A drag is the obvious gesture for a board and it was the first design. It
 * loses on one point that turns out to be decisive: `acknowledgedUnmet` is
 * documented in `wire.ts` as the ids of the criteria that were outstanding *on
 * screen*, so the audit row can say what the person was looking at when they
 * decided. A drag finishes before there is anywhere to have shown them. Warning
 * afterwards, with the card already moved, is not a warning — it is a
 * notification, and it would make the receipt a fiction.
 *
 * Three lesser reasons point the same way: a drag has no keyboard equivalent
 * unless one is built; a nine-lane board scrolls horizontally, and dragging
 * across an auto-scrolling strip inside a hosted widget is the kind of thing
 * that works on the developer's machine; and the handoff is the product's
 * central idea, which a button can name — "Hand off to New — this creates the
 * opportunity" — where a gesture can only imply it.
 *
 * ## What the board will not offer to move
 *
 * The first four lanes are derived from Person state on every read and are
 * stored nowhere (see `PIPELINE_LANES` in `src/pipeline/types.ts`). There is no
 * write that moves a card from Captured to Held, so the board does not offer
 * one; it says why instead. That is a different thing from refusing a move with
 * unmet criteria, which it never does — a rep who knows something the CRM does
 * not is usually right, so the board records the override and lets it through.
 *
 * ## Nothing rendered here is trusted
 *
 * Every string on a card comes from workspace data or from an LLM that rewrote
 * it. All of it is rendered as text through JSX, which escapes it; there is no
 * `dangerouslySetInnerHTML` on this screen and no untrusted value reaches an
 * `href` or a style. Server prose — the action sentence, the readiness summary,
 * each notice, and any error message — is rendered verbatim and never
 * paraphrased. The sentence in particular is written to be read by a
 * salesperson and may have been rewritten in the workspace's own language;
 * substituting our own copy for it would throw away the whole point of the
 * ranking underneath.
 */

/* -------------------------------------------------------------------------- */
/* Palette and shared styles                                                   */
/* -------------------------------------------------------------------------- */

const GO = '#1F8A4C';
const WARN = '#B54708';
const STOP = '#B42318';
const INFO = '#175CD3';
const TIME = '#A15C07';
const INK = '#333';
const MUTED = '#888';
const LINE = '#e0e0e0';

const FONT =
  'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

/**
 * The root fills its widget and hides its own overflow; the lane strip below is
 * the only thing that scrolls sideways and each lane is the only thing that
 * scrolls down.
 *
 * `app/CLAUDE.md` warns against a front component that introduces its own
 * scroll instead of being responsive to its widget, "unless it is specifically
 * meant to be used in a canvas tab". This one is: the page layout puts it in a
 * `CANVAS` tab exactly as the ICP page does, for the same reason — the height of
 * the content depends on how many leads the workspace has, which is unknowable
 * from here. Confining the scroll to the strip is what keeps the page body from
 * scrolling horizontally, which is the failure a nine-lane board invites.
 */
const ROOT_STYLE: React.CSSProperties = {
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  padding: '16px',
  height: '100%',
  width: '100%',
  overflow: 'hidden',
  boxSizing: 'border-box',
  fontFamily: FONT,
  fontSize: '13px',
  color: INK,
};

const STRIP_STYLE: React.CSSProperties = {
  display: 'flex',
  flex: '1 1 auto',
  gap: '10px',
  minHeight: 0,
  overflowX: 'auto',
  overflowY: 'hidden',
  paddingBottom: '4px',
};

const LANE_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: '0 0 268px',
  minHeight: 0,
  borderRadius: '10px',
  border: `1px solid ${LINE}`,
  background: '#fcfcfc',
  boxSizing: 'border-box',
};

const CARD_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  padding: '10px 12px',
  borderRadius: '8px',
  border: `1px solid ${LINE}`,
  background: '#fff',
};

const NOTE_STYLE: React.CSSProperties = {
  color: MUTED,
  fontSize: '12px',
  lineHeight: 1.5,
};

const INPUT_STYLE: React.CSSProperties = {
  padding: '8px 10px',
  borderRadius: '8px',
  border: `1px solid ${LINE}`,
  fontSize: '13px',
  fontFamily: FONT,
  width: '100%',
  boxSizing: 'border-box',
};

const button = (
  primary: boolean,
  disabled: boolean,
  accent: string = GO,
): React.CSSProperties => ({
  padding: '7px 12px',
  borderRadius: '8px',
  border: `1px solid ${LINE}`,
  background: disabled ? '#f5f5f5' : primary ? accent : '#fff',
  color: disabled ? '#aaa' : primary ? '#fff' : INK,
  fontFamily: FONT,
  fontSize: '12px',
  fontWeight: 600,
  cursor: disabled ? 'not-allowed' : 'pointer',
});

const linkButton: React.CSSProperties = {
  alignSelf: 'flex-start',
  border: 'none',
  background: 'none',
  padding: 0,
  color: INK,
  fontFamily: FONT,
  fontSize: '12px',
  textDecoration: 'underline',
  cursor: 'pointer',
};

/* -------------------------------------------------------------------------- */
/* Small pure helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The server's own words for a failure, dug out of whichever envelope carried
 * them.
 *
 * Identical to the helper in `greenlight-icp.tsx`, deliberately: a
 * `PipelineErrorResponse` returned with a non-2xx status arrives as a thrown
 * `RestApiClientError` whose `body` is that response, so this reaches
 * `message` and renders it verbatim. The final fallback only fires when the
 * server said nothing at all, which is the one case where there is no server
 * copy to prefer.
 */
const serverMessage = (error: unknown): string => {
  const body = (error as { body?: unknown } | null)?.body;

  if (typeof body === 'object' && body !== null) {
    const message = (body as Record<string, unknown>)['message'];

    if (typeof message === 'string' && message !== '') {
      return message;
    }
  }

  return error instanceof Error && error.message !== ''
    ? error.message
    : 'Something went wrong.';
};

const formatMoment = (iso: string | null | undefined): string => {
  if (iso === null || iso === undefined || iso === '') {
    return 'at an unrecorded time';
  }

  const parsed = new Date(iso);

  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
};

/**
 * A stable key for a card across a refresh.
 *
 * Both ids are nullable and a card is always one record or the other, so the
 * pair is unique wherever either exists. The index tail is for the case neither
 * does, which should not happen and must not throw a React key warning at a
 * customer if it ever does.
 */
const cardKey = (card: PipelineCard, index: number): string =>
  card.leadId === null && card.opportunityId === null
    ? `${card.lane}#${index}`
    : `${card.leadId ?? ''}|${card.opportunityId ?? ''}`;

/**
 * "Close date" mid-sentence, without turning "ICP fit" into "iCP fit".
 *
 * Criterion labels are written for a list heading, so they start capitalised.
 * Lowering the first letter only when the second is not already a capital
 * leaves acronyms alone, which a blanket `toLowerCase` would not.
 */
const lowerFirst = (label: string): string =>
  label.length > 1 && label[1] === label[1].toUpperCase()
    ? label
    : label.charAt(0).toLowerCase() + label.slice(1);

const listOf = (results: readonly CriterionResult[]): string =>
  results.map((result) => lowerFirst(result.label)).join(', ');

/**
 * Does what the person typed into the one company field look like a domain?
 *
 * A dot, no spaces, or an explicit scheme. Sending "northwind.example" as a
 * company *name* would create a company called "northwind.example"; sending
 * "Northwind Logistics" as a *website* would give the dedupe step a domain that
 * cannot match anything. Neither is recoverable by the person who typed it, so
 * the guess is made here where it can be explained rather than on the server
 * where it cannot.
 */
const looksLikeWebsite = (value: string): boolean =>
  /^https?:\/\//i.test(value) ||
  (/\./.test(value) && !/\s/.test(value) && !value.endsWith('.'));

/**
 * One typed name into the two the contract wants.
 *
 * First token first name, everything after it last name — so "Maria van der
 * Berg" keeps its surname intact, which splitting on the last space would not.
 * The alternative was a fourth field, and the drawer is three fields on
 * purpose: a fourth is a fourth thing to type before a lead exists at all.
 */
const splitName = (raw: string): { firstName: string; lastName: string } => {
  const parts = raw.trim().split(/\s+/).filter((part) => part !== '');

  return {
    firstName: parts[0] ?? '',
    lastName: parts.slice(1).join(' '),
  };
};

/* -------------------------------------------------------------------------- */
/* Actions: the chip, and what the button does                                 */
/* -------------------------------------------------------------------------- */

/** Twenty's tag palette, in the hexes this panel already uses elsewhere. */
const TAG_COLOUR: Record<string, string> = {
  red: STOP,
  orange: WARN,
  blue: INFO,
  yellow: TIME,
  green: GO,
  gray: MUTED,
};

/**
 * The chip label and tier colour, taken from the field's own SELECT options
 * rather than restated here.
 *
 * `src/constants/next-action-kind-options.ts` already decides how each kind
 * reads and which tier colour it carries, and the record page, the filters and
 * the kanban headers all draw from it. Writing a second set of labels in this
 * file is precisely the mistake that file's own header records — two single
 * sources of truth is not one — so the board reads its chips from there and a
 * rep sees the same four words on the card as on the record.
 *
 * `NOTHING_TO_DO` is the one kind that gets no chip on this screen, and the
 * option is not removed from the constant to achieve it — a view still needs to
 * group and filter on it, and the record page still needs a word for it.
 *
 * A chip is a heading for the sentence under it. Every other one names a
 * category the sentence then makes specific: "Find the buyer" over a sentence
 * naming which buyer. "Nothing to do" over "Nothing is blocking this card and
 * nothing on the record says what to do next" is not a heading, it is the same
 * statement in fewer words, and it was one of the four ways this card used to
 * say nothing. The sentence survives because it is the one that says *why* — a
 * closed deal and a stage with no checklist read differently — and because it is
 * the only one an AI rewrite reaches.
 */
const CHIPLESS_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  'NOTHING_TO_DO',
]);

const KIND_CHIP: Partial<Record<ActionKind, { label: string; color: string }>> =
  Object.fromEntries(
    NEXT_ACTION_KIND_OPTIONS.filter(
      (option) => !CHIPLESS_KINDS.has(option.value),
    ).map((option) => [
      option.value,
      { label: option.label, color: option.color },
    ]),
  );

/**
 * What pressing the button does, for every one of the fourteen kinds.
 *
 * Three behaviours cover all of them, and the honesty of that is the point:
 *
 *   - **`open`** — the board cannot edit a Twenty field, so for anything that is
 *     a data fix it takes you to the record where the field lives. The label
 *     therefore says "Open the lead" and not "Find an email": a button that
 *     promised to find an email and then opened a form would be lying about
 *     itself. The instruction is the sentence above it, which the ranking wrote
 *     and which says exactly what to do; the button is transport, and it names
 *     its destination. `prefer` picks which record when a card has both.
 *   - **`enrich`** — the one action the engine can do unattended, and the only
 *     one whose sentence promises a machine will act ("Let Greenlight look up
 *     …"). It posts to the enrichment route that already exists behind the
 *     command menu item, so the button keeps the sentence's promise instead of
 *     sending somebody off to find the same button elsewhere. That connection is
 *     the whole complaint this board answers.
 *   - **`move`** — opens the move panel on the card, which is where the unmet
 *     criteria are shown and acknowledged.
 *
 * `NOTHING_TO_DO` gets no button, which is the correct rendering of a sentence
 * that says there is nothing to do. Inventing an affordance for it would undo
 * the honesty the ranking went to the trouble of producing.
 *
 * `satisfies Record<ActionKind, …>` rather than an annotation: adding a
 * fifteenth kind to the ranking then becomes a compile error here rather than a
 * card that renders no button to a customer.
 */
type ActionBehaviour =
  | { readonly does: 'open'; readonly prefer: 'lead' | 'deal'; readonly label: string }
  | { readonly does: 'enrich'; readonly label: string }
  | { readonly does: 'move'; readonly label: string }
  | { readonly does: 'none' };

const ACTION_BEHAVIOUR = {
  // Compliance. The block is on the Person record and only a human may lift it;
  // a board button that cleared a suppression would be a board that can work an
  // opted-out contact in one click.
  CLEAR_THE_BLOCK: { does: 'open', prefer: 'lead', label: 'Open the record' },

  LINK_THE_COMPANY: { does: 'open', prefer: 'lead', label: 'Open the lead' },
  FIND_AN_EMAIL: { does: 'open', prefer: 'lead', label: 'Open the lead' },
  STRENGTHEN_THE_RECORD: { does: 'open', prefer: 'lead', label: 'Open the lead' },

  FIND_THE_BUYER: { does: 'open', prefer: 'deal', label: 'Open the deal' },
  ASSIGN_AN_OWNER: { does: 'open', prefer: 'deal', label: 'Open the deal' },
  BOOK_A_MEETING: { does: 'open', prefer: 'deal', label: 'Open the deal' },
  SET_THE_AMOUNT: { does: 'open', prefer: 'deal', label: 'Open the deal' },
  SET_THE_CLOSE_DATE: { does: 'open', prefer: 'deal', label: 'Open the deal' },
  LOG_THE_NOTE: { does: 'open', prefer: 'deal', label: 'Open the deal' },
  CHASE_THE_STAGE: { does: 'open', prefer: 'deal', label: 'Open the deal' },

  ENRICH_THE_RECORD: { does: 'enrich', label: 'Enrich now' },

  ADVANCE_THE_CARD: { does: 'move', label: 'Move the card' },

  NOTHING_TO_DO: { does: 'none' },
} as const satisfies Record<ActionKind, ActionBehaviour>;

/**
 * Which lanes this card can actually be moved into.
 *
 * Empty for the first three lanes, and that is the design rather than a gap.
 * Captured, Enriching and Held are worked out from the lead's own state on every
 * read — the gate decision, whether a provider run is in flight — and are stored
 * nowhere, so there is no write that would move a card between them. Offering
 * the move and quietly doing nothing would be worse than saying so.
 *
 * Qualified offers exactly one target, because crossing the handoff line is what
 * creates the Opportunity and there is nowhere else for a qualified lead to go.
 * The five Opportunity lanes offer each other in both directions: that is
 * `opportunity.stage`, which Twenty's own kanban already lets anyone drag
 * backwards, and a board that only went forwards would be stricter than the CRM
 * it sits on.
 */
const OPPORTUNITY_LANES: readonly PipelineLane[] = [
  'new',
  'screening',
  'meeting',
  'proposal',
  'customer',
];

const moveTargets = (lane: PipelineLane): readonly PipelineLane[] => {
  if (lane === HANDOFF_FROM) {
    return [HANDOFF_TO];
  }

  return OPPORTUNITY_LANES.includes(lane)
    ? OPPORTUNITY_LANES.filter((target) => target !== lane)
    : [];
};

/* -------------------------------------------------------------------------- */
/* Request plumbing                                                            */
/* -------------------------------------------------------------------------- */

type PipelineSuccess = Exclude<PipelineResponse, PipelineErrorResponse>;

/**
 * Either the operation's own response, or the server's own words for why not.
 *
 * A single shape for both failure routes — a `PipelineErrorResponse` in a 200
 * body and one thrown inside a `RestApiClientError` — so every caller has one
 * thing to render and no caller has to write its own copy for a condition the
 * server understood better than this component does.
 */
type PostResult =
  | { readonly ok: true; readonly response: PipelineSuccess }
  | { readonly ok: false; readonly message: string };

/** The enrichment route's acknowledgement; it predates `wire.ts`. */
interface EnrichAcknowledgement {
  readonly ok?: boolean;
  readonly status?: string;
  readonly message?: string;
}

/* -------------------------------------------------------------------------- */
/* The board                                                                   */
/* -------------------------------------------------------------------------- */

const GreenlightPipeline = () => {
  const [board, setBoard] = useState<BoardResponse | null>(null);
  /** The server's words when the board itself could not be read. Verbatim. */
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Notices from the last capture, move or recompute. Board notices are separate. */
  const [replyNotices, setReplyNotices] = useState<readonly string[]>([]);
  const [narrativeMissing, setNarrativeMissing] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [movingKey, setMovingKey] = useState<string | null>(null);
  const mounted = useRef(true);

  const post = useCallback(
    async (request: PipelineRequest): Promise<PostResult> => {
      try {
        const response = await new RestApiClient().post<PipelineResponse>(
          PIPELINE_CLIENT_PATH,
          request,
        );

        if (
          response === null ||
          response === undefined ||
          response.action === 'error'
        ) {
          return {
            ok: false,
            message:
              response?.action === 'error'
                ? response.message
                : serverMessage(null),
          };
        }

        return { ok: true, response };
      } catch (error) {
        return { ok: false, message: serverMessage(error) };
      }
    },
    [],
  );

  const loadBoard = useCallback(
    async (label: string): Promise<void> => {
      setBusy(label);

      const result = await post({ action: 'board' });

      if (!mounted.current) {
        return;
      }

      if (result.ok && result.response.action === 'board') {
        setBoard(result.response);
        setFailure(null);
      } else if (!result.ok) {
        setFailure(result.message);
      }

      setBusy(null);
    },
    [post],
  );

  useEffect(() => {
    mounted.current = true;

    void loadBoard('board');

    return () => {
      mounted.current = false;
    };
  }, [loadBoard]);

  const lanes = useMemo(() => {
    const bySlot = new Map<PipelineLane, LaneSummary>();

    for (const summary of board?.lanes ?? []) {
      bySlot.set(summary.lane, summary);
    }

    // Driven by PIPELINE_LANES rather than by the order the response happened
    // to arrive in, so the handoff line always falls in the same place and a
    // lane the server omitted is visibly absent instead of shifting the rest.
    return PIPELINE_LANES.map((lane) => ({
      lane,
      summary: bySlot.get(lane) ?? null,
    }));
  }, [board]);

  const cardCount = useMemo(
    () =>
      (board?.lanes ?? []).reduce((sum, summary) => sum + summary.cards.length, 0),
    [board],
  );

  const disabled = busy !== null;

  /* ---------------------------------------------------------------------- */
  /* Operations                                                              */
  /* ---------------------------------------------------------------------- */

  const recompute = async (withNarrative: boolean): Promise<void> => {
    if (withNarrative) {
      // The only spend on this screen that scales with the size of the board,
      // so it is the only one that stops and says so first. The number is the
      // cards actually on screen, not the workspace total, because that is what
      // the request will cover.
      const answer = await openCommandConfirmationModal({
        title: 'Rewrite the advice using AI?',
        subtitle: `This spends one model call and one search query for each of the ${cardCount} cards on the board, charged to this workspace. It rewrites the wording only — the ranking underneath is unchanged, and the plain recompute is free.`,
        confirmButtonText: 'Rewrite the advice',
        confirmButtonAccent: 'blue',
      });

      if (answer !== 'confirm') {
        return;
      }
    }

    setBusy(withNarrative ? 'advise-ai' : 'advise');
    setNarrativeMissing(false);

    // Recomputing can change a card's lane as well as its sentence, and the lane
    // totals are the server's arithmetic over every record rather than over the
    // fifty it returned — so patching the returned cards into the board on their
    // own would leave a header claiming a count that no longer matches the lane
    // under it. This used to be answered by re-reading the whole board
    // afterwards: correct, and two round trips for a caller that wanted one,
    // each of them paging every Person and every Opportunity in the workspace.
    //
    // `withLanes` asks for the same lane shape `board` returns, computed by the
    // same function on the same pass, so one response repaints the screen.
    const result = await post({ action: 'advise', withNarrative, withLanes: true });

    if (!mounted.current) {
      return;
    }

    if (!result.ok) {
      setBusy(null);
      void enqueueSnackbar({ message: result.message, variant: 'error' });

      return;
    }

    if (result.response.action === 'advise') {
      const advised = result.response;

      setNarrativeMissing(advised.narrativeUnavailable);

      if (advised.lanes !== null) {
        setBoard({
          action: 'board',
          lanes: advised.lanes,
          notices: advised.notices,
          generatedAt: advised.generatedAt,
        });
        setFailure(null);
        // The advice notices are now the board's notices — they were computed on
        // the same pass and describe the same read. Leaving a copy under "From
        // your last action" as well would print every one of them twice under
        // two headings, which is the defect this screen was just cleaned of.
        setReplyNotices([]);
        setBusy(null);

        return;
      }

      setReplyNotices(advised.notices);
    }

    // No lanes came back, so the board is re-read exactly as it always was. A
    // server that does not answer with lanes must not leave the screen holding
    // stale totals, and it must not leave it empty either.
    await loadBoard(withNarrative ? 'advise-ai' : 'advise');
  };

  const advance = async (
    card: PipelineCard,
    toLane: PipelineLane,
  ): Promise<void> => {
    setBusy('advance');

    const result = await post({
      action: 'advance',
      leadId: card.leadId,
      opportunityId: card.opportunityId,
      toLane,
      // Exactly what the move panel had on screen. The receipt is only worth
      // keeping if it names what the person was actually looking at.
      acknowledgedUnmet: card.readiness.unmet.map((one) => one.criterionId),
    });

    if (!mounted.current) {
      return;
    }

    if (!result.ok) {
      setBusy(null);
      void enqueueSnackbar({ message: result.message, variant: 'error' });

      return;
    }

    if (result.response.action === 'advance') {
      const moved = result.response;

      setReplyNotices(moved.notices);
      setMovingKey(null);

      void enqueueSnackbar({
        // The server's sentence, verbatim, exactly as a failure's would be.
        //
        // This used to be written here, from `createdOpportunityId` and a lane
        // label, and it could not tell a handoff that opened a deal from one
        // that found a deal already on the lead and moved that instead — so it
        // announced that an opportunity "now exists" for a deal that had existed
        // for months. See `AdvanceResponse.message`.
        message: moved.message,
        variant:
          moved.card.lane === toLane
            ? 'success'
            : // The move did not land where it was asked to. The message says
              // where the card actually is; a green tick over it would be the
              // component contradicting the server in the same breath.
              'info',
      });
    }

    await loadBoard('advance');
  };

  const enrich = async (card: PipelineCard): Promise<void> => {
    if (card.leadId === null) {
      return;
    }

    setBusy('enrich');

    try {
      const reply = await new RestApiClient().post<EnrichAcknowledgement>(
        ENRICH_LEAD_REQUEST_CLIENT_PATH,
        { leadRecordId: card.leadId },
      );

      if (mounted.current) {
        void enqueueSnackbar({
          message: reply?.message ?? 'Enrichment finished.',
          variant:
            reply?.ok === false
              ? 'error'
              : reply?.status === 'enriched'
                ? 'success'
                : 'info',
        });
      }
    } catch (error) {
      if (mounted.current) {
        void enqueueSnackbar({
          message: serverMessage(error),
          variant: 'error',
        });
      }

      setBusy(null);

      return;
    }

    await loadBoard('enrich');
  };

  /**
   * Take the rep to the record the action is about.
   *
   * `prefer` is a preference and not a demand: a Qualified lead has no deal yet
   * and an imported Opportunity may have no linked Person, so whichever record
   * this card actually has wins over whichever one the action would rather see.
   * Falling back beats a dead button, and both records carry the same advice.
   */
  const open = async (
    card: PipelineCard,
    prefer: 'lead' | 'deal',
  ): Promise<void> => {
    const order: readonly ('lead' | 'deal')[] =
      prefer === 'deal' ? ['deal', 'lead'] : ['lead', 'deal'];

    for (const choice of order) {
      const id = choice === 'deal' ? card.opportunityId : card.leadId;

      if (id !== null) {
        await navigate(AppPath.RecordShowPage, {
          objectNameSingular: choice === 'deal' ? 'opportunity' : 'person',
          objectRecordId: id,
        });

        return;
      }
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  return (
    <div style={ROOT_STYLE}>
      <div
        style={{
          display: 'flex',
          gap: '12px',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          flex: '0 0 auto',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '3px',
            flex: '1 1 320px',
          }}
        >
          <strong style={{ fontSize: '15px' }}>Pipeline</strong>
          <span style={NOTE_STYLE}>
            Every lead and every deal in one place, each carrying the next move
            on it. The line after Qualified is where a lead becomes an
            opportunity.
          </span>
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setDrawerOpen(true)}
            style={button(true, disabled)}
          >
            Add a lead
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              // A notice that described the last capture stops describing
              // anything the moment the board is read again, and a stale one
              // sitting under a heading that says "your last action" is the
              // sort of thing that makes a rep distrust the fresh ones too.
              setReplyNotices([]);
              void loadBoard('board');
            }}
            style={button(false, disabled)}
          >
            {busy === 'board' ? 'Reading…' : 'Refresh'}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void recompute(false)}
            style={button(false, disabled)}
          >
            {busy === 'advise' ? 'Working it out…' : 'Recompute the advice'}
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void recompute(true)}
            style={button(false, disabled, INFO)}
          >
            {busy === 'advise-ai' ? 'Rewriting…' : 'Rewrite using AI'}
          </button>
        </div>
      </div>

      {/*
        The cost is stated on the screen and not only in the confirmation. A
        price a customer meets for the first time in a modal they have already
        decided to open is a price they were not offered a chance to avoid.
      */}
      <span style={{ ...NOTE_STYLE, flex: '0 0 auto' }}>
        Recomputing the advice is free and runs on your own data. Rewriting it
        using AI spends one model call and one search query for each card on the
        board; nothing on this screen asks for that on its own.
      </span>

      {narrativeMissing && (
        <span style={{ color: WARN, fontSize: '12px', lineHeight: 1.5 }}>
          The AI layer was not available, so these are Greenlight’s own
          sentences. The ranking is the same either way.
        </span>
      )}

      <Notices heading="Worth knowing" items={board?.notices ?? []} />
      <Notices heading="From your last action" items={replyNotices} />

      {failure !== null ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            alignItems: 'flex-start',
            padding: '14px 16px',
            borderRadius: '10px',
            border: `1px solid ${STOP}55`,
            background: `${STOP}0A`,
          }}
        >
          <span style={{ color: STOP, lineHeight: 1.5 }}>{failure}</span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => void loadBoard('board')}
            style={button(false, disabled)}
          >
            Try again
          </button>
        </div>
      ) : board === null ? (
        <span style={{ color: MUTED }}>Reading your pipeline…</span>
      ) : (
        <div style={STRIP_STYLE}>
          {lanes.map(({ lane, summary }) => (
            <Fragment key={lane}>
              {lane === HANDOFF_TO && <HandoffLine />}
              <LaneColumn
                lane={lane}
                summary={summary}
                disabled={disabled}
                expandedKey={expandedKey}
                movingKey={movingKey}
                onExpand={setExpandedKey}
                onMoving={setMovingKey}
                onOpen={(card, prefer) => void open(card, prefer)}
                onEnrich={(card) => void enrich(card)}
                onAdvance={(card, toLane) => void advance(card, toLane)}
              />
            </Fragment>
          ))}
        </div>
      )}

      {board !== null && (
        <span style={{ ...NOTE_STYLE, flex: '0 0 auto' }}>
          Read {formatMoment(board.generatedAt)}. Nothing on this board changes
          on its own — it says what it said when you last asked it.
        </span>
      )}

      {drawerOpen && (
        <CaptureDrawer
          post={post}
          onClose={() => setDrawerOpen(false)}
          onCaptured={() => void loadBoard('board')}
        />
      )}
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* Sub-components                                                              */
/* -------------------------------------------------------------------------- */

const Notices = ({
  heading,
  items,
}: {
  heading: string;
  items: readonly string[];
}) => {
  if (items.length === 0) {
    return null;
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        flex: '0 0 auto',
        padding: '10px 12px',
        borderRadius: '8px',
        border: `1px solid ${WARN}44`,
        background: `${WARN}0A`,
        maxHeight: '120px',
        overflowY: 'auto',
      }}
    >
      <strong style={{ fontSize: '12px', color: WARN }}>{heading}</strong>
      {items.map((notice, index) => (
        <span key={`${index}-${notice}`} style={{ lineHeight: 1.5 }}>
          {notice}
        </span>
      ))}
    </div>
  );
};

/**
 * The handoff line.
 *
 * A labelled column rather than a border on the Qualified lane, because it is
 * not a divider between two groups of lanes — it is the one boundary in the
 * product where Greenlight stops describing a person and starts describing a
 * deal, and where the only Opportunity this app ever creates gets created. A
 * rule nobody can read is a rule nobody learns.
 */
const HandoffLine = () => (
  <div
    style={{
      display: 'flex',
      flex: '0 0 34px',
      alignItems: 'center',
      justifyContent: 'center',
      borderLeft: `2px dashed ${GO}88`,
      marginLeft: '6px',
    }}
  >
    <span
      style={{
        writingMode: 'vertical-rl',
        color: GO,
        fontSize: '11px',
        fontWeight: 600,
        letterSpacing: '0.04em',
        whiteSpace: 'nowrap',
      }}
    >
      Handoff · a lead becomes an opportunity
    </span>
  </div>
);

const LaneColumn = ({
  lane,
  summary,
  disabled,
  expandedKey,
  movingKey,
  onExpand,
  onMoving,
  onOpen,
  onEnrich,
  onAdvance,
}: {
  lane: PipelineLane;
  summary: LaneSummary | null;
  disabled: boolean;
  expandedKey: string | null;
  movingKey: string | null;
  onExpand: (key: string | null) => void;
  onMoving: (key: string | null) => void;
  onOpen: (card: PipelineCard, prefer: 'lead' | 'deal') => void;
  onEnrich: (card: PipelineCard) => void;
  onAdvance: (card: PipelineCard, toLane: PipelineLane) => void;
}) => {
  const cards = summary?.cards ?? [];
  const total = summary?.total ?? 0;
  const truncated = summary !== null && total > cards.length;

  return (
    <section style={LANE_STYLE}>
      <header
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '2px',
          padding: '10px 12px',
          borderBottom: `1px solid ${LINE}`,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            gap: '8px',
          }}
        >
          <strong style={{ fontSize: '13px' }}>{LANE_LABELS[lane]}</strong>
          {/*
            The true count, always. A header showing the length of the returned
            page would tell a rep their Held lane holds fifty leads when it
            holds four hundred, and the whole reason the lane is capped is that
            it holds four hundred.
          */}
          <span style={{ color: MUTED, fontSize: '12px' }}>
            {summary === null ? '—' : total.toLocaleString()}
          </span>
        </div>

        {summary === null ? (
          <span style={{ color: WARN, fontSize: '12px', lineHeight: 1.5 }}>
            This lane did not come back with the board.
          </span>
        ) : truncated ? (
          <span style={{ color: MUTED, fontSize: '11px', lineHeight: 1.4 }}>
            Showing {cards.length} of {total.toLocaleString()} — a lane stops
            short so the whole board stays one request.
          </span>
        ) : null}
      </header>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          padding: '10px',
          overflowY: 'auto',
          minHeight: 0,
        }}
      >
        {summary !== null && cards.length === 0 && (
          <span style={{ color: MUTED, fontSize: '12px' }}>Nothing here.</span>
        )}

        {cards.map((card, index) => {
          const key = cardKey(card, index);

          return (
            <CardView
              key={key}
              card={card}
              disabled={disabled}
              expanded={expandedKey === key}
              moving={movingKey === key}
              onExpand={() => onExpand(expandedKey === key ? null : key)}
              onMoving={(open) => onMoving(open ? key : null)}
              onOpen={onOpen}
              onEnrich={onEnrich}
              onAdvance={onAdvance}
            />
          );
        })}
      </div>
    </section>
  );
};

const CardView = ({
  card,
  disabled,
  expanded,
  moving,
  onExpand,
  onMoving,
  onOpen,
  onEnrich,
  onAdvance,
}: {
  card: PipelineCard;
  disabled: boolean;
  expanded: boolean;
  moving: boolean;
  onExpand: () => void;
  onMoving: (open: boolean) => void;
  onOpen: (card: PipelineCard, prefer: 'lead' | 'deal') => void;
  onEnrich: (card: PipelineCard) => void;
  onAdvance: (card: PipelineCard, toLane: PipelineLane) => void;
}) => {
  const [top, ...rest] = card.actions;
  const targets = moveTargets(card.lane);
  const placement = summaryPlacement(card);

  return (
    <article style={CARD_STYLE}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: '8px',
          alignItems: 'baseline',
        }}
      >
        <span style={{ fontWeight: 600, lineHeight: 1.35 }}>
          {card.displayName}
        </span>
        <span
          style={{
            color: card.score === null ? MUTED : INK,
            fontWeight: 600,
            fontSize: card.score === null ? '11px' : '14px',
            whiteSpace: 'nowrap',
          }}
        >
          {card.score === null ? 'not scored' : card.score}
        </span>
      </div>

      <span style={{ color: MUTED, fontSize: '12px' }}>
        {card.companyName ?? 'No company on the record'}
      </span>

      {placement === 'face' && <Readiness readiness={card.readiness} />}

      {top === undefined ? (
        // `nextAction` promises never to return an empty list, so this is the
        // shape of a contract having been broken rather than of a quiet card.
        // Saying so beats rendering a card with a blank middle.
        <span style={{ color: WARN, fontSize: '12px', lineHeight: 1.5 }}>
          No next action came back for this card.
        </span>
      ) : (
        <ActionRow
          card={card}
          action={top}
          primary
          disabled={disabled}
          onOpen={onOpen}
          onEnrich={onEnrich}
          onMove={() => onMoving(true)}
        />
      )}

      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        <button type="button" onClick={onExpand} style={linkButton}>
          {expanded ? 'Less' : 'Why this'}
        </button>
        {targets.length > 0 && !moving && (
          <button
            type="button"
            onClick={() => onMoving(true)}
            style={linkButton}
          >
            Move…
          </button>
        )}
      </div>

      {moving && (
        <MovePanel
          card={card}
          targets={targets}
          disabled={disabled}
          onCancel={() => onMoving(false)}
          onAdvance={onAdvance}
        />
      )}

      {expanded && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            paddingTop: '8px',
            borderTop: `1px solid ${LINE}`,
          }}
        >
          {top !== undefined && (
            <>
              <span style={NOTE_STYLE}>{top.reason}</span>
              <span style={NOTE_STYLE}>The record says: {top.evidence}</span>
            </>
          )}

          {/*
            The stage's own account of why it has no checklist — "a person closes
            a deal, and Greenlight does not get a vote" — kept off the face of a
            card whose sentence has already said there is nothing to do, and kept
            here because "why is there nothing to tick" is a question asked by
            clicking "Why this". See `summaryPlacement`.
          */}
          {placement === 'detail' && (
            <span style={NOTE_STYLE}>{card.readiness.summary}</span>
          )}

          {rest.length > 0 && (
            <>
              <strong style={{ fontSize: '12px' }}>After that</strong>
              {rest.map((action, index) => (
                <ActionRow
                  key={`${action.kind}-${index}`}
                  card={card}
                  action={action}
                  primary={false}
                  disabled={disabled}
                  onOpen={onOpen}
                  onEnrich={onEnrich}
                  onMove={() => onMoving(true)}
                />
              ))}
            </>
          )}

          {card.readiness.results.length > 0 && (
            <>
              <strong style={{ fontSize: '12px' }}>The path to next</strong>
              {card.readiness.results.map((result) => (
                <CriterionRow key={result.criterionId} result={result} />
              ))}
            </>
          )}

          {card.placement.note !== '' && (
            <span style={NOTE_STYLE}>{card.placement.note}</span>
          )}

          {targets.length === 0 && (
            <span style={NOTE_STYLE}>
              This lane is worked out from the lead itself — its score, its gate
              decision, whether enrichment is still running — so there is no card
              to move out of it by hand. Release it from the gate queue, or let
              the scoring finish, and it will appear further along on its own.
            </span>
          )}

          <span style={NOTE_STYLE}>
            Advice worked out {formatMoment(card.advisedAt)} by engine{' '}
            {card.engineVersion}.
          </span>
        </div>
      )}
    </article>
  );
};

/**
 * One ranked action: the sentence exactly as it arrived, and the button.
 *
 * The sentence is never trimmed, never truncated with an ellipsis and never
 * replaced by the chip label. It may have been rewritten by an LLM into the
 * workspace's own language, and it is the only part of this screen that tells
 * somebody what to do; a card that abbreviated it to fit would have thrown away
 * the thing it exists to carry.
 */
const ActionRow = ({
  card,
  action,
  primary,
  disabled,
  onOpen,
  onEnrich,
  onMove,
}: {
  card: PipelineCard;
  action: RankedAction;
  primary: boolean;
  disabled: boolean;
  onOpen: (card: PipelineCard, prefer: 'lead' | 'deal') => void;
  onEnrich: (card: PipelineCard) => void;
  onMove: () => void;
}) => {
  const chip = KIND_CHIP[action.kind];
  const behaviour: ActionBehaviour = ACTION_BEHAVIOUR[action.kind];
  const accent = TAG_COLOUR[chip?.color ?? 'gray'] ?? MUTED;
  // A card in a Person lane has no deal to open, and an Opportunity with no
  // linked lead has no lead; either way the button would be pointing at
  // nothing, so it is left out rather than rendered dead.
  const hasSomethingToOpen =
    card.leadId !== null || card.opportunityId !== null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {chip !== undefined && (
        <span
          style={{
            alignSelf: 'flex-start',
            padding: '1px 7px',
            borderRadius: '999px',
            border: `1px solid ${accent}55`,
            background: `${accent}12`,
            color: accent,
            fontSize: '11px',
            fontWeight: 600,
          }}
        >
          {chip.label}
        </span>
      )}

      <span style={{ lineHeight: 1.5 }}>{action.sentence}</span>

      {behaviour.does === 'none' ? null : behaviour.does === 'enrich' ? (
        card.leadId === null ? null : (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onEnrich(card)}
            style={button(primary, disabled, INFO)}
          >
            {behaviour.label}
          </button>
        )
      ) : behaviour.does === 'move' ? (
        <button
          type="button"
          disabled={disabled}
          onClick={onMove}
          style={button(primary, disabled)}
        >
          {behaviour.label}
        </button>
      ) : hasSomethingToOpen ? (
        <button
          type="button"
          disabled={disabled}
          onClick={() => onOpen(card, behaviour.prefer)}
          style={button(primary, disabled, accent)}
        >
          {behaviour.label}
        </button>
      ) : null}
    </div>
  );
};

/**
 * The arithmetic, and the one number that must never be rounded into a lie.
 *
 * `percent` is `number | null`, and null means the denominator was empty — a
 * stage with no criteria, or one where every criterion was unreadable. Rendering
 * that as 0% would accuse a deal of being nowhere; rendering it as 100% would
 * call it ready. Both are claims the data does not support.
 *
 * It used to draw the bar anyway, empty, and label it "not applicable". That was
 * the first of the four ways a quiet card said nothing, and it was the worst of
 * them: a meter with nothing in it looks like a measurement of zero however it
 * is labelled, and a rep scanning a lane of them sees a column of failures. So
 * when there is no denominator there is no meter — the summary alone says which
 * of the two "we cannot say" cases happened, in words, which is what it was
 * always doing underneath.
 *
 * The summary is rendered verbatim and is already the arithmetic — "3 of 4 met —
 * missing: close date." — so nothing here restates it in worse words.
 */
const Readiness = ({ readiness }: { readiness: StageReadiness }) => {
  const percent = readiness.percent;

  if (percent === null) {
    return (
      <span style={{ ...NOTE_STYLE, fontSize: '11px' }}>
        {readiness.summary}
      </span>
    );
  }

  const tone = readiness.unmet.length === 0 ? GO : WARN;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span
          style={{
            display: 'inline-block',
            width: '56px',
            height: '4px',
            borderRadius: '2px',
            background: '#ececec',
            overflow: 'hidden',
            flex: '0 0 auto',
          }}
        >
          <span
            style={{
              display: 'block',
              width: `${percent}%`,
              height: '100%',
              background: tone,
            }}
          />
        </span>
        <span style={{ color: tone, fontSize: '11px', fontWeight: 600 }}>
          {percent}%
        </span>
      </div>
      <span style={{ ...NOTE_STYLE, fontSize: '11px' }}>
        {readiness.summary}
      </span>
    </div>
  );
};

/**
 * Where the readiness summary goes on this card: the face, the detail, or
 * nowhere.
 *
 * Three cases, and they are worth separating because the wrong answer to any of
 * them is a card that either nags or hides something.
 *
 *   - **`none`** — no transition and no results. The first three lanes are like
 *     that by design: they are derived from the lead's own state and have no
 *     checklist to be part-way through. A line reading "There is nothing to
 *     check at this stage" on every Captured card is noise on the lane that
 *     needs the least of it.
 *   - **`detail`** — the stage has a checklist in principle and no items in it,
 *     and the ranking had nothing to say either. That is Proposal, whose
 *     criteria are empty because PIPELINE_SPEC makes closing a deal a human's
 *     call. The summary and the action sentence are then two ways of saying
 *     nothing, so only one belongs on the face — and it is the sentence, which
 *     is the slot a rep reads for the instruction and the only string the AI
 *     layer may have rewritten into the workspace's own language. The summary is
 *     the better *answer* though, because it says why there is nothing rather
 *     than only that there is, so it moves under "Why this" where the question
 *     is asked. Both are the server's words; neither is paraphrased.
 *   - **`face`** — everything else, including the case that looks like the one
 *     above and is not: a stage whose every criterion came back unreadable. The
 *     summary then names them, the card would otherwise show no sign that
 *     anything failed to load, and burying that behind a click is precisely the
 *     silent degradation this app fails open to avoid.
 */
type SummaryPlacement = 'face' | 'detail' | 'none';

const summaryPlacement = (card: PipelineCard): SummaryPlacement => {
  const { readiness } = card;

  if (readiness.transition === null && readiness.results.length === 0) {
    return 'none';
  }

  return card.actions[0]?.kind === 'NOTHING_TO_DO' &&
    readiness.total === 0 &&
    readiness.indeterminate.length === 0
    ? 'detail'
    : 'face';
};

const CRITERION_TONE: Record<CriterionResult['status'], { word: string; colour: string }> =
  {
    met: { word: 'met', colour: GO },
    unmet: { word: 'not met', colour: WARN },
    // Never rendered as unmet, and never counted against the record. "We could
    // not check" and "the record says this is missing" send a salesperson to
    // two different places.
    indeterminate: { word: 'could not check', colour: MUTED },
  };

const CriterionRow = ({ result }: { result: CriterionResult }) => {
  const tone = CRITERION_TONE[result.status];

  return (
    <span style={{ ...NOTE_STYLE, fontSize: '11px' }}>
      <span style={{ color: tone.colour, fontWeight: 600 }}>{tone.word}</span> ·{' '}
      {result.label} — {result.evidence}
    </span>
  );
};

/**
 * The move panel: warn, show which, and move anyway.
 *
 * The board never refuses. A rep who knows the close date was agreed on a call
 * this morning is right and the CRM is wrong, and an app that blocked them would
 * be teaching them to work around it by the end of the week. So the outstanding
 * criteria are named — not counted, named — the consequence of going ahead is
 * stated once in plain words, and then the move happens on one click and the
 * ids of everything that was outstanding travel with it.
 */
const MovePanel = ({
  card,
  targets,
  disabled,
  onCancel,
  onAdvance,
}: {
  card: PipelineCard;
  targets: readonly PipelineLane[];
  disabled: boolean;
  onCancel: () => void;
  onAdvance: (card: PipelineCard, toLane: PipelineLane) => void;
}) => {
  const unmet = card.readiness.unmet;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '10px',
        borderRadius: '8px',
        border: `1px solid ${unmet.length === 0 ? LINE : `${WARN}55`}`,
        background: unmet.length === 0 ? '#fafafa' : `${WARN}0A`,
      }}
    >
      <strong style={{ fontSize: '12px' }}>Move this card</strong>

      {unmet.length > 0 && (
        <>
          {/*
            The count and the consequence, and then each one named with its
            evidence underneath. It used to list the labels here as well, which
            was the same list twice in three lines — once bare, once with the
            evidence that makes it worth reading. The named rows won: a rep
            deciding whether to go ahead is deciding on the evidence.
          */}
          <span style={{ color: WARN, fontSize: '12px', lineHeight: 1.5 }}>
            {unmet.length === 1
              ? 'One thing is still outstanding.'
              : `${unmet.length} things are still outstanding.`}{' '}
            You can move it anyway — Greenlight will record what was on screen
            and that you went ahead.
          </span>
          {unmet.map((result) => (
            <span
              key={result.criterionId}
              style={{ ...NOTE_STYLE, fontSize: '11px' }}
            >
              {result.label} — {result.evidence}
            </span>
          ))}
        </>
      )}

      {card.readiness.indeterminate.length > 0 && (
        <span style={{ ...NOTE_STYLE, fontSize: '11px' }}>
          {card.readiness.indeterminate.length === 1
            ? 'One criterion could not be checked'
            : `${card.readiness.indeterminate.length} criteria could not be checked`}{' '}
          — {listOf(card.readiness.indeterminate)}. Those are not counted either
          way and are not part of the record of this move.
        </span>
      )}

      {targets.map((target) => {
        const handoff = card.lane === HANDOFF_FROM && target === HANDOFF_TO;

        return (
          <div
            key={target}
            style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}
          >
            <button
              type="button"
              disabled={disabled}
              onClick={() => onAdvance(card, target)}
              style={button(handoff, disabled)}
            >
              {handoff
                ? `Hand off to ${LANE_LABELS[target]}`
                : `Move to ${LANE_LABELS[target]}`}
            </button>
            {handoff && (
              // What the button is about to do, and that nothing else does it.
              // What it *did* — which records were copied across, or whether a
              // deal already existed and was moved instead — is the server's to
              // say afterwards, and it says it in `AdvanceResponse.message`.
              <span style={{ ...NOTE_STYLE, fontSize: '11px' }}>
                This opens the deal. It is the only thing on this board that
                creates one.
              </span>
            )}
          </div>
        );
      })}

      <button type="button" onClick={onCancel} style={linkButton}>
        Cancel
      </button>
    </div>
  );
};

/**
 * Capture: three fields and one submit.
 *
 * A drawer over the board rather than a page, because the moment somebody has a
 * lead to type in is a moment they are already looking at the pipeline, and
 * navigating away to type three fields is how the three fields do not get typed.
 *
 * The submit runs one server-side chain — dedupe, create or link the company,
 * create the person, enrich if a provider is configured, score, gate, write the
 * trace — and returns the placed card. Which is why the confirmation says where
 * the lead landed and whether anything existing was reused: a rep who types in
 * somebody their colleague already added deserves to be told that, not to
 * discover it as a duplicate a fortnight later.
 */
const CaptureDrawer = ({
  post,
  onClose,
  onCaptured,
}: {
  post: (request: PipelineRequest) => Promise<PostResult>;
  onClose: () => void;
  onCaptured: () => void;
}) => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [busy, setBusy] = useState(false);
  const [placed, setPlaced] = useState<CaptureResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const ready = name.trim() !== '' && email.trim() !== '';

  const submit = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);

    const trimmedCompany = company.trim();
    const { firstName, lastName } = splitName(name);

    const result = await post({
      action: 'capture',
      firstName,
      lastName,
      email: email.trim(),
      ...(trimmedCompany === ''
        ? {}
        : looksLikeWebsite(trimmedCompany)
          ? { companyWebsite: trimmedCompany }
          : { companyName: trimmedCompany }),
    });

    setBusy(false);

    if (!result.ok) {
      setFailure(result.message);

      return;
    }

    if (result.response.action === 'capture') {
      setPlaced(result.response);
      setName('');
      setEmail('');
      setCompany('');
      onCaptured();
    }
  };

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        justifyContent: 'flex-end',
        background: '#00000022',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          width: '340px',
          maxWidth: '100%',
          height: '100%',
          padding: '20px',
          boxSizing: 'border-box',
          background: '#fff',
          borderLeft: `1px solid ${LINE}`,
          overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <strong style={{ fontSize: '15px' }}>Add a lead</strong>
          <span style={NOTE_STYLE}>
            Three fields. Greenlight checks them against the companies and people
            you already have, scores the lead, and puts the card on the board.
          </span>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontWeight: 600, fontSize: '12px' }}>Name</span>
          <input
            type="text"
            value={name}
            disabled={busy}
            placeholder="Priya Raman"
            onChange={(event) => setName(event.target.value)}
            style={INPUT_STYLE}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontWeight: 600, fontSize: '12px' }}>Email</span>
          <input
            type="email"
            value={email}
            disabled={busy}
            placeholder="priya@northwind.example"
            onChange={(event) => setEmail(event.target.value)}
            style={INPUT_STYLE}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <span style={{ fontWeight: 600, fontSize: '12px' }}>
            Company name or website
          </span>
          <input
            type="text"
            value={company}
            disabled={busy}
            placeholder="Northwind Logistics, or northwind.example"
            onChange={(event) => setCompany(event.target.value)}
            style={INPUT_STYLE}
          />
          <span style={{ ...NOTE_STYLE, fontSize: '11px' }}>
            A website matches an existing company more reliably than a name
            does. Either works, and you can leave it empty.
          </span>
        </label>

        <button
          type="button"
          disabled={busy || !ready}
          onClick={() => void submit()}
          style={button(true, busy || !ready)}
        >
          {busy ? 'Adding…' : 'Add the lead'}
        </button>

        {!ready && (
          <span style={{ ...NOTE_STYLE, fontSize: '11px' }}>
            A name and an email are the two Greenlight cannot score without.
          </span>
        )}

        {failure !== null && (
          <span style={{ color: STOP, lineHeight: 1.5 }}>{failure}</span>
        )}

        {placed !== null && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
              padding: '12px',
              borderRadius: '8px',
              border: `1px solid ${GO}44`,
              background: `${GO}0A`,
            }}
          >
            <strong style={{ fontSize: '13px' }}>
              {placed.card.displayName} is in {LANE_LABELS[placed.card.lane]}
            </strong>
            {/*
              The server's sentence, verbatim. This used to be assembled here
              from the two booleans, which could say "Added the company as a new
              record" about a capture that created no company at all — nothing
              was typed and nothing could be inferred from the address. The chain
              that ran knows which of the three things happened; a component
              reading two flags is guessing at an outcome it was not present for.
            */}
            <span style={NOTE_STYLE}>{placed.message}</span>
            {placed.card.actions[0] !== undefined && (
              <span style={{ lineHeight: 1.5 }}>
                {placed.card.actions[0].sentence}
              </span>
            )}
            <Notices heading="Worth knowing" items={placed.notices} />
          </div>
        )}

        <button type="button" onClick={onClose} style={button(false, false)}>
          Close
        </button>
      </div>
    </div>
  );
};

export default defineFrontComponent({
  universalIdentifier: PIPELINE_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  name: 'greenlight-pipeline',
  description:
    'The Greenlight board: nine lanes from Captured to Customer with the handoff line between them, every card carrying its stage readiness and the next move as a sentence with the button that acts on it, plus a three-field capture drawer.',
  component: GreenlightPipeline,
});
