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

export interface CaptureResponse {
  readonly action: 'capture';
  readonly card: PipelineCard;
  /** True when an existing Company or Person was reused rather than created. */
  readonly matchedExistingCompany: boolean;
  readonly matchedExistingPerson: boolean;
  readonly notices: readonly string[];
}

export interface AdvanceResponse {
  readonly action: 'advance';
  readonly card: PipelineCard;
  /** Set when crossing the handoff line created one. */
  readonly createdOpportunityId: string | null;
  readonly notices: readonly string[];
}

export interface AdviseResponse {
  readonly action: 'advise';
  readonly cards: readonly PipelineCard[];
  /** True when `withNarrative` was asked for and the AI layer was unavailable. */
  readonly narrativeUnavailable: boolean;
  readonly notices: readonly string[];
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
