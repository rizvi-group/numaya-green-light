import type { PipelineCard, PipelineLane } from 'src/pipeline/types';

/**
 * The contract between the board's front component and its logic function.
 *
 * ## Why this file exists at all
 *
 * The two halves of the pipeline were built concurrently, and the first time
 * that was tried the two sides agreed a vocabulary in prose — a comment in
 * `src/constants/pipeline-identifiers.ts` naming what each side must consume
 * rather than mint. It half worked. The identifiers matched; the SELECT values
 * did not, because "both sides read the same paragraph" is not the same
 * guarantee as "both sides read the same type".
 *
 * So the request and response shapes are declared here, once, and imported by
 * the front component and by the logic function. A drift between them is a
 * compile error in a file one of them already imports, which is the only kind of
 * agreement that survives two people editing at the same time.
 *
 * Deliberately in `src/pipeline/` rather than `src/logic-functions/`: this
 * module must stay importable from a front component, so it may not reach for
 * anything server-side. It is types and constants only.
 *
 * ## Four operations, one route
 *
 * `icp-control` and `backfill-control` both settled on a single route with a
 * discriminated `action` in the body rather than a route per verb, and this
 * follows them. The reason is worth restating: every operation here needs the
 * same authentication, the same configuration read and the same licence check
 * before it does anything, and splitting them across four routes means four
 * copies of that preamble, three of which will eventually be missing a check the
 * fourth has.
 */

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

/** Paint the board. Read-only. */
export interface BoardRequest {
  readonly action: 'board';
  /**
   * Cards per lane. The board is a screen, not an export — a lane with four
   * hundred cards is not more useful than a lane with fifty and a count. The
   * server clamps this; see `BOARD_LANE_LIMIT`.
   */
  readonly perLane?: number;
}

/**
 * The capture drawer's whole payload. Three fields, because a fourth is a
 * fourth thing to type before a lead exists, and everything else on the record
 * is either derivable or enrichable.
 */
export interface CaptureRequest {
  readonly action: 'capture';
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  /** Either is enough to identify the account; both is better. */
  readonly companyName?: string;
  readonly companyWebsite?: string;
}

/**
 * Move a card.
 *
 * `toLane` rather than a delta, so a double-submitted drag lands the card where
 * the user dropped it instead of two lanes further on.
 *
 * ## Why `toLane` still admits all nine lanes
 *
 * Raised by the component author, and worth writing down rather than fixing:
 * the board only ever *offers* the Qualified handoff and moves between the five
 * Opportunity lanes (`moveTargets` in the front component), so a request naming
 * Captured, Enriching, Held or Qualified as a target can only come from a
 * hand-written caller. The obvious tightening is to narrow this type, or to
 * refuse those targets on the server.
 *
 * Both were declined, for two different reasons.
 *
 * Narrowing the type would be a lie about what the route accepts: the body is
 * JSON off the wire and `parsePipelineRequest` has to decide what to do with
 * `toLane: 'enriching'` whatever this type says, so the narrowing would move the
 * decision somewhere it is invisible rather than remove it.
 *
 * Refusing would break the one promise `runAdvance` is built on — PIPELINE_SPEC
 * § "Advancing is never blocked" — and would refuse moves that are perfectly
 * expressible. Three of the four derived lanes *are* a single write: Captured,
 * Held and Qualified are read back off `greenlightDecision`, and moving into
 * them writes the same field `release-lead.logic-function.ts` writes. Only
 * `enriching` has no write behind it, because it is derived from an in-flight
 * provider run and from gaps a provider might fill, neither of which a drag can
 * assert. That one case is already answered the way the rest of this file
 * answers a thing it cannot do: the move is audited, nothing is written, the
 * card comes back in the lane the record actually puts it in, and a notice says
 * so in the customer's words. See `runAdvance`, and the test named "should
 * record the move but write nothing when a card is dropped into Enriching".
 *
 * `acknowledgedUnmet` is the override receipt. The board never refuses a move —
 * a rep who knows something the CRM does not is usually right — but a move made
 * with criteria outstanding is recorded as one, and the flag is how the server
 * tells "the user saw the warning and went ahead" from "the client forgot to
 * check". Sent as the ids of the criteria that were outstanding *on screen*, so
 * the audit row can say what the person was actually looking at when they
 * decided.
 */
export interface AdvanceRequest {
  readonly action: 'advance';
  readonly leadId: string | null;
  readonly opportunityId: string | null;
  readonly toLane: PipelineLane;
  readonly acknowledgedUnmet?: readonly string[];
}

/** Recompute advice. One card, or every card the board would show. */
export interface AdviseRequest {
  readonly action: 'advise';
  readonly leadId?: string;
  readonly opportunityId?: string;
  /**
   * Ask the AI layer to rewrite the sentence. Off by default and never implied:
   * it is the only operation here that spends a model call or a search query,
   * and a board that quietly billed a customer every time it repainted would be
   * a defect regardless of how good the copy was.
   */
  readonly withNarrative?: boolean;
  /**
   * Return the lanes as well as the cards, so one response repaints the screen.
   *
   * ## The defect this closes
   *
   * `AdviseResponse` used to return `cards` and nothing else, and recomputing
   * advice can move a card between lanes — a deal whose close date was filled in
   * since the last read leaves Meeting. Merging the returned cards into a board
   * painted from an earlier `board` call therefore left the lane headers
   * claiming counts that no longer matched the cards under them, and the header
   * count is the one number a rep uses to decide which lane to work. The front
   * component did the only safe thing available to it and re-read the whole
   * board afterwards: two round trips for a caller that wanted one, both of
   * which page every Person and every Opportunity in the workspace.
   *
   * ## Why a flag rather than always
   *
   * Because a single-card advise should not pay for a whole board's arithmetic.
   * Board-wide advice already has every card in hand — the lanes are a group, a
   * sort and a slice over data that was read anyway, and cost nothing worth
   * naming. Advising *one* card has read one Person and its deals, so answering
   * with lanes means going back for all of them: the same work the second round
   * trip would have done. That is still a saving of one request and one shared
   * preamble for a caller that wants to repaint, and pure waste for the record
   * page recomputing one card. Neither caller can be guessed at from the shape
   * of the request, so it is asked for.
   *
   * Off by default, so the callers that existed before this flag are unchanged.
   */
  readonly withLanes?: boolean;
}

export type PipelineRequest =
  | BoardRequest
  | CaptureRequest
  | AdvanceRequest
  | AdviseRequest;

/* -------------------------------------------------------------------------- */
/* Responses                                                                   */
/* -------------------------------------------------------------------------- */

export interface LaneSummary {
  readonly lane: PipelineLane;
  readonly label: string;
  /** Every card in the lane, not just the returned ones. */
  readonly total: number;
  /** Clamped to `perLane`. `total > cards.length` means the lane is truncated. */
  readonly cards: readonly PipelineCard[];
}

export interface BoardResponse {
  readonly action: 'board';
  readonly lanes: readonly LaneSummary[];
  /**
   * Everything the board could not do, in the customer's words rather than in
   * ours. Populated when the ICP is empty, no search provider is configured, the
   * licence is missing, or a page of records failed to load — each of which
   * changes what the board is showing without making it wrong.
   *
   * A board that silently omits a lane it could not read is the failure mode
   * this exists to prevent: the screen looks complete and is not.
   */
  readonly notices: readonly string[];
  readonly generatedAt: string;
}

/**
 * `message` on a success, and why the two writing operations grew one.
 *
 * `PipelineErrorResponse` below argues that a component inventing its own copy
 * for a condition the server understood better is how "something went wrong"
 * ends up on a screen where the server knew exactly what went wrong. That
 * argument does not stop being true when the operation succeeds, and for a
 * while these two shapes were the exception: the front component wrote
 * "Handed off to New…" itself, from `createdOpportunityId` and a lane label,
 * because there was nothing on the response to render.
 *
 * It was wrong in the same way and for the same reason. The server is the half
 * that knows a deal already existed and was moved rather than opened, that a
 * write was rejected and the card is still where it was, or that the address
 * matched somebody already in the workspace. A client reconstructing any of
 * that from two booleans is guessing at an outcome it was not present for.
 *
 * So both carry one sentence saying what actually happened, written for the
 * person on the screen and rendered verbatim, exactly as `message` on the
 * failure shape is. `notices` keeps its own job — everything the operation
 * could not do — and does not repeat what `message` has already said.
 */
export interface CaptureResponse {
  readonly action: 'capture';
  readonly card: PipelineCard;
  /** What the chain did with the records. Rendered verbatim. */
  readonly message: string;
  /** True when an existing Company or Person was reused rather than created. */
  readonly matchedExistingCompany: boolean;
  readonly matchedExistingPerson: boolean;
  readonly notices: readonly string[];
}

export interface AdvanceResponse {
  readonly action: 'advance';
  readonly card: PipelineCard;
  /** Where the card actually landed and what the move did. Rendered verbatim. */
  readonly message: string;
  /** Set when crossing the handoff line created one. */
  readonly createdOpportunityId: string | null;
  readonly notices: readonly string[];
}

export interface AdviseResponse {
  readonly action: 'advise';
  readonly cards: readonly PipelineCard[];
  /**
   * The same lane shape `board` returns, or null when `withLanes` was not asked
   * for. See `AdviseRequest.withLanes`.
   *
   * Null rather than absent, so "the caller did not ask" and "the server does
   * not know how" are the same visible answer to a component deciding whether it
   * can repaint from this response or must go back for the board. A caller must
   * treat null as "read the board yourself": that is the fail-open path, and it
   * is what every caller did before this field existed.
   */
  readonly lanes: readonly LaneSummary[] | null;
  /** True when `withNarrative` was asked for and the AI layer was unavailable. */
  readonly narrativeUnavailable: boolean;
  readonly notices: readonly string[];
  /** When this advice was computed, so a repaint can date itself honestly. */
  readonly generatedAt: string;
}

/**
 * The failure shape.
 *
 * Every operation can return this instead of its success shape, and the front
 * component must render `message` verbatim: it is written for the person on the
 * screen, and the alternative — a component inventing its own copy for a
 * condition the server understood better — is how "something went wrong" ends up
 * on a screen where the server knew exactly what went wrong.
 */
export interface PipelineErrorResponse {
  readonly action: 'error';
  readonly code:
    | 'not_found'
    | 'invalid_request'
    | 'licence_required'
    | 'rate_limited'
    | 'unavailable';
  readonly message: string;
}

export type PipelineResponse =
  | BoardResponse
  | CaptureResponse
  | AdvanceResponse
  | AdviseResponse
  | PipelineErrorResponse;

/* -------------------------------------------------------------------------- */
/* Shared constants                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The per-lane cap, enforced server-side whatever the client asks for.
 *
 * Fifty because the board is one logic-function call and Twenty's REST limit is
 * a hundred requests a minute: a workspace with 1,205 people cannot be painted
 * by reading a record at a time, and a lane deep enough to need scrolling past
 * fifty is a lane the rep should be filtering, not scrolling.
 */
export const BOARD_LANE_LIMIT = 50;

/** Human labels for the lanes, in board order. */
export const LANE_LABELS: Record<PipelineLane, string> = {
  captured: 'Captured',
  enriching: 'Enriching',
  held: 'Held',
  qualified: 'Qualified',
  new: 'New',
  screening: 'Screening',
  meeting: 'Meeting',
  proposal: 'Proposal',
  customer: 'Customer',
};

/**
 * The lane a card must be in to cross the handoff line, and the lane it lands
 * in. Named rather than derived from array positions in `PIPELINE_LANES`,
 * because "index 3 to index 4" is exactly the sort of thing that keeps working
 * after somebody inserts a lane and stops meaning what it did.
 */
export const HANDOFF_FROM: PipelineLane = 'qualified';
export const HANDOFF_TO: PipelineLane = 'new';
