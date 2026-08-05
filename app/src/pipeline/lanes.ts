/**
 * Which lane a card sits in.
 *
 * Pure, and cheap enough to run for every record on every board read — which is
 * the point. Lanes 1-4 are **derived from Person state on every read and never
 * stored**, so there is no pipeline-stage column on Person to fall out of step
 * with the decision that produced it. Lanes 5-9 are Twenty's own
 * `opportunity.stage`, read as it is written.
 *
 * ## Precedence, and why it is not the order of the table in the spec
 *
 * The spec's membership table describes four overlapping sets, not four
 * mutually exclusive ones, so something has to break the ties. In order:
 *
 *   1. **Held** — `GATE` or `BLOCKED`. First, ahead of an in-flight enrichment
 *      run, because a held lead that renders under Enriching is a held lead
 *      nobody reviews. The spec's table lists Enriching above Held; that is a
 *      reading order, not a precedence, and putting a compliance stop behind a
 *      transient provider call is the one ordering that could cost a customer
 *      an ICO complaint.
 *   2. **Enriching** — a run is genuinely in flight.
 *   3. **Enriching** — never scored *and* a provider could plausibly fill a
 *      gap. A brand-new lead whose industry and headcount are unknown belongs
 *      where the board says "we are looking that up", not in a lane that
 *      implies a human has to do something.
 *   4. **Captured** — never scored and nothing to look up. The lead is simply
 *      sitting there, and the action tiers will say so.
 *   5. **Qualified** — `PASS`, with no Opportunity. (An Opportunity would have
 *      taken the card into the Twenty-owned half before any of this ran.)
 *
 * A `PASS` lead with enrichable gaps therefore stays **Qualified** and does not
 * get pulled back into Enriching. That decision is deliberate and it is what
 * makes the board work: the enrichable keys are industry, region, headcount,
 * job title and seniority, and almost every real lead is missing at least one
 * of them. Routing on "any gap exists" would empty the Qualified lane, break
 * the handoff line, and leave the ranker's enrichable-gaps tier permanently
 * unreachable — the gap is an *action* on a qualified card, not a lane.
 *
 * ## Recorded surprise
 *
 * The shipped `greenlightEnrichmentStatus` SELECT has no in-flight option at
 * all — its values are NOT_RUN / ENRICHED / NOTHING_FOUND / SKIPPED / CAPPED /
 * UNLICENSED / FAILED, every one of them terminal, because enrichment runs
 * inside a single logic-function invocation and nothing observes it mid-run.
 * Rule 2 above is consequently unreachable today. It is written anyway, against
 * a small vocabulary of the words a future queued implementation would use, so
 * that adding the option is a field change and not a lane-derivation change.
 */

import {
  DECISION_BLOCKED,
  DECISION_GATE,
  DECISION_PASS,
  DECISION_UNSCORED,
  normaliseDecision,
} from 'src/gate/release-decision';

import {
  PIPELINE_LANE_LABELS,
  type LanePlacement,
  type LeadSnapshot,
  type OpportunitySnapshot,
  type PipelineLane,
} from 'src/pipeline/types';

/* -------------------------------------------------------------------------- */
/* Stage vocabulary                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Twenty's shipped Opportunity stage options, mapped onto our lanes.
 *
 * Matched case-insensitively and with separators stripped, so `NEW`, `new`,
 * `New` and `IN_PROGRESS`-style variants of the same word all land. Anything
 * else is an unrecognised stage; see `laneForStage`.
 */
const STAGE_TO_LANE: Readonly<Record<string, PipelineLane>> = {
  new: 'new',
  screening: 'screening',
  meeting: 'meeting',
  proposal: 'proposal',
  customer: 'customer',
};

const normaliseStage = (raw: string | null | undefined): string =>
  (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');

/**
 * The lane a stage string names, or null when we do not recognise it.
 *
 * A workspace can rename Twenty's stage options — they are ordinary SELECT
 * options — and a workspace that has done so is not misconfigured, it is using
 * the product. So an unrecognised value is a normal event, not an error.
 */
export const laneForStage = (
  stage: string | null | undefined,
): PipelineLane | null => STAGE_TO_LANE[normaliseStage(stage)] ?? null;

/**
 * Where an unrecognised stage puts the card.
 *
 * **New**, and never off the board. The card is definitively past the handoff
 * line — an Opportunity exists — so the only question is which Twenty-owned
 * lane it lands in, and New is the earliest of them. Landing early is the safe
 * direction: its exit criteria (a decision-maker on the record, an owner
 * assigned) are checks Greenlight can still make honestly against any deal, so
 * the card stays useful rather than being filed under Proposal and asked for a
 * close date it may be nowhere near needing.
 *
 * The guess is recorded on `LanePlacement.stageRecognised` so the board can say
 * out loud that it did not understand the stage, which is what actually gets an
 * admin to map it.
 */
const UNRECOGNISED_STAGE_LANE: PipelineLane = 'new';

/* -------------------------------------------------------------------------- */
/* Picking one Opportunity out of several                                      */
/* -------------------------------------------------------------------------- */

/** Later is further along. Used only to compare two Opportunities. */
const STAGE_DEPTH: Readonly<Record<PipelineLane, number>> = {
  captured: 0,
  enriching: 0,
  held: 0,
  qualified: 0,
  new: 1,
  screening: 2,
  meeting: 3,
  proposal: 4,
  customer: 5,
};

const parseTime = (value: string | null | undefined): number | null => {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  const parsed = Date.parse(value);

  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * Which Opportunity a Person's card speaks for, when there is more than one.
 *
 * Twenty puts no cardinality constraint on Person → Opportunity and real
 * workspaces exploit that: renewals, a second site, a deal a colleague raised
 * without checking. The board still shows one card per person, so the choice
 * has to be made somewhere, and it has to be made the same way every time or
 * the card moves lane between two identical reads.
 *
 * **The rule: the furthest-advanced live deal wins. `Customer` only wins when
 * it is all there is. Ties break on the most recently created, then on id.**
 *
 * Each clause earns its place:
 *
 *   - *Furthest advanced*, because that is the deal closest to revenue and the
 *     one whose exit criteria are worth a salesperson's morning. The obvious
 *     alternative — most recently created — is worse in the common case: a rep
 *     who raises a stray Opportunity by mistake would drag a deal sitting at
 *     Proposal back to New, and the card would start asking for an owner.
 *   - *Customer last*, because a deal won eighteen months ago must not hide a
 *     live one. Ranking purely by depth would file that person under Customer
 *     for ever and the renewal would be invisible.
 *   - *Most recently created, then id*, because two deals at the same stage
 *     need a tie-break that cannot change between reads. `id` last means the
 *     answer is total: there is no input for which this returns "it depends".
 */
export const selectPrimaryOpportunity = (
  opportunities: readonly OpportunitySnapshot[],
): OpportunitySnapshot | null => {
  const usable = opportunities.filter(
    (candidate): candidate is OpportunitySnapshot =>
      typeof candidate === 'object' && candidate !== null,
  );

  if (usable.length === 0) {
    return null;
  }

  const rankOf = (opportunity: OpportunitySnapshot): number => {
    const lane = laneForStage(opportunity.stage) ?? UNRECOGNISED_STAGE_LANE;

    // Customer is terminal, so it sorts below every live stage rather than
    // above them all. Everything else keeps its natural depth.
    return lane === 'customer' ? -1 : STAGE_DEPTH[lane];
  };

  return [...usable].sort((a, b) => {
    const byRank = rankOf(b) - rankOf(a);

    if (byRank !== 0) {
      return byRank;
    }

    const byCreated = (parseTime(b.createdAt) ?? 0) - (parseTime(a.createdAt) ?? 0);

    if (byCreated !== 0) {
      return byCreated;
    }

    return (a.id ?? '').localeCompare(b.id ?? '');
  })[0] as OpportunitySnapshot;
};

/* -------------------------------------------------------------------------- */
/* Person state                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Words a queued enrichment implementation would use for "still working".
 *
 * None of them is currently a `greenlightEnrichmentStatus` option — see the
 * recorded surprise at the top of this file. Matching a small closed list
 * rather than "anything that is not a known terminal value" is on purpose: the
 * latter would put every lead whose status field held a typo into Enriching,
 * where nothing would ever move it out.
 */
const IN_FLIGHT_ENRICHMENT_STATUSES: readonly string[] = [
  'pending',
  'running',
  'inprogress',
  'inflight',
  'queued',
  'started',
];

const isEnrichmentInFlight = (status: string | null | undefined): boolean =>
  IN_FLIGHT_ENRICHMENT_STATUSES.includes(
    (status ?? '').trim().toLowerCase().replace(/[\s_-]+/g, ''),
  );

const hasEnrichableGap = (lead: LeadSnapshot): boolean =>
  Array.isArray(lead.enrichableGaps) &&
  lead.enrichableGaps.some(
    (key) => typeof key === 'string' && key.trim() !== '',
  );

/**
 * The lane a Person sits in when no Opportunity has been raised for them.
 *
 * An unreadable or unrecognised `greenlightDecision` falls through to Captured
 * rather than to Qualified. That is the fail-open direction for *this* choice:
 * Captured claims nothing about the lead, keeps it visible, and gives it the
 * "get this scored" action, whereas guessing Qualified would quietly present an
 * unscored stranger as cleared to work.
 */
const laneForPerson = (lead: LeadSnapshot): PipelineLane => {
  const decision = normaliseDecision(
    typeof lead.decision === 'string' ? lead.decision : null,
  );

  if (decision === DECISION_GATE || decision === DECISION_BLOCKED) {
    return 'held';
  }

  if (isEnrichmentInFlight(lead.enrichmentStatus)) {
    return 'enriching';
  }

  if (decision === DECISION_PASS) {
    return 'qualified';
  }

  // Everything left is UNSCORED, absent or unrecognised.
  return hasEnrichableGap(lead) ? 'enriching' : 'captured';
};

/* -------------------------------------------------------------------------- */
/* The answer                                                                  */
/* -------------------------------------------------------------------------- */

const emptyLead = (lead: unknown): LeadSnapshot =>
  typeof lead === 'object' && lead !== null ? (lead as LeadSnapshot) : {};

const asOpportunityList = (
  opportunity:
    | OpportunitySnapshot
    | readonly OpportunitySnapshot[]
    | null
    | undefined,
): readonly OpportunitySnapshot[] => {
  if (opportunity === null || opportunity === undefined) {
    return [];
  }

  if (Array.isArray(opportunity)) {
    return opportunity as readonly OpportunitySnapshot[];
  }

  return typeof opportunity === 'object'
    ? [opportunity as OpportunitySnapshot]
    : [];
};

/**
 * The lane, with its working shown. Never throws.
 *
 * ## Why an Opportunity beats an `UNSCORED` Person
 *
 * A Person can be `UNSCORED` — the engine failed open, or the lead predates the
 * install — and still have an Opportunity, because Twenty's own UI creates
 * Opportunities and neither knows nor cares what Greenlight decided. The
 * Opportunity wins, always. The handoff has already happened; there is a real
 * deal with a real stage in the customer's CRM, and pulling its card back to
 * Captured would tell a rep their live deal had regressed to a raw lead.
 *
 * The unscored state is not lost by that: it surfaces immediately as the card's
 * action, because the score-band tier has no trace to read and the handoff
 * criterion reports the score as indeterminate rather than failed.
 *
 * The same holds for a suppressed or blocked Person with a live deal. The lane
 * says where the deal is; the blocker action — first and terminal — says it
 * must not be worked. Those are two different questions and the board answers
 * both rather than conflating them into a lane.
 */
export const deriveLanePlacement = (
  lead: LeadSnapshot,
  opportunity:
    | OpportunitySnapshot
    | readonly OpportunitySnapshot[]
    | null
    | undefined,
): LanePlacement => {
  const safeLead = emptyLead(lead);
  const candidates = asOpportunityList(opportunity);
  const primary = selectPrimaryOpportunity(candidates);

  if (primary === null) {
    return {
      lane: laneForPerson(safeLead),
      source: 'person',
      stageRecognised: true,
      opportunityId: null,
      opportunityCount: 0,
      note: '',
    };
  }

  const recognised = laneForStage(primary.stage);
  const lane = recognised ?? UNRECOGNISED_STAGE_LANE;

  const notes: string[] = [];

  if (recognised === null) {
    notes.push(
      `This deal's stage (${(primary.stage ?? '').trim() === '' ? 'empty' : String(primary.stage).trim()}) is not one Greenlight recognises, so the card is shown in ${PIPELINE_LANE_LABELS[lane]}.`,
    );
  }

  if (candidates.length > 1) {
    notes.push(
      `This person has ${candidates.length} opportunities; the card follows the furthest-advanced live one.`,
    );
  }

  return {
    lane,
    source: 'opportunity',
    stageRecognised: recognised !== null,
    opportunityId: primary.id ?? null,
    opportunityCount: candidates.length,
    note: notes.join(' '),
  };
};

/**
 * The lane a card belongs in.
 *
 * Accepts one Opportunity, several, or none — the board hands over whatever the
 * relation returned. Use {@link deriveLanePlacement} when the caller needs to
 * know *why*.
 */
export const deriveLane = (
  lead: LeadSnapshot,
  opportunity:
    | OpportunitySnapshot
    | readonly OpportunitySnapshot[]
    | null
    | undefined,
): PipelineLane => deriveLanePlacement(lead, opportunity).lane;

/** True for the four lanes Greenlight derives rather than reads. */
export const isPersonDerivedLane = (lane: PipelineLane): boolean =>
  lane === 'captured' ||
  lane === 'enriching' ||
  lane === 'held' ||
  lane === 'qualified';

/**
 * Re-exported so callers that only import lanes still speak the same decision
 * vocabulary as the gate queue rather than inventing a second copy of it.
 */
export {
  DECISION_BLOCKED,
  DECISION_GATE,
  DECISION_PASS,
  DECISION_UNSCORED,
};
