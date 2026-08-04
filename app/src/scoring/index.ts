/**
 * Numaya Greenlight — deterministic scoring library.
 *
 * Wiring this into a Twenty logic function is three lines:
 *
 * ```ts
 * import { scoreLead, toLeadRecord } from 'src/scoring';
 *
 * const result = scoreLead({
 *   lead: toLeadRecord(event.record),
 *   now: new Date(),          // the clock lives at the edge, never inside
 *   config: greenlightConfigRecord,  // raw; anything unusable is repaired
 * });
 *
 * // result.score / result.band / result.decision / result.trace
 * ```
 *
 * `scoreLead` never throws and always returns a result. Nothing in this folder
 * imports the Twenty SDK, touches the network, or reads the clock.
 */

export {
  buildDefaultConfig,
  expandIndustriesWithSynonyms,
  isSameStringSet,
  resolveConfig,
} from 'src/scoring/config';
export {
  DEFAULT_BANDS,
  DEFAULT_DECISION_MAKER_TITLES,
  DEFAULT_FIELD_MAPPING,
  DEFAULT_GATE_THRESHOLD,
  DEFAULT_ICP,
  DEFAULT_INFLUENCER_TITLES,
  DEFAULT_ROLE_INBOX_LOCAL_PARTS,
  DEFAULT_SHELF_LIFE_DAYS,
  PLACEHOLDER_VALUES,
} from 'src/scoring/defaults';
export { scoreLead } from 'src/scoring/engine';
export { toLeadRecord } from 'src/scoring/field-access';
export { ALL_RULES, describeRuleCatalogue } from 'src/scoring/rules';
export {
  LEAD_FIELD_KEYS,
  RULE_SEVERITIES,
  SCORING_ENGINE_VERSION,
} from 'src/scoring/types';
export type {
  ConfigResolution,
  ConfigSource,
  Degradation,
  DegradationCode,
  FieldMapping,
  FieldObservation,
  FieldReader,
  GateDecision,
  IcpConfig,
  IcpSizeBand,
  LeadFieldKey,
  LeadRecord,
  ResolvedScoringConfig,
  RuleCatalogueEntry,
  RuleCategory,
  RuleContext,
  RuleDetail,
  RuleOutcome,
  RuleSetting,
  RuleSeverity,
  RuleTraceEntry,
  RuleVerdict,
  ScoreLeadInput,
  ScoringBand,
  ScoringConfigInput,
  ScoringResult,
  ScoringRule,
  ScoringVocabularyBaseline,
} from 'src/scoring/types';
