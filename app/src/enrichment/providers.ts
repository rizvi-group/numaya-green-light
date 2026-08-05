/**
 * Provider resolution — which reasoning engine and which search engine, decided
 * as a pure function of configuration.
 *
 * ===========================================================================
 * ## Reasoning: what Twenty actually exposes to an app
 *
 * ARCHITECTURE.md says "if `USE_TWENTY_AI=true` && the Twenty workspace has AI
 * configured → use Twenty's AI integration", and does not say how. The answer,
 * read out of the installed SDK rather than out of the docs:
 *
 * ```
 * node_modules/twenty-sdk/dist/logic-function/index.d.ts
 *
 *   type RunAgentInput  = { agentUniversalIdentifier: string; prompt: string };
 *   type RunAgentResult = { result: object | null; error: string | null;
 *                           success: boolean };
 *   declare const runAgent: (input: RunAgentInput) => Promise<RunAgentResult>;
 * ```
 *
 * and in the built bundle it is a GraphQL mutation against the host instance:
 *
 * ```
 *   mutation RunAgent($input: RunAgentInput!) {
 *     runAgent(input: $input) { result error success }
 *   }
 * ```
 *
 * So Twenty's native AI **is** reachable from a logic function. It is reached by
 * declaring an agent with `defineAgent` and invoking it by identifier; the model,
 * the key and the vendor are all the workspace's, and none of them appear in this
 * app. That is the property that matters commercially — the ARCHITECTURE.md line
 * "most customers should need no LLM setup at all" is achievable exactly because
 * this path exists.
 *
 * Two things the SDK does **not** give us, both of which shape the code below:
 *
 * 1. **There is no query for "does this workspace have AI configured".** No
 *    metadata field, no capability flag, nothing on `runAgent`'s input. The only
 *    way to find out is to call it and read `success` / `error`. Resolution is
 *    therefore *optimistic*: `unknown` resolves to Twenty AI and the run learns
 *    the answer, caching an `unavailable` verdict so the probe costs once per TTL
 *    rather than once per lead.
 *
 * 2. **`AgentManifest` is alpha.** PRODUCT_SPEC's open-questions table resolves
 *    "Use Skills/Agents (alpha API)?" with "No. Keep prompts in app source."
 *    Both halves are honoured: every prompt Greenlight sends is built in
 *    `src/enrichment/prompt.ts` and travels as the `prompt` argument, and the
 *    agent manifests carry only a one-line role description. The agent is a
 *    *model handle*, not a place we author behaviour. If the alpha surface
 *    changes, `runAgent` fails, the probe caches `unavailable`, and the run falls
 *    through to the customer's own endpoint or to no enrichment at all. Nothing
 *    about that path can stop a lead being scored.
 * ===========================================================================
 */

import type {
  ReasoningProviderName,
  SearchProviderName,
  TwentyAiAvailability,
} from 'src/enrichment/types';

/* -------------------------------------------------------------------------- */
/* Environment                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The Layer 1 application variables enrichment reads, normalised.
 *
 * Blank strings become `null` throughout. An admin who cleared a field and an
 * admin who never filled one in mean the same thing, and letting `''` survive
 * into the resolution below is how a provider ends up "configured" with an empty
 * API key.
 */
export interface EnrichmentEnvironment {
  readonly useTwentyAi: boolean;
  readonly llmBaseUrl: string | null;
  readonly llmApiKey: string | null;
  readonly llmModel: string | null;
  readonly searchProvider: SearchProviderName;
  readonly searchApiKey: string | null;
  /**
   * Only SearXNG uses this. Brave and Serper are hosted services at a fixed
   * endpoint; a self-hosted instance has no endpoint we could know, so the base
   * URL is to SearXNG what the API key is to the other two — the one piece of
   * configuration without which the provider cannot be addressed at all.
   */
  readonly searchBaseUrl: string | null;
  readonly monthlyCap: number;
}

const DEFAULT_MONTHLY_CAP = 1000;

const trimmedOrNull = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length === 0 ? null : trimmed;
};

/**
 * `USE_TWENTY_AI` ships as a BOOLEAN application variable and arrives as an
 * environment string. Everything that is not an explicit denial reads as true,
 * because the variable's declared default *is* true and a workspace whose value
 * failed to serialise should get the path that needs no configuration rather
 * than the one that needs an API key.
 */
const readBooleanDefaultTrue = (value: unknown): boolean => {
  const normalised = trimmedOrNull(value)?.toLowerCase() ?? null;

  if (normalised === null) {
    return true;
  }

  return !['false', '0', 'no', 'off'].includes(normalised);
};

const SEARCH_PROVIDER_NAMES: readonly SearchProviderName[] = [
  'brave',
  'serper',
  'searxng',
];

/**
 * Anything unrecognised is `none`, not an error.
 *
 * The value arrives from a SELECT application variable, so the only way to see a
 * name that is not on this list is an older or newer build of the app writing
 * into the same workspace. Resolving that to "no search" degrades enrichment to
 * rules-only scoring, which is a supported state; resolving it to a guess would
 * send the customer's queries somewhere they did not choose.
 */
const readSearchProvider = (value: unknown): SearchProviderName => {
  const normalised = trimmedOrNull(value)?.toLowerCase() ?? 'none';

  return SEARCH_PROVIDER_NAMES.includes(normalised as SearchProviderName)
    ? (normalised as SearchProviderName)
    : 'none';
};

/**
 * A cap of zero is a *choice* — "no enrichment this month" — and is honoured.
 * A negative or unparseable cap is not a choice, and falls back to the shipped
 * default rather than to unlimited: the failure direction on a spend control has
 * exactly one safe side.
 */
const readCap = (value: unknown): number => {
  const raw = trimmedOrNull(value);

  if (raw === null) {
    return DEFAULT_MONTHLY_CAP;
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_MONTHLY_CAP;
  }

  return Math.floor(parsed);
};

export const readEnrichmentEnvironment = (
  env: Record<string, string | undefined>,
): EnrichmentEnvironment => ({
  useTwentyAi: readBooleanDefaultTrue(env['USE_TWENTY_AI']),
  llmBaseUrl: trimmedOrNull(env['LLM_BASE_URL']),
  llmApiKey: trimmedOrNull(env['LLM_API_KEY']),
  llmModel: trimmedOrNull(env['LLM_MODEL']),
  searchProvider: readSearchProvider(env['SEARCH_PROVIDER']),
  searchApiKey: trimmedOrNull(env['SEARCH_API_KEY']),
  searchBaseUrl: trimmedOrNull(env['SEARCH_BASE_URL']),
  monthlyCap: readCap(env['MONTHLY_ENRICHMENT_CAP']),
});

/* -------------------------------------------------------------------------- */
/* Reasoning resolution                                                        */
/* -------------------------------------------------------------------------- */

export type ReasoningChoice =
  | { kind: 'twenty-ai' }
  | {
      kind: 'openai-compatible';
      baseUrl: string;
      apiKey: string;
      model: string;
    }
  | { kind: 'none'; reason: ReasoningUnavailableReason };

export type ReasoningUnavailableReason =
  /** Twenty AI switched off or unavailable, and no LLM_* variables set. */
  | 'no_provider_configured'
  /** Base URL and key present, model missing — an endpoint we cannot address. */
  | 'llm_model_missing'
  /** One of base URL / key present without the other. */
  | 'llm_partially_configured';

/**
 * The resolution order, in one place.
 *
 *   1. Twenty's own AI, when `USE_TWENTY_AI` is on and we have not learned that
 *      this workspace has none. `unknown` counts as "not learned otherwise" and
 *      resolves here — see the note at the top of this file on why optimism is
 *      the only option available.
 *   2. The customer's OpenAI-compatible endpoint, when all three of base URL,
 *      key and model are present.
 *   3. Nothing, with a reason precise enough to put in front of an admin.
 *
 * `fallbackFrom` exists for the one case the order above cannot express: Twenty
 * AI was chosen, was tried, and answered "no model configured" *within this
 * run*. Re-resolving with Twenty AI excluded is how the run recovers on the same
 * lead rather than on the next one, which matters because the next one may be a
 * month away on a small workspace.
 */
export const resolveReasoningProvider = (
  environment: EnrichmentEnvironment,
  twentyAiAvailability: TwentyAiAvailability,
  fallbackFrom: ReasoningProviderName | null = null,
): ReasoningChoice => {
  const twentyAiExcluded = fallbackFrom === 'twenty-ai';

  if (
    environment.useTwentyAi &&
    twentyAiAvailability !== 'unavailable' &&
    !twentyAiExcluded
  ) {
    return { kind: 'twenty-ai' };
  }

  const { llmBaseUrl, llmApiKey, llmModel } = environment;

  if (llmBaseUrl !== null && llmApiKey !== null) {
    if (llmModel === null) {
      return { kind: 'none', reason: 'llm_model_missing' };
    }

    return {
      kind: 'openai-compatible',
      baseUrl: llmBaseUrl,
      apiKey: llmApiKey,
      model: llmModel,
    };
  }

  if (llmBaseUrl !== null || llmApiKey !== null) {
    return { kind: 'none', reason: 'llm_partially_configured' };
  }

  return { kind: 'none', reason: 'no_provider_configured' };
};

/* -------------------------------------------------------------------------- */
/* Search resolution                                                           */
/* -------------------------------------------------------------------------- */

export type SearchChoice =
  | { kind: 'brave' | 'serper'; apiKey: string }
  | { kind: 'searxng'; baseUrl: string }
  | { kind: 'none'; reason: SearchUnavailableReason };

export type SearchUnavailableReason =
  /** `SEARCH_PROVIDER` is None — the shipped default, and a legitimate choice. */
  | 'not_selected'
  /** Brave or Serper selected with no `SEARCH_API_KEY`. */
  | 'api_key_missing'
  /** SearXNG selected with no `SEARCH_BASE_URL`. */
  | 'base_url_missing'
  /** `SEARCH_BASE_URL` is not an absolute http(s) URL. */
  | 'base_url_invalid';

/**
 * There is no fallback and no default: whichever provider the admin named is
 * the one that is used, or none is.
 *
 * The two hosted providers are the customer's own account under the customer's
 * own key. A provider selected without a key resolves to `none` with a reason
 * rather than being attempted, because an unauthenticated request is a
 * guaranteed `401` that would trip the circuit breaker and mask a genuine outage
 * later.
 *
 * SearXNG needs the mirror-image check. It has no key — a self-hosted instance
 * on the customer's own network is authenticated by being reachable at all — but
 * it does need an address, and an address is the thing a hosted provider never
 * needs. So `SEARCH_BASE_URL` is validated *here*, before a socket is opened,
 * for exactly the reason the key is: a request to a URL that is not a URL is a
 * thrown `TypeError` from `fetch`, which arrives as `transport_failure`, trips
 * the breaker, and tells an admin their SearXNG is down when in fact they typed
 * `localhost:8888` without a scheme. A configuration mistake has to present as a
 * configuration answer or nobody will ever find it.
 */
export const resolveSearchProvider = (
  environment: EnrichmentEnvironment,
): SearchChoice => {
  if (environment.searchProvider === 'none') {
    return { kind: 'none', reason: 'not_selected' };
  }

  if (environment.searchProvider === 'searxng') {
    if (environment.searchBaseUrl === null) {
      return { kind: 'none', reason: 'base_url_missing' };
    }

    const baseUrl = normaliseBaseUrl(environment.searchBaseUrl);

    if (baseUrl === null) {
      return { kind: 'none', reason: 'base_url_invalid' };
    }

    return { kind: 'searxng', baseUrl };
  }

  if (environment.searchApiKey === null) {
    return { kind: 'none', reason: 'api_key_missing' };
  }

  return {
    kind: environment.searchProvider,
    apiKey: environment.searchApiKey,
  };
};

/**
 * Accept an absolute `http`/`https` URL and return it without its trailing
 * slash; reject everything else.
 *
 * The trailing slash is stripped here rather than in the adapter so that the
 * adapter can append `/search` unconditionally and the value that reaches it is
 * already known-good. Non-HTTP schemes are refused rather than passed through:
 * `file:` and `data:` are both things `fetch` will happily accept, and a search
 * base URL is never either of them.
 */
const normaliseBaseUrl = (raw: string): string | null => {
  let parsed: URL;

  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }

  return raw.replace(/\/+$/, '');
};

/* -------------------------------------------------------------------------- */
/* Twenty AI probe TTL                                                         */
/* -------------------------------------------------------------------------- */

/**
 * How long an `unavailable` verdict is trusted before we try again.
 *
 * Six hours. Long enough that a workspace with no AI configured is not paying a
 * failed mutation on every scored lead, short enough that an admin who switches
 * AI on in Twenty's settings sees enrichment start working the same working day
 * without anyone telling them to reinstall the app.
 */
export const TWENTY_AI_PROBE_TTL_MS = 6 * 60 * 60 * 1000;

export const isTwentyAiProbeExpired = (
  checkedAt: string | null,
  now: Date,
): boolean => {
  if (checkedAt === null) {
    return true;
  }

  const at = Date.parse(checkedAt);

  if (!Number.isFinite(at)) {
    return true;
  }

  return now.getTime() - at >= TWENTY_AI_PROBE_TTL_MS;
};

/**
 * Fold a stored probe into the availability the resolver should use.
 * An expired `unavailable` becomes `unknown`, i.e. worth trying again.
 */
export const effectiveTwentyAiAvailability = (
  probe: { availability: TwentyAiAvailability; checkedAt: string | null },
  now: Date,
): TwentyAiAvailability => {
  if (probe.availability !== 'unavailable') {
    return probe.availability;
  }

  return isTwentyAiProbeExpired(probe.checkedAt, now) ? 'unknown' : 'unavailable';
};
