/**
 * Numaya Greenlight — the pipeline decision core.
 *
 * Wiring this into a Twenty logic function is three lines:
 *
 * ```ts
 * import { buildPipelineCard } from 'src/pipeline';
 *
 * const card = buildPipelineCard(
 *   {
 *     lead: toLeadSnapshot(person),          // your own flattening, at the edge
 *     opportunity: person.opportunities,     // one, several or none
 *     config: greenlightConfigRecord,        // raw; anything unusable is repaired
 *   },
 *   new Date(),                              // the clock lives at the edge
 * );
 *
 * // card.lane / card.readiness / card.actions[0].sentence
 * ```
 *
 * Nothing in this folder imports the Twenty SDK, touches the network, or reads
 * the clock. `deriveLane`, `nextAction` and `buildPipelineCard` never throw:
 * missing, malformed or unresolvable input degrades to a weaker-but-valid
 * answer — a card in the safest lane, a criterion marked `indeterminate` rather
 * than failed, an action that says what happened. A lead is never lost and
 * never silently dropped, which is the same promise `src/scoring` makes.
 */

export {
  ALL_CRITERIA,
  CRITERION_COST,
  DECISION_MAKER_RULE_ID,
  DEFAULT_STAGE_DWELL_DAYS,
  MS_PER_DAY,
  STAGE_CRITERIA,
  cheapnessOf,
  criteriaFor,
  evaluateTransition,
  formatDay,
  laneLabel,
  readTrace,
  readiness,
  resolvePipelineConfig,
  transitionForLane,
} from 'src/pipeline/criteria';
export {
  DECISION_BLOCKED,
  DECISION_GATE,
  DECISION_PASS,
  DECISION_UNSCORED,
  deriveLane,
  deriveLanePlacement,
  isPersonDerivedLane,
  laneForStage,
  selectPrimaryOpportunity,
} from 'src/pipeline/lanes';
export {
  buildPipelineCard,
  nextAction,
} from 'src/pipeline/next-action';
export type {
  NextActionInput,
  PipelineAdvice,
} from 'src/pipeline/next-action';
export {
  ACTION_KINDS,
  PERSON_DERIVED_LANES,
  PIPELINE_ENGINE_VERSION,
  PIPELINE_LANES,
  PIPELINE_LANE_LABELS,
} from 'src/pipeline/types';
export type {
  ActionKind,
  Criterion,
  CriterionResult,
  CriterionSnapshot,
  CriterionStatus,
  LanePlacement,
  LeadSnapshot,
  OpportunitySnapshot,
  PipelineCard,
  PipelineConfig,
  PipelineConfigInput,
  PipelineLane,
  RankedAction,
  StageReadiness,
  TraceEntryView,
  TransitionId,
} from 'src/pipeline/types';
