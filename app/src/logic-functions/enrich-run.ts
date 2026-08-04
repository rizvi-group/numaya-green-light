/**
 * The enrichment composition root — Path 2's I/O shell.
 *
 * Same shape and the same reasoning as `licence-run.ts` and `scoring-run.ts`:
 * every decision is made in `src/enrichment/`, every provider arrives as a port,
 * and there is no `new Date()`, no `new CoreApiClient()` and no `twenty-sdk`
 * import below. That is what lets the whole of Path 2 — including a rate-limited
 * provider, a hostile search result and a model that answers without evidence —
 * be exercised in unit tests that never open a socket.
 *
 * ===========================================================================
 * ## The order of the checks, and why it is this order
 *
 * Every gate is arranged so that the *cheapest* refusal comes first and no money
 * is spent before every reason not to spend it has been considered:
 *
 *   1. Licence. A rules-only customer must never reach a provider, so this is
 *      first and it costs one key-value read that has already happened.
 *   2. The lead itself, then the config record.
 *   3. Gap analysis. Fields a human answered, fields still inside their shelf
 *      life, and fields a recent run already failed to find are all removed. If
 *      nothing is left, the run ends here — no search, no tokens, no counter.
 *   4. Both providers are *resolved* before either is *called*. Resolving search
 *      after paying for a reasoning call, or vice versa, would mean a workspace
 *      with half a configuration spends money on a run that cannot finish.
 *   5. Circuit breakers.
 *   6. The budget, charged immediately before the first external call.
 *
 * ## Fail-open, everywhere
 *
 * Every branch below either enriches or returns a `skipped` outcome with a
 * reason. Nothing here can throw out to the platform, nothing here writes to the
 * scoring fields, and nothing here can hold a lead: ARCHITECTURE.md's golden
 * rule is that a lead is never blocked, and enrichment is the optional half of
 * the product. Provider down, rate-limited, cap hit, no licence, no AI, hostile
 * page — all of them are a log line and a normal return.
 *
 * ## What is *not* written
 *
 * The customer's own columns. Not one of them, ever, on this path. See
 * `src/enrichment/provenance.ts` for the argument; the short version is that an
 * enriched value in a human's column is neither distinguishable from human data
 * nor safely reversible.
 * ===========================================================================
 */

import {
  assessBudget,
  buildEnrichmentPayload,
  buildEnrichmentRunId,
  buildEvidenceSet,
  buildExtractionInstruction,
  buildVerificationInstruction,
  buildVerificationPayload,
  effectiveTwentyAiAvailability,
  ENRICHABLE_FIELD_SPECS,
  enrichmentStatusFor,
  extractCandidates,
  inspectBreaker,
  parseModelJson,
  parseVerification,
  planEnrichment,
  readEnrichmentPayload,
  recordBreakerFailure,
  recordBreakerSuccess,
  resolveReasoningProvider,
  resolveSearchProvider,
  scoreConfidence,
  serialiseEvidence,
  describeBudgetAlert,
  type AcceptedField,
  type BreakerStates,
  type EnrichableFieldKey,
  type EnrichmentCandidate,
  type EnrichmentEnvironment,
  type EnrichmentPayload,
  type EnrichmentRunOutcome,
  type EnrichmentSkipReason,
  type EnrichmentStatusValue,
  type EnrichmentStorePort,
  type ProviderFailure,
  type ReasoningChoice,
  type ReasoningOutcome,
  type ReasoningPort,
  type ReasoningProviderName,
  type ReasoningTier,
  type SearchChoice,
  type SearchPort,
  type VerificationState,
} from 'src/enrichment';
import { describeEnrichmentGate } from 'src/licensing/feature-gate';
import type { LicenceState } from 'src/licensing/types';
import {
  describeError,
  isPlainRecord,
  logGreenlight,
  oldestByCreatedAt,
  readConnectionNodes,
  type GreenlightApiClient,
} from 'src/logic-functions/greenlight-api';
import { greenlightConfigSelection } from 'src/logic-functions/greenlight-config-record';

/* -------------------------------------------------------------------------- */
/* Tuning                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * How many search results reach the model.
 *
 * Five. Enough that a company with a thin web presence still has a chance, few
 * enough that one attacker-controlled page cannot flood the context — and, since
 * every candidate must be substantiated against the single page it cites,
 * additional pages buy coverage rather than consensus. More would cost tokens
 * linearly for a benefit that flattens immediately.
 */
export const MAX_EVIDENCE_DOCUMENTS = 5;

/** Enough for five short field values with quotes; far too little for an essay. */
const EXTRACTION_MAX_OUTPUT_TOKENS = 900;
const VERIFICATION_MAX_OUTPUT_TOKENS = 300;

/** Breaker keys. Namespaced so `brave` and `twenty-ai` cannot collide. */
const searchBreakerKey = (provider: string): string => `search:${provider}`;
const reasoningBreakerKey = (provider: string): string => `reasoning:${provider}`;

/* -------------------------------------------------------------------------- */
/* Ports supplied by the shell                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Provider construction is injected rather than imported.
 *
 * The adapters (`enrich-search-client.ts`, `enrich-reasoning-client.ts`) are the
 * only modules that touch `fetch` or the SDK; this module never names them. That
 * is the seam a test drives, and it is also what makes the Twenty-AI fallback
 * expressible — the run re-resolves and asks the factory for a *different*
 * provider mid-run, which it could not do if the provider were a constructor
 * argument.
 */
export type ReasoningFactory = (choice: ReasoningChoice) => ReasoningPort | null;
export type SearchFactory = (choice: SearchChoice) => SearchPort | null;

export interface EnrichmentRunDeps {
  readonly client: GreenlightApiClient;
  readonly store: EnrichmentStorePort;
  readonly environment: EnrichmentEnvironment;
  readonly createReasoning: ReasoningFactory;
  readonly createSearch: SearchFactory;
  /** The published licence state. `null` means no check has ever completed. */
  readonly licence: LicenceState | null;
  readonly now: Date;
}

export interface EnrichLeadInput {
  readonly leadRecordId: string;
  /** The record from the event payload, when there is one. Read from the API otherwise. */
  readonly lead?: Record<string, unknown> | null;
  /** An admin pressed the button: ignore freshness, honour everything else. */
  readonly force?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

const skip = (
  leadRecordId: string | null,
  reason: EnrichmentSkipReason,
  detail?: string,
): EnrichmentRunOutcome => ({ status: 'skipped', reason, leadRecordId, detail });

/**
 * The narrowest selection the run can work from.
 *
 * `jobTitle` is here because it is both an enrichable field and a human-held
 * one — the gap analysis has to see whether a person already answered it before
 * deciding to ask. `companyId` is here so `hydrateCompany` can fetch the name,
 * which is the search subject. Nothing else on the Person is read, which keeps
 * the data-egress table honest: what leaves the instance on this path is a
 * company name, a person's name and a job title, and there is no field in this
 * selection that could carry an email address or a phone number to a provider.
 */
const PERSON_ENRICHMENT_SELECTION = {
  id: true,
  name: { firstName: true, lastName: true },
  jobTitle: true,
  companyId: true,
  greenlightEnrichment: true,
  greenlightEnrichedAt: true,
  greenlightEnrichmentStatus: true,
} as const;

const loadPerson = async (
  client: GreenlightApiClient,
  leadRecordId: string,
): Promise<Record<string, unknown> | null> => {
  const response = await client.query({
    people: {
      __args: { filter: { id: { eq: leadRecordId } } },
      edges: { node: PERSON_ENRICHMENT_SELECTION },
    },
  });

  const [person] = readConnectionNodes(response, 'people');

  return person ?? null;
};

/**
 * Company hydration, for the same reason `scoring-run.ts` does it: the event
 * payload carries the foreign key, not the name, and "which company" is the
 * whole search subject. A failure here is not fatal — the run falls back to
 * searching on the person's name, which is worse but not nothing.
 */
const hydrateCompany = async (
  client: GreenlightApiClient,
  person: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const companyId = person['companyId'];

  if (typeof companyId !== 'string' || companyId.length === 0) {
    return person;
  }

  if (isPlainRecord(person['company'])) {
    return person;
  }

  try {
    const response = await client.query({
      companies: {
        __args: { filter: { id: { eq: companyId } } },
        edges: { node: { id: true, name: true } },
      },
    });

    const [company] = readConnectionNodes(response, 'companies');

    return company === undefined ? person : { ...person, company };
  } catch (error) {
    logGreenlight('enrichment_company_hydration_failed', {
      companyId,
      error: describeError(error),
    });

    return person;
  }
};

const loadConfig = async (
  client: GreenlightApiClient,
): Promise<Record<string, unknown> | null> => {
  try {
    const response = await client.query({
      greenlightConfigs: { edges: { node: greenlightConfigSelection() } },
    });

    return oldestByCreatedAt(readConnectionNodes(response, 'greenlightConfigs'));
  } catch (error) {
    logGreenlight('enrichment_config_read_failed', { error: describeError(error) });

    return null;
  }
};

const readShelfLife = (
  config: Record<string, unknown> | null,
): { defaultDays: number; perField: Record<string, number> } => {
  const raw = config?.['defaultShelfLifeDays'];
  const defaultDays =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 30;

  const perFieldRaw = config?.['fieldShelfLives'];
  const perField: Record<string, number> = {};

  if (isPlainRecord(perFieldRaw)) {
    for (const [key, value] of Object.entries(perFieldRaw)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        perField[key] = value;
      }
    }
  }

  return { defaultDays, perField };
};

/**
 * Write the three Greenlight-owned columns.
 *
 * Best-effort by design at the call sites that use it for a *status only*: an
 * enrichment that could not record that it was capped is still an enrichment
 * that was capped, and failing the run over it would convert a write blip into a
 * retried provider call, which is the opposite of what a cap is for.
 *
 * None of these three names is on this function's own trigger allow-list, which
 * carries `greenlightDecision` alone, so this write can never wake another
 * enrichment run.
 *
 * It *does* wake the scorer: `greenlightEnrichment` is on
 * `SCORING_TRIGGER_PERSON_FIELDS` because the resolved field mapping reads
 * enriched values, so an enriched lead is re-scored immediately rather than on
 * its next unrelated edit. That cycle is bounded at two hops — the scorer writes
 * only when the outcome actually changed, and a woken enrichment run finds no
 * gaps and returns without writing. The argument is spelled out on
 * `enrich-lead.logic-function.ts` and driven end to end by
 * `__tests__/enrich-score-cycle.test.ts`.
 */
const writeEnrichmentFields = async (
  client: GreenlightApiClient,
  leadRecordId: string,
  data: Record<string, unknown>,
): Promise<boolean> => {
  try {
    await client.mutation({
      updatePerson: { __args: { id: leadRecordId, data }, id: true },
    });

    return true;
  } catch (error) {
    logGreenlight('enrichment_write_failed', {
      leadRecordId,
      error: describeError(error),
    });

    return false;
  }
};

const writeStatusOnly = async (
  client: GreenlightApiClient,
  leadRecordId: string,
  status: EnrichmentStatusValue,
): Promise<void> => {
  await writeEnrichmentFields(client, leadRecordId, {
    greenlightEnrichmentStatus: status,
  });
};

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

export const runLeadEnrichment = async (
  deps: EnrichmentRunDeps,
  input: EnrichLeadInput,
): Promise<EnrichmentRunOutcome> => {
  const { leadRecordId } = input;
  const force = input.force === true;

  try {
    /* 1 — licence ------------------------------------------------------- */

    const gate = describeEnrichmentGate(deps.licence);

    if (!gate.enabled) {
      // Deliberately writes nothing. A rules-only workspace would otherwise get
      // an UNLICENSED stamp on every lead it ever touches — one write per event,
      // forever, to say something that is true of the whole workspace and is
      // already visible on the licence panel.
      logGreenlight('enrichment_skipped', {
        leadRecordId,
        reason: 'licence_not_entitled',
        licenceMode: gate.mode,
        licenceReason: gate.reason,
      });

      return skip(leadRecordId, 'licence_not_entitled', gate.reason ?? undefined);
    }

    /* 2 — the lead ------------------------------------------------------ */

    const loaded =
      input.lead !== undefined && input.lead !== null
        ? input.lead
        : await loadPerson(deps.client, leadRecordId);

    if (loaded === null) {
      return skip(leadRecordId, 'lead_unreadable');
    }

    const person = await hydrateCompany(deps.client, loaded);
    const existing = readEnrichmentPayload(person['greenlightEnrichment']);

    /* 3 — gap analysis -------------------------------------------------- */

    const config = await loadConfig(deps.client);
    const shelfLife = readShelfLife(config);

    const plan = planEnrichment({
      lead: person,
      existing,
      defaultShelfLifeDays: shelfLife.defaultDays,
      fieldShelfLifeDays: shelfLife.perField,
      now: deps.now,
      force,
    });

    if (plan.requested.length === 0) {
      logGreenlight('enrichment_skipped', {
        leadRecordId,
        reason: 'no_gaps',
        humanHeld: plan.humanHeld.length,
        fresh: plan.fresh.length,
        recentlyUnresolved: plan.recentlyUnresolved.length,
      });

      return skip(leadRecordId, 'no_gaps');
    }

    if (plan.query === null) {
      return skip(leadRecordId, 'no_identity_to_search');
    }

    /* 4 — resolve both providers before calling either -------------------- */

    const searchChoice = resolveSearchProvider(deps.environment);

    if (searchChoice.kind === 'none') {
      logGreenlight('enrichment_skipped', {
        leadRecordId,
        reason: 'search_not_configured',
        detail: searchChoice.reason,
      });

      return skip(leadRecordId, 'search_not_configured', searchChoice.reason);
    }

    const search = deps.createSearch(searchChoice);

    if (search === null) {
      return skip(leadRecordId, 'search_not_configured', 'no_adapter');
    }

    const probe = await deps.store.readTwentyAiProbe();
    const availability = effectiveTwentyAiAvailability(probe, deps.now);
    const reasoningChoice = resolveReasoningProvider(deps.environment, availability);

    if (reasoningChoice.kind === 'none') {
      logGreenlight('enrichment_skipped', {
        leadRecordId,
        reason: 'reasoning_not_configured',
        detail: reasoningChoice.reason,
      });

      return skip(leadRecordId, 'reasoning_not_configured', reasoningChoice.reason);
    }

    /* 5 — circuit breakers ------------------------------------------------ */

    let breakers = await deps.store.readBreakers();
    const searchBreaker = inspectBreaker(
      breakers,
      searchBreakerKey(searchChoice.kind),
      deps.now,
    );

    if (searchBreaker.open) {
      logGreenlight('enrichment_skipped', {
        leadRecordId,
        reason: 'circuit_open',
        provider: searchChoice.kind,
        retryAt: searchBreaker.retryAt,
      });

      return skip(leadRecordId, 'circuit_open', `search:${searchChoice.kind}`);
    }

    /* 6 — the budget ------------------------------------------------------ */

    const budget = assessBudget(
      await deps.store.readBudget(),
      deps.environment.monthlyCap,
      deps.now,
    );

    if (!budget.allowed) {
      logGreenlight('enrichment_cap_exhausted', {
        leadRecordId,
        monthKey: budget.monthKey,
        cap: budget.cap,
        used: budget.used,
      });

      await writeStatusOnly(deps.client, leadRecordId, 'CAPPED');

      return skip(leadRecordId, 'cap_exhausted', `${budget.used}/${budget.cap}`);
    }

    // Charged *before* the call, not after. A run that spent a provider quota
    // and then died before recording it is a run the cap did not see, and a cap
    // that undercounts is not a cap. Over-counting one run in a crash is the
    // cheaper error by a wide margin.
    await deps.store.writeBudget(budget.next);

    const alert = describeBudgetAlert(budget);

    if (alert !== null) {
      logGreenlight('enrichment_budget_alert', {
        monthKey: budget.monthKey,
        percentUsed: budget.percentUsed,
        threshold: budget.newAlert,
        message: alert,
      });
    }

    /* 7 — search ---------------------------------------------------------- */

    const searchOutcome = await search.search({
      query: plan.query,
      maxResults: MAX_EVIDENCE_DOCUMENTS * 2,
    });

    if (searchOutcome.kind !== 'results') {
      breakers = recordBreakerFailure(
        breakers,
        searchBreakerKey(searchChoice.kind),
        toBreakerFailure(searchOutcome),
        deps.now,
      );
      await deps.store.writeBreakers(breakers);

      logGreenlight('enrichment_search_failed', {
        leadRecordId,
        provider: searchChoice.kind,
        failureKind: searchOutcome.kind,
      });

      return skip(leadRecordId, 'search_unavailable', searchOutcome.kind);
    }

    breakers = recordBreakerSuccess(breakers, searchBreakerKey(searchChoice.kind));

    /* 8 — sanitise and quarantine ----------------------------------------- */

    const evidence = buildEvidenceSet(searchOutcome.results, MAX_EVIDENCE_DOCUMENTS);

    if (evidence.quarantined.length > 0) {
      // Worth its own event key. A page that tried to talk to the model is a
      // security signal, and the URL is what an admin needs in order to see
      // whether it is targeting them specifically.
      logGreenlight('enrichment_injection_suspected', {
        leadRecordId,
        quarantined: evidence.quarantined.map((document) => ({
          url: document.url,
          markers: document.markers,
        })),
      });
    }

    if (evidence.documents.length === 0) {
      await persist(deps, leadRecordId, existing, {
        runId: buildEnrichmentRunId(leadRecordId, deps.now),
        accepted: [],
        requested: plan.requested,
        evidence,
        reasoningProvider: 'none',
        reasoningModel: '',
        searchProvider: searchChoice.kind,
        notes: notesFor(evidence.quarantined.length),
      });
      await deps.store.writeBreakers(breakers);

      return skip(leadRecordId, 'search_no_results');
    }

    /* 9 — extraction ------------------------------------------------------ */

    const specs = ENRICHABLE_FIELD_SPECS.filter((spec) =>
      plan.requested.includes(spec.key),
    );
    const instruction = buildExtractionInstruction(plan.subject, specs);
    const untrustedEvidence = serialiseEvidence(evidence.documents);

    const extraction = await callReasoning(deps, reasoningChoice, breakers, {
      tier: 'capable',
      instruction,
      untrustedEvidence,
      maxOutputTokens: EXTRACTION_MAX_OUTPUT_TOKENS,
    });

    breakers = extraction.breakers;
    await deps.store.writeBreakers(breakers);

    if (extraction.outcome.kind !== 'completed') {
      logGreenlight('enrichment_reasoning_failed', {
        leadRecordId,
        provider: extraction.provider,
        failureKind: extraction.outcome.kind,
      });

      return skip(
        leadRecordId,
        extraction.outcome.kind === 'not_configured'
          ? 'reasoning_not_configured'
          : 'reasoning_unavailable',
        extraction.outcome.kind,
      );
    }

    const parsedReply = parseModelJson(extraction.outcome.text);
    const { candidates, rejections } = extractCandidates(
      parsedReply,
      evidence.documents,
      plan.requested,
    );

    if (rejections.length > 0) {
      logGreenlight('enrichment_candidates_rejected', {
        leadRecordId,
        rejections: rejections.map((entry) => `${entry.key}:${entry.reason}`),
      });
    }

    /* 10 — verification (cheap tier) -------------------------------------- */

    const verified = await verify(deps, reasoningChoice, breakers, candidates);

    breakers = verified.breakers;
    await deps.store.writeBreakers(breakers);

    const accepted: AcceptedField[] = verified.accepted.map((entry) => ({
      key: entry.candidate.key,
      value: entry.candidate.value,
      parsedValue: entry.candidate.parsedValue,
      sourceUrl: entry.candidate.document.url,
      sourceTitle: entry.candidate.document.title,
      confidence: scoreConfidence(entry.candidate.claimedConfidence, entry.state),
      verification: entry.state,
    }));

    /* 11 — persist -------------------------------------------------------- */

    const runId = buildEnrichmentRunId(leadRecordId, deps.now);

    await persist(deps, leadRecordId, existing, {
      runId,
      accepted,
      requested: plan.requested,
      evidence,
      reasoningProvider: extraction.provider,
      reasoningModel: extraction.outcome.model,
      searchProvider: searchChoice.kind,
      notes: notesFor(evidence.quarantined.length),
    });

    logGreenlight('lead_enriched', {
      leadRecordId,
      runId,
      requested: plan.requested,
      written: accepted.map((field) => field.key),
      rejected: rejections.length,
      quarantined: evidence.quarantined.length,
      reasoningProvider: extraction.provider,
      searchProvider: searchChoice.kind,
      monthKey: budget.monthKey,
      used: budget.next.used,
      cap: budget.cap,
    });

    if (accepted.length === 0) {
      return skip(leadRecordId, 'no_supported_values');
    }

    return {
      status: 'enriched',
      leadRecordId,
      runId,
      fieldsWritten: accepted.map((field) => field.key),
      spend: budget.next.used,
    };
  } catch (error) {
    const message = describeError(error);

    logGreenlight('enrichment_failed', { leadRecordId, error: message });

    // Best-effort flag so a repeatedly failing lead is visible in the enriched
    // view rather than merely absent from it. Its own failure is swallowed: an
    // error handler that throws is how a logic function takes down a queue.
    await writeStatusOnly(deps.client, leadRecordId, 'FAILED');

    return { status: 'failed', leadRecordId, error: message };
  }
};

/* -------------------------------------------------------------------------- */
/* Reasoning, with the Twenty-AI fallback                                      */
/* -------------------------------------------------------------------------- */

interface ReasoningAttempt {
  readonly outcome: ReasoningOutcome;
  readonly provider: ReasoningProviderName;
  readonly breakers: BreakerStates;
}

interface ReasoningRequest {
  readonly tier: ReasoningTier;
  readonly instruction: string;
  readonly untrustedEvidence: string;
  readonly maxOutputTokens: number;
}

/**
 * Call the reasoning provider, learning about Twenty AI as we go.
 *
 * The fallback is the reason this is a function rather than three lines inline.
 * There is no way to ask a workspace whether it has AI configured — see
 * `src/enrichment/providers.ts` — so the first call *is* the question. When
 * Twenty answers "no model", three things happen in order: the verdict is cached
 * so the next lead does not re-ask, the resolver is re-run with Twenty AI
 * excluded, and the customer's own endpoint is tried **within the same run**.
 * Deferring the retry to the next event would mean a workspace that has
 * configured `LLM_*` correctly still gets nothing until something else happens
 * to that lead.
 *
 * Exactly one fallback hop. A second would be a retry loop wearing a different
 * name, and there is no third provider to reach.
 */
const callReasoning = async (
  deps: EnrichmentRunDeps,
  choice: ReasoningChoice,
  breakers: BreakerStates,
  request: ReasoningRequest,
): Promise<ReasoningAttempt> => {
  const attempt = await attemptReasoning(deps, choice, breakers, request);

  const shouldFallBack =
    attempt.provider === 'twenty-ai' &&
    attempt.outcome.kind === 'not_configured';

  if (!shouldFallBack) {
    return attempt;
  }

  await deps.store.writeTwentyAiProbe({
    availability: 'unavailable',
    checkedAt: deps.now.toISOString(),
    detail:
      attempt.outcome.kind === 'not_configured' ? attempt.outcome.detail : null,
  });

  const fallback = resolveReasoningProvider(
    deps.environment,
    'unavailable',
    'twenty-ai',
  );

  if (fallback.kind === 'none') {
    return attempt;
  }

  logGreenlight('enrichment_twenty_ai_unavailable', {
    fallbackTo: fallback.kind,
  });

  return attemptReasoning(deps, fallback, attempt.breakers, request);
};

const attemptReasoning = async (
  deps: EnrichmentRunDeps,
  choice: ReasoningChoice,
  breakers: BreakerStates,
  request: ReasoningRequest,
): Promise<ReasoningAttempt> => {
  if (choice.kind === 'none') {
    return {
      outcome: { kind: 'not_configured', detail: choice.reason },
      provider: 'none',
      breakers,
    };
  }

  const provider = choice.kind === 'twenty-ai' ? 'twenty-ai' : 'openai-compatible';
  const key = reasoningBreakerKey(provider);
  const verdict = inspectBreaker(breakers, key, deps.now);

  if (verdict.open) {
    return {
      outcome: {
        kind: 'service_unavailable',
        statusCode: 0,
      },
      provider,
      breakers,
    };
  }

  const port = deps.createReasoning(choice);

  if (port === null) {
    return {
      outcome: { kind: 'not_configured', detail: 'no_adapter' },
      provider,
      breakers,
    };
  }

  const outcome = await port.complete(request);

  if (outcome.kind === 'completed') {
    if (provider === 'twenty-ai') {
      await deps.store.writeTwentyAiProbe({
        availability: 'available',
        checkedAt: deps.now.toISOString(),
        detail: null,
      });
    }

    return { outcome, provider, breakers: recordBreakerSuccess(breakers, key) };
  }

  return {
    outcome,
    provider,
    breakers: recordBreakerFailure(breakers, key, toBreakerFailure(outcome), deps.now),
  };
};

const toBreakerFailure = (
  failure: ProviderFailure,
): { kind: ProviderFailure['kind']; retryAfterSeconds?: number | null } =>
  failure.kind === 'rate_limited'
    ? { kind: failure.kind, retryAfterSeconds: failure.retryAfterSeconds }
    : { kind: failure.kind };

/* -------------------------------------------------------------------------- */
/* Verification                                                                */
/* -------------------------------------------------------------------------- */

interface VerifiedCandidate {
  readonly candidate: EnrichmentCandidate;
  readonly state: VerificationState;
}

/**
 * The cheap tier's pass. Advisory in one direction only.
 *
 * A `false` **drops** the candidate. A missing or unreadable answer **keeps** it
 * at `unconfirmed`, with its confidence capped. The asymmetry is deliberate: the
 * candidate has already passed the deterministic substantiation check, which is
 * the check that actually establishes the value is on the page, so a verifier
 * that is merely unreachable must not be able to erase a sourced fact. It can
 * only ever *remove* trust, never add the trust that check already earned.
 */
const verify = async (
  deps: EnrichmentRunDeps,
  choice: ReasoningChoice,
  breakers: BreakerStates,
  candidates: readonly EnrichmentCandidate[],
): Promise<{
  accepted: readonly VerifiedCandidate[];
  breakers: BreakerStates;
}> => {
  if (candidates.length === 0) {
    return { accepted: [], breakers };
  }

  const items = candidates.map((candidate, index) => ({
    id: String(index + 1),
    key: candidate.key,
    value: candidate.value,
    snippet: `${candidate.document.title} ${candidate.document.snippet}`.trim(),
  }));

  const attempt = await attemptReasoning(deps, choice, breakers, {
    tier: 'cheap',
    instruction: buildVerificationInstruction(),
    untrustedEvidence: buildVerificationPayload(items),
    maxOutputTokens: VERIFICATION_MAX_OUTPUT_TOKENS,
  });

  if (attempt.outcome.kind !== 'completed') {
    return {
      accepted: candidates.map((candidate) => ({
        candidate,
        state: 'unconfirmed' as const,
      })),
      breakers: attempt.breakers,
    };
  }

  const verdicts = parseVerification(parseModelJson(attempt.outcome.text));

  const accepted: VerifiedCandidate[] = [];

  candidates.forEach((candidate, index) => {
    const verdict = verdicts.get(String(index + 1));

    if (verdict === false) {
      return;
    }

    accepted.push({
      candidate,
      state: verdict === true ? 'confirmed' : 'unconfirmed',
    });
  });

  return { accepted, breakers: attempt.breakers };
};

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

const notesFor = (quarantinedCount: number): readonly string[] =>
  quarantinedCount === 0
    ? []
    : [
        `${quarantinedCount} search result${quarantinedCount === 1 ? '' : 's'} were excluded because the page contained text addressed to the AI model rather than information about the company.`,
      ];

const persist = async (
  deps: EnrichmentRunDeps,
  leadRecordId: string,
  previous: EnrichmentPayload | null,
  input: Omit<
    Parameters<typeof buildEnrichmentPayload>[0],
    'now' | 'previous'
  >,
): Promise<void> => {
  const payload = buildEnrichmentPayload({
    ...input,
    now: deps.now,
    previous,
  });

  const written: readonly EnrichableFieldKey[] = input.accepted.map(
    (field) => field.key,
  );

  await writeEnrichmentFields(deps.client, leadRecordId, {
    greenlightEnrichment: payload,
    greenlightEnrichedAt: deps.now.toISOString(),
    greenlightEnrichmentStatus: enrichmentStatusFor({
      kind: 'enriched',
      fieldsWritten: written.length,
    }),
  });
};
