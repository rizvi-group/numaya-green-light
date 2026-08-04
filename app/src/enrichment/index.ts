/**
 * Numaya Greenlight — enrichment core (Path 2).
 *
 * Nothing in this folder imports the Twenty SDK, opens a socket, or reads the
 * clock. Every provider is a port, every `now` is an argument, and every
 * decision — which fields to ask about, whether the budget allows it, whether a
 * provider may be called, whether a returned value may be believed — is a pure
 * function of its inputs.
 *
 * That is the same discipline as `src/scoring/`, and here it buys something
 * specific: the injection and hallucination defences are the parts of this
 * product most likely to be wrong, and they are testable exhaustively, offline,
 * against hostile inputs, because none of them needs a provider to run.
 *
 * The impure shell lives in `src/logic-functions/enrich-*.ts`.
 */

export {
  assessBudget,
  BUDGET_ALERT_THRESHOLDS,
  currentBudgetState,
  describeBudgetAlert,
  monthKeyOf,
  type BudgetAssessment,
} from 'src/enrichment/budget';
export {
  BREAKER_BASE_COOLDOWN_MS,
  BREAKER_FAILURE_THRESHOLD,
  BREAKER_MAX_COOLDOWN_MS,
  CLOSED_BREAKER,
  inspectBreaker,
  recordBreakerFailure,
  recordBreakerSuccess,
  toBreakerStates,
  type BreakerVerdict,
} from 'src/enrichment/circuit-breaker';
export {
  extractCandidates,
  isSubstantiated,
  normaliseForMatch,
  parseModelJson,
  parseVerification,
  scoreConfidence,
  type EnrichmentCandidate,
  type ExtractionResult,
  type Rejection,
  type RejectionReason,
} from 'src/enrichment/extract';
export {
  ENRICHABLE_FIELD_SPECS,
  ENRICHED_FIELD_MAPPING_PATHS,
  enrichedFieldMappingPath,
  findFieldSpec,
  isEnrichableFieldKey,
} from 'src/enrichment/field-specs';
export {
  buildSearchQuery,
  planEnrichment,
  readSubject,
  UNRESOLVED_RETRY_DAYS,
  type EnrichmentPlan,
  type EnrichmentPlanInput,
} from 'src/enrichment/plan';
export {
  buildExtractionInstruction,
  buildVerificationInstruction,
  buildVerificationPayload,
  PROMPT_VERSION,
  type ExtractionSubject,
} from 'src/enrichment/prompt';
export {
  effectiveTwentyAiAvailability,
  isTwentyAiProbeExpired,
  readEnrichmentEnvironment,
  resolveReasoningProvider,
  resolveSearchProvider,
  TWENTY_AI_PROBE_TTL_MS,
  type EnrichmentEnvironment,
  type ReasoningChoice,
  type ReasoningUnavailableReason,
  type SearchChoice,
} from 'src/enrichment/providers';
export {
  buildEnrichmentPayload,
  buildEnrichmentRunId,
  enrichmentStatusFor,
  readEnrichmentPayload,
  type AcceptedField,
  type BuildPayloadInput,
} from 'src/enrichment/provenance';
export {
  buildEvidenceSet,
  detectInjectionMarkers,
  MAX_SNIPPET_LENGTH,
  MAX_TITLE_LENGTH,
  sanitiseUntrustedText,
  serialiseEvidence,
  type EvidenceDocument,
  type EvidenceSet,
  type InjectionScan,
  type QuarantinedDocument,
} from 'src/enrichment/sanitise';
export {
  ENRICHABLE_FIELD_KEYS,
  ENRICHMENT_ENGINE_VERSION,
  type BreakerState,
  type BreakerStates,
  type EnrichableFieldKey,
  type EnrichableFieldSpec,
  type EnrichedFieldProvenance,
  type EnrichmentBudgetState,
  type EnrichmentPayload,
  type EnrichmentRunOutcome,
  type EnrichmentSkipReason,
  type EnrichmentSource,
  type EnrichmentStatusValue,
  type EnrichmentStorePort,
  type ProviderFailure,
  type ProviderFailureKind,
  type RawSearchResult,
  type ReasoningOutcome,
  type ReasoningPort,
  type ReasoningProviderName,
  type ReasoningTier,
  type SearchOutcome,
  type SearchPort,
  type SearchProviderName,
  type TwentyAiAvailability,
  type TwentyAiProbe,
  type VerificationState,
} from 'src/enrichment/types';
