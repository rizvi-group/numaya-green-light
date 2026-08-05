/**
 * The ranking — one card, one next move.
 *
 * Pure, `now` injected, never throws. **The deterministic ranking is the
 * product.** The AI layer sits on top of it and does two things only: rewrites
 * `sentence` in the workspace's own language, and — when a search provider is
 * configured — proposes the research. It never reorders this list, never
 * changes a `kind`, and never touches `evidence`.
 *
 * That split is commercial as much as technical. With no LLM and no search
 * provider configured, every card still shows a correct, useful next action.
 * Which is why the fallback sentences below are written as prose a salesperson
 * can act on at 08:40 on a Monday, and not as slugs waiting to be replaced:
 * for a large share of workspaces they are the finished product, not a
 * placeholder.
 *
 * ## The tiers, and why blockers are terminal
 *
 *   1. **Blockers** — compliance suppression, opt-out. Always first, and the
 *      only action returned. A card that offered "clear the block" *and* "book
 *      the meeting" would be a card offering to work an opted-out contact, and
 *      the fact that the offer sits second in a list is not a defence anybody
 *      would want to make to a regulator. Terminal means terminal.
 *   2. **Missing exit criteria** for the current stage, cheapest first. Cost is
 *      a static property of the criterion (see `criteria.ts`); this file only
 *      sorts on it.
 *   3. **Enrichable gaps** — a field the engine needed, could not resolve, and
 *      a provider could plausibly find.
 *   4. **Staleness** — days in the lane against the lane's expected dwell.
 *   5. **Score band** — the weakest rule the lead still *passes*, phrased as
 *      what would fix it. Read off the trace the scoring run already wrote;
 *      nothing here re-scores anything.
 */

import {
  CRITERION_COST,
  MS_PER_DAY,
  cheapnessOf,
  evaluateTransition,
  laneLabel,
  readiness,
  readTrace,
  resolvePipelineConfig,
  transitionForLane,
} from 'src/pipeline/criteria';
import {
  DECISION_BLOCKED,
  deriveLanePlacement,
  selectPrimaryOpportunity,
} from 'src/pipeline/lanes';
import {
  PIPELINE_ENGINE_VERSION,
  type CriterionResult,
  type LeadSnapshot,
  type OpportunitySnapshot,
  type PipelineCard,
  type PipelineConfigInput,
  type PipelineLane,
  type RankedAction,
  type StageReadiness,
  type TraceEntryView,
} from 'src/pipeline/types';

/* -------------------------------------------------------------------------- */
/* Input                                                                       */
/* -------------------------------------------------------------------------- */

export interface NextActionInput {
  readonly lead: LeadSnapshot;
  /** One, several, or none — whatever the relation returned. */
  readonly opportunity?:
    | OpportunitySnapshot
    | readonly OpportunitySnapshot[]
    | null;
  /** Raw configuration record. Anything unusable is repaired, never fatal. */
  readonly config?: PipelineConfigInput;
}

/* -------------------------------------------------------------------------- */
/* Small pure helpers                                                          */
/* -------------------------------------------------------------------------- */

const isUsableDate = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime());

const trimmed = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const parseTime = (value: unknown): number | null => {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  const parsed = Date.parse(value);

  return Number.isNaN(parsed) ? null : parsed;
};

const days = (count: number): string =>
  `${count} ${count === 1 ? 'day' : 'days'}`;

/** "industry, company size and region" — an Oxford-comma-free English list. */
const asList = (items: readonly string[]): string => {
  if (items.length <= 1) {
    return items[0] ?? '';
  }

  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
};

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** The lane a card moves into next, for the "path to" phrasing. */
const LANE_AFTER: Readonly<Partial<Record<PipelineLane, PipelineLane>>> = {
  qualified: 'new',
  new: 'screening',
  screening: 'meeting',
  meeting: 'proposal',
  proposal: 'customer',
};

const nameOf = (lead: LeadSnapshot): string =>
  trimmed(lead.displayName) || 'this lead';

const companyOf = (lead: LeadSnapshot): string =>
  trimmed(lead.companyName) || 'this account';

/* -------------------------------------------------------------------------- */
/* Tier 1 — blockers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A blocker's `cheapness` is zero, and that is not a claim that removing it is
 * hard work.
 *
 * It is a guard. Blockers are returned alone, but nothing stops a future caller
 * merging action lists or re-sorting one, and pinning a blocker to the floor of
 * the scale means no such caller can ever accidentally sort a sales action
 * above a compliance stop. Cheapness is a sales-effort scale, and "remove the
 * block" is not a sales action.
 */
const BLOCKER_CHEAPNESS = 0;

const blockerAction = (lead: LeadSnapshot): RankedAction | null => {
  const name = nameOf(lead);

  if (lead.suppressed === true) {
    const reason = trimmed(lead.suppressionReason);

    return {
      kind: 'CLEAR_THE_BLOCK',
      sentence: `Do not work ${name} — this record is suppressed in Greenlight${reason === '' ? '' : ` (${reason})`}. If that is wrong, allow contact again on the record; nothing else on this card applies until you do.`,
      reason: 'A compliance stop is on the record, and it outranks every sales action.',
      cheapness: BLOCKER_CHEAPNESS,
      evidence:
        reason === ''
          ? 'the record is marked as suppressed'
          : `the record is marked as suppressed: ${reason}`,
    };
  }

  if (lead.optedOut === true) {
    return {
      kind: 'CLEAR_THE_BLOCK',
      sentence: `Do not work ${name} — the record says they have opted out of contact. That is the contact's own instruction rather than a scoring judgement, so correct the data if it is wrong; nothing else on this card applies until it is.`,
      reason: 'A compliance stop is on the record, and it outranks every sales action.',
      cheapness: BLOCKER_CHEAPNESS,
      evidence: 'the opt-out column on the record is set',
    };
  }

  if (trimmed(lead.decision).toUpperCase() === DECISION_BLOCKED) {
    return {
      kind: 'CLEAR_THE_BLOCK',
      sentence: `Do not work ${name} — Greenlight scored this record as a compliance stop. Look at why before anything else happens on this card; if the underlying data is wrong, fix it and the lead will re-score and clear itself.`,
      reason: 'A compliance stop is on the record, and it outranks every sales action.',
      cheapness: BLOCKER_CHEAPNESS,
      evidence: 'the Greenlight decision on this record is BLOCKED',
    };
  }

  return null;
};

/* -------------------------------------------------------------------------- */
/* Tier 2 — missing exit criteria                                              */
/* -------------------------------------------------------------------------- */

const criterionActions = (
  lane: PipelineLane,
  stage: StageReadiness,
): readonly RankedAction[] => {
  const next = LANE_AFTER[lane];
  const path =
    next === undefined
      ? `out of ${laneLabel(lane)}`
      : `from ${laneLabel(lane)} to ${laneLabel(next)}`;

  return stage.unmet.map((result: CriterionResult, index: number) => ({
    kind: result.actionKind,
    sentence: result.sentence,
    reason:
      index === 0
        ? `The cheapest unmet exit criterion ${path}.`
        : `An unmet exit criterion ${path}.`,
    cheapness: cheapnessOf(result.cost),
    evidence: result.evidence,
  }));
};

/* -------------------------------------------------------------------------- */
/* Tier 3 — enrichable gaps                                                    */
/* -------------------------------------------------------------------------- */

/** Logical field keys in the words a salesperson uses for them. */
const GAP_LABELS: Readonly<Record<string, string>> = {
  industry: 'industry',
  region: 'region',
  employeeCount: 'company size',
  jobTitle: 'job title',
  seniority: 'seniority',
};

/**
 * One action for all the gaps rather than one per gap.
 *
 * Enrichment is a single button that asks about every requested field in one
 * provider call — the planner batches them precisely so a lead costs one query
 * and not five. Emitting five actions would misrepresent that as five separate
 * pieces of work and would push everything below it five places down the list.
 */
const enrichmentAction = (lead: LeadSnapshot): RankedAction | null => {
  const gaps = (lead.enrichableGaps ?? [])
    .filter((key): key is string => typeof key === 'string' && key.trim() !== '')
    .map((key) => key.trim());

  if (gaps.length === 0) {
    return null;
  }

  const labels = gaps.map((key) => GAP_LABELS[key] ?? key);

  return {
    kind: 'ENRICH_THE_RECORD',
    // Cheapness is measured in the human's effort, and the human's effort here
    // is one click — the machine does the looking.
    cheapness: cheapnessOf(CRITERION_COST.PICK_FROM_A_LIST),
    sentence: `Let Greenlight look up ${asList(labels)} for ${companyOf(lead)}. The score is being held back by data nobody has filled in, and a provider can probably find it.`,
    reason:
      'A field the score needed, could not read, and a provider could plausibly find.',
    evidence: `empty and enrichable: ${labels.join(', ')}`,
  };
};

/* -------------------------------------------------------------------------- */
/* Tier 4 — staleness                                                          */
/* -------------------------------------------------------------------------- */

/**
 * When the card entered the lane it is in.
 *
 * Person lanes are derived and therefore have no stored entry stamp — that is
 * the deliberate cost of not writing a pipeline-stage column onto Person — so
 * the caller supplies `laneEnteredAt` when it can work one out and `createdAt`
 * carries it otherwise. Opportunity lanes prefer `stageEnteredAt` and fall back
 * the same way.
 *
 * Null means we cannot date the card, and a card we cannot date never produces
 * a staleness action. Guessing would mean nagging somebody about a deal that
 * moved this morning.
 */
const laneEnteredAt = (
  lead: LeadSnapshot,
  opportunity: OpportunitySnapshot | null,
  source: 'person' | 'opportunity',
): number | null => {
  if (source === 'opportunity' && opportunity !== null) {
    return (
      parseTime(opportunity.stageEnteredAt) ?? parseTime(opportunity.createdAt)
    );
  }

  return parseTime(lead.laneEnteredAt) ?? parseTime(lead.createdAt);
};

const stalenessAction = (
  lane: PipelineLane,
  enteredAt: number | null,
  expectedDays: number | null,
  now: Date | null,
): RankedAction | null => {
  if (enteredAt === null || expectedDays === null || now === null) {
    return null;
  }

  const elapsed = Math.floor((now.getTime() - enteredAt) / MS_PER_DAY);

  // Strictly greater: a card on exactly its expected dwell is on time, not
  // late. The boundary matters more than it looks — an off-by-one here makes
  // every card in the workspace shout on the day it was supposed to be fine,
  // and a board that shouts constantly is a board people stop reading.
  if (elapsed <= expectedDays) {
    return null;
  }

  return {
    kind: 'CHASE_THE_STAGE',
    sentence: `Chase this one — it has sat in ${laneLabel(lane)} for ${days(elapsed)}, against the ${days(expectedDays)} this stage usually takes.`,
    reason: 'The card has been in this lane longer than the stage normally takes.',
    cheapness: cheapnessOf(CRITERION_COST.WRITE_IT_UP),
    evidence: `${days(elapsed)} in ${laneLabel(lane)}, expected ${days(expectedDays)}`,
  };
};

/* -------------------------------------------------------------------------- */
/* Tier 5 — score band                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The weakest rule the lead still passes.
 *
 * "Passing-but-weak" is the whole point of this tier: a *failing* rule has
 * already been reported by the gate and by the trace on the record, and
 * repeating it here would make the board a second, worse rendering of the
 * scoring explanation. What nobody surfaces today is the rule that scraped
 * through on partial credit — the cheapest points still on the table, and the
 * only tier that can say "this lead is fine, and here is how it becomes good".
 *
 * The trace is read, never recomputed. Re-scoring here would need the config,
 * the ICP and the vocabulary baseline, and the answer could differ from the
 * score printed beside it on the same card.
 */
const weakestPassingRule = (trace: unknown): TraceEntryView | null => {
  const candidates = readTrace(trace).filter(
    (entry) =>
      entry.contributed &&
      (entry.outcome === 'pass' || entry.outcome === 'partial') &&
      entry.pointsPossible > 0 &&
      entry.pointsEarned < entry.pointsPossible,
  );

  if (candidates.length === 0) {
    return null;
  }

  return [...candidates].sort((a, b) => {
    const shortfall =
      b.pointsPossible - b.pointsEarned - (a.pointsPossible - a.pointsEarned);

    // Rule id last, so two rules leaving the same points on the table always
    // resolve the same way. Determinism is a promise this module makes.
    return shortfall === 0 ? a.ruleId.localeCompare(b.ruleId) : shortfall;
  })[0] as TraceEntryView;
};

const scoreBandAction = (lead: LeadSnapshot): RankedAction | null => {
  const entry = weakestPassingRule(lead.trace);

  if (entry === null) {
    return null;
  }

  const earned = round1(entry.pointsEarned);
  const possible = round1(entry.pointsPossible);
  const tail = entry.remedy ?? entry.explanation;

  return {
    kind: 'STRENGTHEN_THE_RECORD',
    sentence: `Strengthen "${entry.ruleName}" on ${nameOf(lead)} — it is the weakest check this lead still passes, earning ${earned} of ${possible} available points.${tail === '' ? '' : ` ${tail}`}`,
    reason:
      'The weakest rule this lead still passes — the cheapest points left on the table.',
    cheapness: cheapnessOf(CRITERION_COST.FIX_THE_RECORD),
    evidence: `${entry.ruleName}: ${earned} of ${possible} points`,
  };
};

/* -------------------------------------------------------------------------- */
/* The fallbacks                                                               */
/* -------------------------------------------------------------------------- */

const advanceAction = (lane: PipelineLane): RankedAction => {
  const next = LANE_AFTER[lane];

  return {
    kind: 'ADVANCE_THE_CARD',
    sentence: `Every exit criterion for ${laneLabel(lane)} is met${next === undefined ? '' : `, so this one is ready for ${laneLabel(next)}`}. Move the card when you are ready — Greenlight will not move it for you.`,
    reason: 'Every exit criterion for this stage is met.',
    cheapness: cheapnessOf(CRITERION_COST.PICK_FROM_A_LIST),
    evidence: 'nothing on this stage\'s checklist is outstanding',
  };
};

/**
 * Said out loud rather than left blank.
 *
 * A card with no action would break the promise the board is built on, and an
 * invented one would break the trust it is built on. So the empty case gets a
 * sentence that says there is nothing, which is a true and occasionally useful
 * thing for a board to tell somebody.
 */
const nothingToDoAction = (lane: PipelineLane): RankedAction => ({
  kind: 'NOTHING_TO_DO',
  sentence:
    lane === 'customer'
      ? 'Nothing to do here — this one is closed. Greenlight has no advice to offer about a won deal.'
      : 'Nothing is blocking this card and nothing on the record says what to do next. Greenlight would rather tell you that than invent a task.',
  reason: 'No tier of the ranking had anything to say about this card.',
  cheapness: cheapnessOf(CRITERION_COST.SET_A_FIELD),
  evidence:
    lane === 'customer'
      ? 'the deal is closed'
      : 'no blocker, no unmet criterion, no gap, no staleness and no weak rule',
});

/* -------------------------------------------------------------------------- */
/* The ranking                                                                 */
/* -------------------------------------------------------------------------- */

export interface PipelineAdvice {
  readonly lane: PipelineLane;
  readonly readiness: StageReadiness;
  readonly actions: readonly RankedAction[];
}

const rank = (input: NextActionInput, now: Date): PipelineAdvice => {
  const lead: LeadSnapshot =
    typeof input.lead === 'object' && input.lead !== null ? input.lead : {};

  const placement = deriveLanePlacement(lead, input.opportunity ?? null);
  const { lane } = placement;

  const opportunity = Array.isArray(input.opportunity)
    ? selectPrimaryOpportunity(input.opportunity as OpportunitySnapshot[])
    : ((input.opportunity as OpportunitySnapshot | null | undefined) ?? null);

  const config = resolvePipelineConfig(input.config);
  const usableNow = isUsableDate(now) ? now : null;

  const transition = transitionForLane(lane);
  const stage = readiness(
    evaluateTransition(transition, {
      lead,
      opportunity,
      config,
      // An unusable clock is handed through as an unusable Date rather than
      // being repaired into "some plausible now". Every criterion that consults
      // it reports indeterminate, which is the honest answer, and matches how
      // the scoring engine treats a malformed `now`.
      now: usableNow ?? new Date(Number.NaN),
    }),
    transition,
  );

  const blocker = blockerAction(lead);

  if (blocker !== null) {
    // Terminal. Not "first" — only.
    return { lane, readiness: stage, actions: [blocker] };
  }

  const actions: RankedAction[] = [
    ...criterionActions(lane, stage),
    enrichmentAction(lead),
    stalenessAction(
      lane,
      laneEnteredAt(lead, opportunity, placement.source),
      config.stageDwellDays[lane],
      usableNow,
    ),
    scoreBandAction(lead),
  ].filter((action): action is RankedAction => action !== null);

  if (stage.total > 0 && stage.unmet.length === 0) {
    // **First**, not last.
    //
    // This was appended, and appending was wrong in a way only a live board
    // showed: a Qualified lead with every exit criterion met and a score of 100
    // led with "Let Greenlight look up industry, region and company size" — an
    // optional lookup ranked above the handoff, which is the single moment the
    // whole board exists to make obvious. Twenty-odd cards said it at once.
    //
    // The tiers below are all statements about something *missing*, and they are
    // ordered by how much is missing. "Every criterion for this stage is met" is
    // not a member of that sequence at all; it is a conclusion about the stage,
    // reached from the same evidence the tiers are guessing from. A gap
    // enrichment might fill is speculative — the provider may find nothing — and
    // holding a ready card behind a maybe is exactly the "connect the dots
    // yourself" complaint this screen was built to answer.
    //
    // The enrichment action does not disappear: it drops to second and the card
    // renders it under "After that". Enriching a deal that is ready to move is
    // still worth doing, just not instead of moving it.
    //
    // Note this can only fire when the stage has criteria to meet, so it never
    // pre-empts a tier on a lane with no checklist.
    actions.unshift(advanceAction(lane));
  }

  return {
    lane,
    readiness: stage,
    actions: actions.length === 0 ? [nothingToDoAction(lane)] : actions,
  };
};

/**
 * What to do about this card, best first. Never throws, never empty.
 *
 * Same inputs and the same `now` always produce the same list, down to the
 * order of the sentences: every comparison in here resolves on a value read
 * from the input, and the last tie-break is always an id.
 */
export const nextAction = (
  input: NextActionInput,
  now: Date,
): readonly RankedAction[] => {
  try {
    return rank(input, now).actions;
  } catch (error) {
    // Fail-open, the fourth level: the ranker itself broke. The card still
    // renders, and it says what happened rather than showing an action derived
    // from a half-finished pass.
    return [
      {
        kind: 'NOTHING_TO_DO',
        sentence:
          'Greenlight hit an unexpected error working out what to do with this card, so it is showing nothing rather than something wrong. The record itself is untouched.',
        reason: 'The ranking could not be completed.',
        cheapness: 0,
        evidence: error instanceof Error ? error.message : 'unknown error',
      },
    ];
  }
};

/* -------------------------------------------------------------------------- */
/* The card                                                                    */
/* -------------------------------------------------------------------------- */

const EMPTY_READINESS: StageReadiness = {
  transition: null,
  met: 0,
  total: 0,
  percent: null,
  unmet: [],
  indeterminate: [],
  results: [],
  summary: 'There is nothing to check at this stage.',
};

/**
 * Lane, readiness and actions in one pass — what the board query returns per
 * record and what the Opportunity's `greenlight*` fields cache.
 *
 * One call per record, no I/O, no clock read: a workspace with 1,205 people
 * paints its board from one logic-function invocation, and this is the function
 * that invocation maps over.
 */
export const buildPipelineCard = (
  input: NextActionInput,
  now: Date,
): PipelineCard => {
  const lead: LeadSnapshot =
    typeof input.lead === 'object' && input.lead !== null ? input.lead : {};

  const placement = deriveLanePlacement(lead, input.opportunity ?? null);

  let advice: PipelineAdvice;

  try {
    advice = rank(input, now);
  } catch {
    advice = {
      lane: placement.lane,
      readiness: EMPTY_READINESS,
      actions: nextAction(input, now) as RankedAction[],
    };
  }

  return {
    leadId: lead.id ?? null,
    opportunityId: placement.opportunityId,
    displayName: trimmed(lead.displayName) || 'Unnamed lead',
    companyName: trimmed(lead.companyName) === '' ? null : trimmed(lead.companyName),
    lane: placement.lane,
    placement,
    score: typeof lead.score === 'number' && Number.isFinite(lead.score) ? lead.score : null,
    readiness: advice.readiness,
    actions: advice.actions,
    advisedAt: isUsableDate(now) ? now.toISOString() : '',
    engineVersion: PIPELINE_ENGINE_VERSION,
  };
};
