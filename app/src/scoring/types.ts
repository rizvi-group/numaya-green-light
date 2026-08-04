/**
 * Numaya Greenlight — deterministic scoring engine types.
 *
 * This module is intentionally free of any Twenty SDK import, any network call,
 * any filesystem access and any clock read. Everything the engine needs arrives
 * through `scoreLead()`'s input, including `now`. That is what makes the whole
 * scoring path unit-testable in complete isolation.
 */

/** Bumped whenever a change alters the score a given lead would receive. */
export const SCORING_ENGINE_VERSION = '0.1.0';

/* -------------------------------------------------------------------------- */
/* Lead input                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A lead as the engine sees it: an opaque bag of field values plus an optional
 * record id used only for the trace. The engine never assumes a field name —
 * every read goes through the configured {@link FieldMapping}.
 */
export interface LeadRecord {
  readonly id?: string | null;
  readonly fields: Readonly<Record<string, unknown>>;
}

/**
 * Logical field keys. Rules only ever speak in these; the customer's actual
 * column names live in the config's field mapping.
 */
export type LeadFieldKey =
  | 'companyName'
  | 'industry'
  | 'region'
  | 'employeeCount'
  | 'contactName'
  | 'jobTitle'
  | 'seniority'
  | 'email'
  | 'phone'
  | 'lastVerifiedAt'
  /** Greenlight's own block-list flag. Its mapping is not customer-configurable. */
  | 'suppressed'
  /** Greenlight's own block-list reason code. Read for the explanation, not the verdict. */
  | 'suppressionReason'
  /** The *customer's* opt-out column(s), wherever the Layer 3 mapping points. */
  | 'optedOut';

export const LEAD_FIELD_KEYS: readonly LeadFieldKey[] = [
  'companyName',
  'industry',
  'region',
  'employeeCount',
  'contactName',
  'jobTitle',
  'seniority',
  'email',
  'phone',
  'lastVerifiedAt',
  'suppressed',
  'suppressionReason',
  'optedOut',
];

/**
 * One or more dotted paths into the lead record, tried in order. Multiple
 * candidates let a workspace keep a preferred field with sane fallbacks
 * (e.g. `lastVerifiedAt` → `updatedAt` → `createdAt`).
 */
export type FieldMapping = Readonly<
  Record<LeadFieldKey, readonly string[]>
>;

/** What a rule actually looked at, so the trace can show its working. */
export interface FieldObservation {
  readonly key: LeadFieldKey;
  /** The candidate path that produced a value, or null when none did. */
  readonly mappedTo: string | null;
  readonly candidates: readonly string[];
  readonly present: boolean;
  /** Human-readable rendering of the value, e.g. `Manufacturing` / `(not set)`. */
  readonly display: string;
}

/**
 * Field reader handed to every rule. All lookups are recorded so the trace
 * entry can name the exact fields consulted and the values seen.
 */
export interface FieldReader {
  text(key: LeadFieldKey): string | null;
  textList(key: LeadFieldKey): readonly string[];
  number(key: LeadFieldKey): number | null;
  date(key: LeadFieldKey): Date | null;
  /** True when any mapped candidate resolves truthy; null when none are set. */
  booleanAny(key: LeadFieldKey): boolean | null;
  observations(): readonly FieldObservation[];
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

export type RuleSeverity =
  /** A failure blocks the lead outright (compliance), whatever the score. */
  | 'blocking'
  /** A failure gates the lead even if the score clears the threshold. */
  | 'critical'
  | 'major'
  | 'minor'
  /** Reported in the trace but never contributes to the score. */
  | 'advisory';

export const RULE_SEVERITIES: readonly RuleSeverity[] = [
  'blocking',
  'critical',
  'major',
  'minor',
  'advisory',
];

export type RuleCategory = 'icp' | 'contact' | 'data-quality' | 'compliance';

export interface IcpSizeBand {
  readonly label: string;
  readonly minEmployees: number;
  /** `null` means unbounded. */
  readonly maxEmployees: number | null;
}

export interface IcpConfig {
  /** Empty list means "no opinion" — the matching rule reports not-applicable. */
  readonly industries: readonly string[];
  readonly regions: readonly string[];
  readonly sizeBands: readonly IcpSizeBand[];
}

export interface ScoringBand {
  readonly id: string;
  readonly label: string;
  /** Inclusive lower bound on the 0-100 score. */
  readonly minScore: number;
}

export interface RuleSetting {
  readonly enabled: boolean;
  readonly severity: RuleSeverity;
  /** Relative weight. Only meaningful against the other enabled rules. */
  readonly weight: number;
}

export interface ResolvedScoringConfig {
  readonly icp: IcpConfig;
  readonly rules: Readonly<Record<string, RuleSetting>>;
  /** Sorted high → low by `minScore`. */
  readonly bands: readonly ScoringBand[];
  /** Score at or above which a lead is approved. */
  readonly gateThreshold: number;
  readonly defaultShelfLifeDays: number;
  readonly fieldShelfLifeDays: Readonly<Partial<Record<LeadFieldKey, number>>>;
  /** Title keywords that indicate authority to buy. */
  readonly decisionMakerTitles: readonly string[];
  /** Title keywords that indicate influence but not authority (partial credit). */
  readonly influencerTitles: readonly string[];
  /** Mailbox local-parts that mean "shared inbox, nobody owns replies". */
  readonly roleInboxLocalParts: readonly string[];
  /** Values that mean "somebody typed something rather than nothing". */
  readonly placeholderValues: readonly string[];
  readonly fieldMapping: FieldMapping;
}

/** A deeply-optional config, i.e. whatever came out of the CRM config record. */
export type ScoringConfigInput = unknown;

/**
 * Vocabulary that replaces the shipped defaults as the *fall-back* for a
 * workspace that has not expressed its own opinion.
 *
 * Structurally identical to the calibration baseline in `src/calibration/`, and
 * deliberately declared here rather than imported from there: the engine must
 * not be able to tell where a baseline came from, and a `src/scoring/` import of
 * `src/calibration/` would invert a dependency direction that is load-bearing
 * (see `src/calibration/index.ts`). Every field is optional — an absent one
 * leaves the corresponding shipped default exactly as it is.
 *
 * It carries no weights, no thresholds and no rule identifiers, and there is no
 * field here through which one could be smuggled. The worst a baseline can do is
 * change which strings a rule matches.
 */
export interface ScoringVocabularyBaseline {
  readonly decisionMakerTitles?: readonly string[];
  readonly influencerTitles?: readonly string[];
  readonly roleInboxLocalParts?: readonly string[];
  readonly placeholderValues?: readonly string[];
  /** Canonical industry term → equivalent free-text variants. */
  readonly industrySynonyms?: Readonly<Record<string, readonly string[]>>;
}

/* -------------------------------------------------------------------------- */
/* Fail-open reporting                                                         */
/* -------------------------------------------------------------------------- */

export type DegradationCode =
  | 'config_missing'
  | 'config_malformed'
  | 'icp_malformed'
  | 'rules_malformed'
  | 'rule_setting_malformed'
  | 'weight_malformed'
  | 'severity_malformed'
  | 'bands_malformed'
  | 'gate_threshold_malformed'
  | 'shelf_life_malformed'
  | 'field_mapping_malformed'
  | 'title_list_malformed'
  | 'lead_malformed'
  | 'now_malformed'
  | 'rule_errored'
  | 'no_scorable_rules'
  | 'engine_errored';

/**
 * A recorded fall-back. Every degradation means the engine chose to keep going
 * with a safe default rather than fail — the product's core promise is that a
 * lead is never lost and never silently dropped.
 */
export interface Degradation {
  readonly code: DegradationCode;
  /** Written for a CRM admin, not a developer. */
  readonly message: string;
  readonly detail?: string;
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                       */
/* -------------------------------------------------------------------------- */

export type RuleOutcome =
  | 'pass'
  | 'partial'
  | 'fail'
  /** The rule has nothing to judge (e.g. the ICP list is empty). Not scored. */
  | 'not_applicable'
  /** Turned off in configuration. Not scored. */
  | 'skipped'
  /** The rule threw. Not scored — a broken rule never drags a lead down. */
  | 'errored';

export type RuleDetail = Readonly<
  Record<string, string | number | boolean | null | undefined>
>;

/** What a rule returns. `credit` defaults to 1 for pass and 0 for fail. */
export interface RuleVerdict {
  readonly outcome: 'pass' | 'partial' | 'fail' | 'not_applicable';
  /** 0-1. Required for `partial`; ignored elsewhere unless supplied. */
  readonly credit?: number;
  /** One sentence a salesperson understands. */
  readonly explanation: string;
  /** What to do about it, when there is something to do. */
  readonly remedy?: string;
  readonly detail?: RuleDetail;
}

export interface RuleContext {
  readonly lead: LeadRecord;
  readonly config: ResolvedScoringConfig;
  /** Null when the caller supplied an unusable `now`; time-based rules opt out. */
  readonly now: Date | null;
  readonly read: FieldReader;
}

/**
 * A single deterministic check. Adding a rule is a local change: write one of
 * these, add it to the catalogue array, done — defaults, config plumbing,
 * weighting, tracing and fail-open handling are all inherited.
 */
export interface ScoringRule {
  readonly id: string;
  /** Short label shown in the CRM, e.g. "Decision-maker". */
  readonly name: string;
  readonly category: RuleCategory;
  /** The question the rule answers, in the buyer's words. */
  readonly question: string;
  /** Why the rule exists. Published in the rule catalogue and shown in-app. */
  readonly why: string;
  readonly defaultEnabled: boolean;
  readonly defaultSeverity: RuleSeverity;
  readonly defaultWeight: number;
  readonly reads: readonly LeadFieldKey[];
  evaluate(context: RuleContext): RuleVerdict;
}

/* -------------------------------------------------------------------------- */
/* Result                                                                      */
/* -------------------------------------------------------------------------- */

export type GateDecision =
  /** Cleared to work. */
  | 'approved'
  /** Held in the greenlight queue: visible, explained, human-overridable. */
  | 'gated'
  /** Compliance stop (e.g. opted out). Still visible and overridable. */
  | 'blocked'
  /** Nothing could be scored. Fail-open: the lead passes through, flagged. */
  | 'unscored';

export interface RuleTraceEntry {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly category: RuleCategory;
  readonly question: string;
  readonly outcome: RuleOutcome;
  readonly severity: RuleSeverity;
  /** 0-1 share of this rule's weight that the lead earned. */
  readonly credit: number;
  readonly weight: number;
  readonly pointsEarned: number;
  readonly pointsPossible: number;
  /** False for skipped / not-applicable / errored / advisory rules. */
  readonly contributed: boolean;
  readonly explanation: string;
  readonly remedy?: string;
  readonly detail?: RuleDetail;
  readonly observations: readonly FieldObservation[];
  readonly error?: string;
}

export interface ScoringResult {
  /** 0-100, rounded to one decimal. Null only when nothing was scorable. */
  readonly score: number | null;
  readonly band: ScoringBand | null;
  readonly decision: GateDecision;
  readonly gateThreshold: number;
  /** One sentence for the top of the lead record. */
  readonly summary: string;
  /** The headline reasons behind the decision, worst first. */
  readonly reasons: readonly string[];
  readonly trace: readonly RuleTraceEntry[];
  readonly degradations: readonly Degradation[];
  readonly configSource: ConfigSource;
  /** ISO timestamp of the `now` that was passed in. */
  readonly scoredAt: string | null;
  readonly leadId: string | null;
  readonly engineVersion: string;
  readonly totalWeight: number;
  readonly earnedWeight: number;
}

export type ConfigSource = 'provided' | 'defaults' | 'repaired';

export interface ConfigResolution {
  readonly config: ResolvedScoringConfig;
  readonly source: ConfigSource;
  readonly degradations: readonly Degradation[];
}

export interface ScoreLeadInput {
  readonly lead: LeadRecord;
  /**
   * The clock, passed in. The engine never reads the clock itself, so every
   * run is reproducible from its inputs alone.
   */
  readonly now: Date;
  /** Raw config record straight from the CRM. Anything unusable is repaired. */
  readonly config?: ScoringConfigInput;
  /** Override the rule catalogue (tests, future per-workspace rule packs). */
  readonly rules?: readonly ScoringRule[];
  /**
   * Licence-delivered vocabulary, if any. Absent — which is the unlicensed,
   * offline and signature-failing case — scores identically to a build that
   * never had this parameter.
   */
  readonly baseline?: ScoringVocabularyBaseline | null;
}

/** Public documentation shape for the rule catalogue (docs + in-app help). */
export interface RuleCatalogueEntry {
  readonly id: string;
  readonly name: string;
  readonly category: RuleCategory;
  readonly question: string;
  readonly why: string;
  readonly reads: readonly LeadFieldKey[];
  readonly defaultEnabled: boolean;
  readonly defaultSeverity: RuleSeverity;
  readonly defaultWeight: number;
}
