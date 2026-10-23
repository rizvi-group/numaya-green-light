/**
 * Numaya Greenlight — pipeline core types.
 *
 * Same discipline as `src/scoring/types.ts` and `src/enrichment/types.ts`: no
 * Twenty SDK import, no network, no filesystem, no clock read. Everything the
 * pipeline core needs arrives as an argument, `now` included. The logic
 * functions in `src/logic-functions/` fetch records, call these pure functions
 * once for the whole board, and write the answers back.
 *
 * ## The `undefined` / `null` distinction, which is load-bearing
 *
 * Every field on the snapshot types below is optional, and the two absent
 * values mean different things:
 *
 *   - `undefined` — **we did not read this.** The board query did not select
 *     the field, the relation was not resolved, the activity page was not
 *     fetched. A criterion that depends on it reports `indeterminate`.
 *   - `null` or `''` — **we read it and it is empty on the record.** A
 *     criterion that depends on it reports `unmet`.
 *
 * That is the same distinction the scoring trace already draws between
 * `errored`/`not_applicable` and `fail`, and it exists for the same reason: a
 * card that says "close date is empty" when the truth is "we never looked at
 * the close date" sends a salesperson to fix something that is not broken, and
 * it only has to happen twice before nobody believes the board again.
 *
 * ## Why the snapshots are structural
 *
 * They are hand-written subsets, not Twenty's REST types. Three reasons, in
 * order of how much each has cost elsewhere: the REST types drag the SDK into
 * a module that must stay pure; they change shape between Twenty releases and
 * would break the pure core on somebody else's schedule; and a test that has to
 * construct a full `PersonDTO` to check one predicate is a test nobody writes.
 */

import type { RuleTraceEntry } from 'src/scoring';

/** Bumped whenever a change alters the lane or the action a card would get. */
export const PIPELINE_ENGINE_VERSION = '0.1.0';

/* -------------------------------------------------------------------------- */
/* Lanes                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The nine lanes of the board.
 *
 * The first four are **derived** from Person state on every read and are never
 * stored — there is no "pipeline stage" column on Person that could drift out
 * of sync with the decision that produced it. The last five are Twenty's own
 * `opportunity.stage`, which Twenty's UI writes as readily as ours does.
 *
 * Lower-case ids, matching `GateDecision` in `src/scoring/types.ts` rather than
 * the SCREAMING_CASE of the SELECT options these sometimes correspond to. The
 * distinction is deliberate: a `PipelineLane` is Greenlight's own vocabulary,
 * and the day a workspace renames Twenty's `SCREENING` option to `Discovery`
 * the lane must keep its name.
 */
export type PipelineLane =
  /** Landed, never scored. Nothing has happened to it yet. */
  | 'captured'
  /** A provider run is in flight, or the record has gaps worth filling first. */
  | 'enriching'
  /** Scored and held: `GATE` or `BLOCKED`. A human decides. */
  | 'held'
  /** Scored, passed, no Opportunity yet. The lane the handoff line runs after. */
  | 'qualified'
  | 'new'
  | 'screening'
  | 'meeting'
  | 'proposal'
  | 'customer';

/** Left to right, exactly as the board renders. */
export const PIPELINE_LANES: readonly PipelineLane[] = [
  'captured',
  'enriching',
  'held',
  'qualified',
  'new',
  'screening',
  'meeting',
  'proposal',
  'customer',
];

/** The four lanes Greenlight derives; the rest belong to `opportunity.stage`. */
export const PERSON_DERIVED_LANES: readonly PipelineLane[] = [
  'captured',
  'enriching',
  'held',
  'qualified',
];

/** Lane headings, in the words the board shows. */
export const PIPELINE_LANE_LABELS: Readonly<Record<PipelineLane, string>> = {
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
 * Where a card's lane came from, and whether anything had to be guessed.
 *
 * `deriveLane` returns a bare lane because that is what the spec asks for and
 * what 90% of callers want. This is the same answer with its working shown, so
 * the board can render "we could not read this deal's stage" instead of quietly
 * filing it under New and letting a rep wonder why.
 */
export interface LanePlacement {
  readonly lane: PipelineLane;
  readonly source: 'person' | 'opportunity';
  /**
   * False when an Opportunity carried a stage string we do not recognise — a
   * renamed SELECT option, a workspace-added stage, or a typo in an import.
   */
  readonly stageRecognised: boolean;
  /** The Opportunity the lane was taken from, when there was one. */
  readonly opportunityId: string | null;
  /** How many Opportunities were in play. Greater than one means we chose. */
  readonly opportunityCount: number;
  /** Written for a salesperson. Empty when nothing needed explaining. */
  readonly note: string;
}

/* -------------------------------------------------------------------------- */
/* Input snapshots                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A Person as the pipeline core sees it.
 *
 * Everything is optional; see the `undefined` / `null` note at the top of this
 * file, which is the whole reason for that.
 */
export interface LeadSnapshot {
  readonly id?: string | null;
  /** Denormalised for the card and for the fallback sentences. */
  readonly displayName?: string | null;
  /** Raw `greenlightDecision`: `PASS` / `GATE` / `BLOCKED` / `UNSCORED`. */
  readonly decision?: string | null;
  /** Raw `greenlightScore`, 0-100. */
  readonly score?: number | null;
  /** Raw `greenlightEnrichmentStatus`. */
  readonly enrichmentStatus?: string | null;
  /**
   * Logical field keys a provider could plausibly fill and has not — the
   * enrichment planner's own output, handed over rather than recomputed here.
   * Empty array means "we checked, there are none"; `undefined` means we did
   * not check.
   */
  readonly enrichableGaps?: readonly string[];
  /** Greenlight's own suppression flag. */
  readonly suppressed?: boolean | null;
  readonly suppressionReason?: string | null;
  /** The workspace's own opt-out column, wherever the mapping points. */
  readonly optedOut?: boolean | null;
  readonly companyId?: string | null;
  readonly companyName?: string | null;
  /** Primary email as a plain string. The I/O layer flattens Twenty's composite. */
  readonly email?: string | null;
  readonly jobTitle?: string | null;
  /** Workspace member id, or whatever the caller uses for "who owns this". */
  readonly ownerId?: string | null;
  /** Raw `greenlightTrace`, in whatever envelope the scoring run wrote. */
  readonly trace?: unknown;
  /** ISO 8601. */
  readonly createdAt?: string | null;
  /**
   * ISO 8601. When this lead entered the lane it is in now, if the caller can
   * tell. Person lanes are derived and therefore have no stored entry stamp, so
   * in practice this is usually the score timestamp or `createdAt`; staleness
   * falls back to `createdAt` and reports itself as approximate.
   */
  readonly laneEnteredAt?: string | null;
}

/**
 * An Opportunity as the pipeline core sees it.
 *
 * `amount` is a plain number, not Twenty's `{ amountMicros, currencyCode }`
 * composite. The conversion belongs at the I/O boundary: currency arithmetic in
 * a pure ranker would mean the ranker had an opinion about exchange rates, and
 * no criterion here asks anything of the amount except whether somebody has put
 * a number on the deal.
 */
export interface OpportunitySnapshot {
  readonly id?: string | null;
  readonly name?: string | null;
  /** Raw `stage`. A workspace may have renamed the options; see `deriveLane`. */
  readonly stage?: string | null;
  readonly amount?: number | null;
  /** ISO 8601. */
  readonly closeDate?: string | null;
  readonly ownerId?: string | null;
  /**
   * The workspace's own account-executive select on Opportunity, when it has
   * one. Not shipped by Twenty and not shipped by Greenlight: a workspace
   * custom field, selected only after a probe confirmed it exists (see
   * `pipelineOpportunitySelection`), which is why `undefined` — the field is
   * not there — stays distinguishable from `null`/`''` — read, and unassigned.
   */
  readonly ae?: string | null;
  readonly pointOfContactId?: string | null;
  readonly companyId?: string | null;
  /** ISO 8601. */
  readonly createdAt?: string | null;
  /** ISO 8601. When the deal reached its current stage, when that is knowable. */
  readonly stageEnteredAt?: string | null;
  /**
   * ISO 8601. The most recent discovery call that has been *logged* — a Twenty
   * Task marked done or a CalendarEvent, resolved by the caller. A date in the
   * future is a booked call, not a held one, and the criterion says so.
   */
  readonly lastDiscoveryCallAt?: string | null;
  /** ISO 8601. The most recent Note on the deal. */
  readonly lastNoteAt?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Criteria                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The stage transitions that have exit criteria.
 *
 * Only the Opportunity half of the board has them, plus the handoff itself.
 * That is not an omission: Captured, Enriching and Held are states the *engine*
 * is responsible for leaving — score it, enrich it, release it — and a
 * checklist a salesperson cannot tick is a checklist that teaches people to
 * ignore checklists.
 *
 * `proposal_to_customer` exists and is deliberately empty. Closing a deal is a
 * human's call and an app does not get a vote, but the transition still has to
 * be nameable so the card can say *why* there is nothing to tick.
 */
export type TransitionId =
  | 'qualified_to_new'
  | 'new_to_screening'
  | 'screening_to_meeting'
  | 'meeting_to_proposal'
  | 'proposal_to_customer';

/**
 * Three states, and the third one is the point.
 *
 * `unmet` means the record says this is missing. `indeterminate` means we could
 * not check — the field was not loaded, the trace was unreadable, the predicate
 * threw. They are never allowed to render the same way and `indeterminate` is
 * never counted against the record, which is the same bargain the scoring
 * engine strikes when it excludes an `errored` rule from the denominator rather
 * than scoring it zero.
 */
export type CriterionStatus = 'met' | 'unmet' | 'indeterminate';

/**
 * What one criterion decided, with its working.
 *
 * The result carries `cost`, `actionKind` and `sentence` copied from the
 * criterion definition so that a result can be ranked and rendered on its own,
 * without the ranker having to hold the catalogue open beside it. That copy is
 * also what keeps cost out of the ranker: the ranker sorts, it does not decide
 * what is expensive.
 */
export interface CriterionResult {
  readonly criterionId: string;
  readonly label: string;
  readonly transition: TransitionId;
  readonly status: CriterionStatus;
  /**
   * Human-readable, and specific: "close date is empty", "discovery call
   * logged 2026-07-14". Always populated, for every status — an `met` result
   * with no evidence is an assertion, and the card shows arithmetic.
   */
  readonly evidence: string;
  /** Effort to satisfy. Lower is cheaper. See `CRITERION_COST` in criteria.ts. */
  readonly cost: number;
  readonly actionKind: ActionKind;
  /** The fallback prose shown when this criterion is the chosen action. */
  readonly sentence: string;
}

/** Everything a criterion is allowed to look at. Pure, `now` included. */
export interface CriterionSnapshot {
  readonly lead: LeadSnapshot;
  readonly opportunity: OpportunitySnapshot | null;
  readonly config: PipelineConfig;
  readonly now: Date;
}

/**
 * A single named predicate over data Twenty already holds.
 *
 * Adding one is a local change: write it, put it in the transition's array,
 * done — readiness arithmetic, fail-open wrapping, cost ordering and the
 * fallback sentence are all inherited. The same shape as `ScoringRule`, for the
 * same reason.
 */
export interface Criterion {
  readonly id: string;
  /** Short, for the readiness list: "Close date", "Discovery call". */
  readonly label: string;
  readonly appliesTo: TransitionId;
  /**
   * How much work satisfying this costs a human. **A static property of the
   * criterion, never a judgement the ranker makes.** Setting a date field is
   * cheap; getting a stranger to take a call is not, and no amount of context
   * about a particular deal changes that ordering.
   */
  readonly cost: number;
  readonly actionKind: ActionKind;
  /** Deterministic fallback prose. See `RankedAction.sentence`. */
  readonly sentence: string;
  evaluate(snapshot: CriterionSnapshot): CriterionResult;
}

/**
 * The arithmetic the card shows, not a verdict.
 *
 * "3 of 4 met — missing: close date." A readiness meter that hides which
 * criterion failed is a progress bar, and a progress bar is not an instruction.
 */
export interface StageReadiness {
  readonly transition: TransitionId | null;
  readonly met: number;
  /** `met + unmet`. Indeterminate criteria are excluded from the denominator. */
  readonly total: number;
  /**
   * 0-100, or **null when there is nothing to divide by** — a transition with
   * no criteria, or one where every criterion was indeterminate. Null is not
   * 100: "everything is done" and "we could check nothing" must not render as
   * the same full bar. `greenlightReadiness` is left empty rather than written
   * as 0 in that case.
   */
  readonly percent: number | null;
  /** Cheapest first, then declaration order. The path to the next phase. */
  readonly unmet: readonly CriterionResult[];
  /** Kept and shown, never silently dropped. */
  readonly indeterminate: readonly CriterionResult[];
  /** Every result, in declaration order, for the RAW_JSON field. */
  readonly results: readonly CriterionResult[];
  /** One sentence for the card. */
  readonly summary: string;
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The machine-readable half of an action: what the button does, and what a view
 * can filter on. Stored in `greenlightNextActionKind`.
 *
 * These are verbs, not statuses. "Missing close date" is a status and belongs
 * in the evidence string; `set_the_close_date` is a thing a person does, and
 * the whole product claim is that a card carries the second kind and not the
 * first.
 */
export type ActionKind =
  /** Compliance. Terminal, and not a sales action. */
  | 'CLEAR_THE_BLOCK'
  | 'LINK_THE_COMPANY'
  | 'FIND_AN_EMAIL'
  | 'STRENGTHEN_THE_RECORD'
  | 'FIND_THE_BUYER'
  | 'ASSIGN_AN_OWNER'
  | 'BOOK_A_MEETING'
  | 'SET_THE_AMOUNT'
  | 'SET_THE_CLOSE_DATE'
  | 'LOG_THE_NOTE'
  | 'ENRICH_THE_RECORD'
  /** Staleness: the deal has sat longer than this stage usually takes. */
  | 'CHASE_THE_STAGE'
  /** Every exit criterion is met. Only a human moves a card. */
  | 'ADVANCE_THE_CARD'
  /** Honest emptiness. Better than an invented task. */
  | 'NOTHING_TO_DO';

export const ACTION_KINDS: readonly ActionKind[] = [
  'CLEAR_THE_BLOCK',
  'LINK_THE_COMPANY',
  'FIND_AN_EMAIL',
  'STRENGTHEN_THE_RECORD',
  'FIND_THE_BUYER',
  'ASSIGN_AN_OWNER',
  'BOOK_A_MEETING',
  'SET_THE_AMOUNT',
  'SET_THE_CLOSE_DATE',
  'LOG_THE_NOTE',
  'ENRICH_THE_RECORD',
  'CHASE_THE_STAGE',
  'ADVANCE_THE_CARD',
  'NOTHING_TO_DO',
];

/**
 * One ranked next move.
 *
 * `sentence` is the **deterministic fallback**, and it is not a placeholder. A
 * workspace with no LLM and no search provider configured sees these strings
 * and nothing else, so each one is written to be read by a salesperson at
 * 08:40 on a Monday and acted on without opening the record. The AI layer
 * replaces this string and only this string; it never reorders the list, never
 * changes `kind`, and never touches `evidence`.
 */
export interface RankedAction {
  readonly kind: ActionKind;
  /** The sentence on the card. Prose, never a slug. */
  readonly sentence: string;
  /** Which tier of the ranking chose it, in words. Shown as the "why". */
  readonly reason: string;
  /**
   * 0-100, **higher is cheaper**. Derived from the criterion's static cost, so
   * two cards showing the same action always show the same number.
   */
  readonly cheapness: number;
  /** What the record actually said. Never inferred, never phrased as advice. */
  readonly evidence: string;
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Everything the pipeline core reads out of the Greenlight configuration
 * record. Deliberately tiny: a criterion that needed a fifth knob would be a
 * criterion the customer cannot reason about.
 */
export interface PipelineConfig {
  /** Mirrors the scoring engine's own threshold; the handoff criterion uses it. */
  readonly gateThreshold: number;
  /** Per-lane expected dwell, in days. Null means the lane never goes stale. */
  readonly stageDwellDays: Readonly<Record<PipelineLane, number | null>>;
}

/** Whatever came out of the CRM config record. Anything unusable is repaired. */
export type PipelineConfigInput = unknown;

/* -------------------------------------------------------------------------- */
/* The card                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One card on the board: where it is, how far through the stage it is, and what
 * to do about it. The whole payload the board query returns per record, and the
 * exact set of things the Opportunity's `greenlight*` fields cache.
 */
export interface PipelineCard {
  readonly leadId: string | null;
  readonly opportunityId: string | null;
  readonly displayName: string;
  readonly companyName: string | null;
  readonly lane: PipelineLane;
  readonly placement: LanePlacement;
  readonly score: number | null;
  readonly readiness: StageReadiness;
  /** Best first. Never empty — see `nextAction`. */
  readonly actions: readonly RankedAction[];
  /** ISO 8601 of the injected `now`. Written to `greenlightAdvisedAt`. */
  readonly advisedAt: string;
  readonly engineVersion: string;
}

/* -------------------------------------------------------------------------- */
/* Trace reading                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The subset of a scoring trace entry the pipeline reads back off the record.
 *
 * Typed as a `Pick` of the engine's own `RuleTraceEntry` so the two cannot
 * drift: if the engine renamed `pointsPossible`, this would stop compiling
 * rather than start silently finding no weak rules. The values still arrive as
 * `unknown` from a RAW_JSON column and are normalised defensively — see
 * `readTrace` in criteria.ts, and the same forgiving treatment in
 * `src/gate/release-decision.ts`, which is the other reader of this field.
 */
export type TraceEntryView = Pick<
  RuleTraceEntry,
  | 'ruleId'
  | 'ruleName'
  | 'outcome'
  | 'severity'
  | 'contributed'
  | 'pointsEarned'
  | 'pointsPossible'
  | 'explanation'
> & { readonly remedy: string | null };
