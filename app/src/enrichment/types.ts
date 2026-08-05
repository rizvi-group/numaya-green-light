/**
 * Numaya Greenlight — enrichment core types.
 *
 * Same discipline as `src/scoring/types.ts`: no Twenty SDK import, no network,
 * no filesystem, no clock read. Everything the core needs arrives as an argument,
 * including `now` and including every provider, which is why the whole of Path 2
 * can be exercised without a socket.
 */

import type { LeadFieldKey } from 'src/scoring';

/** Bumped whenever a change alters what enrichment would write for a lead. */
export const ENRICHMENT_ENGINE_VERSION = '0.2.0';

/* -------------------------------------------------------------------------- */
/* What may be enriched                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The closed set of fields enrichment may produce.
 *
 * Typed as a subset of the scoring engine's own `LeadFieldKey` so the two
 * vocabularies cannot drift: if a key here stopped being a field the engine
 * understands, this file would not compile. That matters because the *point* of
 * enrichment is to make ICP scoring meaningful — a value the scorer has no key
 * for is a value nobody will ever score on.
 *
 * Deliberately excludes everything that is a contact detail or a compliance
 * flag. `email`, `phone`, `suppressed` and `optedOut` are not enrichable at any
 * price: a guessed email address gets sent to, and a guessed opt-out flag is
 * either a silent block or, far worse, a silent unblock. Enrichment fills in
 * *firmographics*, which are public facts about an organisation, and nothing
 * else. This list is the enforcement, not a convention — `extract.ts` drops any
 * key the model returns that is not on it.
 */
export type EnrichableFieldKey = Extract<
  LeadFieldKey,
  'industry' | 'region' | 'employeeCount' | 'jobTitle' | 'seniority'
>;

export const ENRICHABLE_FIELD_KEYS: readonly EnrichableFieldKey[] = [
  'industry',
  'region',
  'employeeCount',
  'jobTitle',
  'seniority',
];

/** What the model is told each key means, and what shape it must return. */
export interface EnrichableFieldSpec {
  readonly key: EnrichableFieldKey;
  readonly label: string;
  /** The question, in the words a person would use. */
  readonly question: string;
  readonly kind: 'text' | 'integer';
  /** Hard ceiling on the accepted value's length, post-trim. */
  readonly maxLength: number;
}

/* -------------------------------------------------------------------------- */
/* Provenance — what gets written                                              */
/* -------------------------------------------------------------------------- */

/**
 * One enriched value and everything needed to distrust it.
 *
 * PRODUCT_SPEC's hallucination mitigation is "no unsourced values; every
 * enriched field has source URL + date + confidence". All three are **required**
 * and non-nullable here, which is the point: there is no representable state in
 * which Greenlight holds an enriched value without knowing where it came from.
 * A candidate that cannot fill all three never becomes one of these.
 */
export interface EnrichedFieldProvenance {
  /** Canonical string form. Numbers are rendered, never stored as numbers. */
  readonly value: string;
  /** The parsed form the scorer reads. Integer for `employeeCount`. */
  readonly parsedValue: string | number;
  /** The page the value was read off. Always a document we fetched, never a model invention. */
  readonly sourceUrl: string;
  readonly sourceTitle: string;
  /** ISO-8601. The `now` of the run that wrote it. */
  readonly retrievedAt: string;
  /** 0-1, two decimals. See `scoreConfidence` for how it is earned. */
  readonly confidence: number;
  /** How the cited snippet was checked. */
  readonly verification: VerificationState;
  readonly reasoningProvider: ReasoningProviderName;
  readonly reasoningModel: string;
  readonly searchProvider: SearchProviderName;
  readonly engineVersion: string;
}

/**
 * `substantiated` — the value's tokens were found in the cited snippet, and
 *   that is the deterministic gate every value must pass.
 * `confirmed` — additionally confirmed by the cheap verification model.
 * `unconfirmed` — the verification call could not be made (breaker open,
 *   provider error). The value still passed the deterministic gate, and its
 *   confidence is capped to say so.
 */
export type VerificationState = 'substantiated' | 'confirmed' | 'unconfirmed';

/**
 * The blob written to `Person.greenlightEnrichment`.
 *
 * A wrapper rather than a bare map so the shape can be versioned and so a reader
 * can tell "no enrichment has ever run" from "enrichment ran and found nothing"
 * — the second is a legitimate, informative outcome and would otherwise be
 * indistinguishable from the first.
 */
export interface EnrichmentPayload {
  readonly version: 1;
  readonly runId: string;
  readonly runAt: string;
  readonly engineVersion: string;
  readonly fields: Readonly<Partial<Record<EnrichableFieldKey, EnrichedFieldProvenance>>>;
  /** Every source consulted this run, whether or not it produced a value. */
  readonly sources: readonly EnrichmentSource[];
  /** Field keys the run looked for and could not source. Prevents re-asking every event. */
  readonly unresolved: readonly EnrichableFieldKey[];
  readonly notes: readonly string[];
}

export interface EnrichmentSource {
  readonly url: string;
  readonly title: string;
  /** True when the page carried content aimed at the model. See `sanitise.ts`. */
  readonly quarantined: boolean;
}

/* -------------------------------------------------------------------------- */
/* Providers                                                                   */
/* -------------------------------------------------------------------------- */

export type ReasoningProviderName = 'twenty-ai' | 'openai-compatible' | 'none';

/**
 * `searxng` is a self-hosted metasearch instance the customer already runs, and
 * it is the only search option on this list that keeps the search half of
 * enrichment entirely inside their own infrastructure: no third-party account,
 * no API key, no per-query cost, and no query text leaving the estate. For a
 * product whose whole pitch is "runs inside your own Twenty", that is the
 * default worth recommending rather than a fallback — see the data-egress table
 * in ARCHITECTURE.md, where it is the one row that reads "none".
 */
export type SearchProviderName = 'brave' | 'serper' | 'searxng' | 'none';

/**
 * The two tiers PRODUCT_SPEC's cost control asks for.
 *
 * `capable` does the one job that needs judgement — reading five snippets and
 * proposing which of them answers which question. `cheap` does the yes/no
 * confirmation, which is the call made most often and is worth the least.
 */
export type ReasoningTier = 'capable' | 'cheap';

/**
 * A provider failure, in the same vocabulary `LicensingPort` uses.
 *
 * Deliberately identical in spirit to `LicenceCallFailure`: one discriminated
 * union, no thrown errors crossing the port boundary, and every arm something a
 * caller can act on. The circuit breaker branches on `kind`, so a shape that
 * collapsed "rate limited" into "failed" would cost the retry budget its only
 * useful signal.
 */
export type ProviderFailure =
  | { kind: 'not_configured'; detail: string }
  | { kind: 'rate_limited'; retryAfterSeconds: number | null }
  | { kind: 'service_unavailable'; statusCode: number }
  | { kind: 'unexpected_status'; statusCode: number }
  | { kind: 'malformed_response'; detail: string }
  | { kind: 'transport_failure'; detail: string };

export type ProviderFailureKind = ProviderFailure['kind'];

/** A single web result, before sanitisation. */
export interface RawSearchResult {
  readonly url: string;
  readonly title: string;
  readonly snippet: string;
}

export type SearchOutcome =
  | { kind: 'results'; results: readonly RawSearchResult[] }
  | ProviderFailure;

/**
 * The web-search capability, behind a port.
 *
 * One method, and it returns *data*. There is no variant of this interface that
 * can write to the CRM, which is half of the "no writes during extraction"
 * mitigation being a structural property rather than a review checklist item.
 */
export interface SearchPort {
  readonly providerName: SearchProviderName;
  search(input: {
    readonly query: string;
    readonly maxResults: number;
  }): Promise<SearchOutcome>;
}

export type ReasoningOutcome =
  | { kind: 'completed'; text: string; model: string }
  | ProviderFailure;

/**
 * The reasoning capability, behind a port.
 *
 * `instruction` is Greenlight's own text and is the only thing the model is told
 * to obey. `untrustedEvidence` is a JSON string of third-party page content and
 * is passed as a *separate* message by every adapter — see
 * `enrich-reasoning-client.ts`. Keeping them apart in the port's signature, not
 * merely in the prompt text, is what stops a future caller concatenating them
 * "for convenience" and silently removing the OWASP LLM01 mitigation.
 *
 * Like `SearchPort`, it returns text and nothing else. The model cannot call a
 * tool, cannot reach the API client, and cannot write a record, because nothing
 * behind this interface has any of those things to offer it.
 */
export interface ReasoningPort {
  readonly providerName: ReasoningProviderName;
  complete(input: {
    readonly tier: ReasoningTier;
    readonly instruction: string;
    readonly untrustedEvidence: string;
    readonly maxOutputTokens: number;
  }): Promise<ReasoningOutcome>;
}

/* -------------------------------------------------------------------------- */
/* Storage ports                                                               */
/* -------------------------------------------------------------------------- */

/** Per-workspace monthly spend, as persisted. */
export interface EnrichmentBudgetState {
  /** `YYYY-MM` of the month the counter belongs to. */
  readonly monthKey: string;
  readonly used: number;
  /** Highest alert threshold already announced this month, so it is announced once. */
  readonly alertedAt: number;
}

export interface BreakerState {
  readonly consecutiveFailures: number;
  /** ISO-8601 of when the breaker opened, or null when closed. */
  readonly openedAt: string | null;
  /** ISO-8601 the breaker may next be tried. Null when closed. */
  readonly retryAt: string | null;
  readonly lastFailureKind: ProviderFailureKind | null;
}

export type BreakerStates = Readonly<Record<string, BreakerState>>;

export type TwentyAiAvailability = 'unknown' | 'available' | 'unavailable';

export interface TwentyAiProbe {
  readonly availability: TwentyAiAvailability;
  /** ISO-8601. An `unavailable` verdict is re-probed after this. */
  readonly checkedAt: string | null;
  readonly detail: string | null;
}

/**
 * Everything enrichment persists, as one port.
 *
 * Reads are tolerant and writes are best-effort in the adapter, exactly like
 * `licence-cache-store.ts`. The one asymmetry worth knowing: a failed *budget*
 * write is treated as a spend that happened, because the alternative — retrying
 * because the counter did not move — is how a cap gets blown through.
 */
export interface EnrichmentStorePort {
  readBudget(): Promise<EnrichmentBudgetState | null>;
  writeBudget(state: EnrichmentBudgetState): Promise<void>;
  readBreakers(): Promise<BreakerStates>;
  writeBreakers(states: BreakerStates): Promise<void>;
  readTwentyAiProbe(): Promise<TwentyAiProbe>;
  writeTwentyAiProbe(probe: TwentyAiProbe): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Run outcome                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Why a run did not enrich. Every one of these is a *normal* outcome that leaves
 * the lead scored and visible — ARCHITECTURE.md's golden rule — and every one is
 * written to the trace so an admin can tell them apart.
 */
export type EnrichmentSkipReason =
  | 'licence_not_entitled'
  | 'lead_unreadable'
  | 'enrichment_disabled'
  | 'no_gaps'
  | 'cap_exhausted'
  | 'search_not_configured'
  | 'search_unavailable'
  | 'search_no_results'
  | 'reasoning_not_configured'
  | 'reasoning_unavailable'
  | 'circuit_open'
  | 'no_supported_values'
  | 'no_identity_to_search';

export type EnrichmentStatusValue =
  | 'NOT_RUN'
  | 'ENRICHED'
  | 'NOTHING_FOUND'
  | 'SKIPPED'
  | 'CAPPED'
  | 'UNLICENSED'
  | 'FAILED';

export type EnrichmentRunOutcome =
  | {
      status: 'skipped';
      reason: EnrichmentSkipReason;
      detail?: string;
      leadRecordId: string | null;
    }
  | {
      status: 'enriched';
      leadRecordId: string;
      runId: string;
      fieldsWritten: readonly EnrichableFieldKey[];
      spend: number;
    }
  | { status: 'failed'; leadRecordId: string | null; error: string };
