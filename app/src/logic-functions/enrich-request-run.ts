/**
 * The admin-requested enrichment run — ARCHITECTURE.md's second Path 2 trigger.
 *
 * Kept out of the `define*` file so the request handling, the validation and the
 * response shape can be exercised against fakes. SDK-free, `now` injected, never
 * throws.
 *
 * ## What "force" does and does not mean
 *
 * Pressing the button means "look again now". It sets `force`, which bypasses
 * exactly one thing: the shelf-life cache. It does **not** bypass
 *
 *   - the licence gate — a rules-only workspace has no button that reaches a
 *     provider, and a UI affordance is not an entitlement;
 *   - the monthly cap — a spend control that any user can step over is a
 *     suggestion;
 *   - the circuit breaker — a human retrying is exactly the traffic a breaker
 *     exists to absorb;
 *   - the human-value rule — "re-fetch this" and "overwrite what I typed" are
 *     different requests, and one button must not mean both.
 *
 * ## Why the response is verbose
 *
 * The panel that calls this is the only place a workspace ever finds out *why*
 * enrichment did nothing. "Skipped" alone would send an admin to the logs; the
 * reason code and the sentence are what let them fix it themselves — a cap to
 * raise, a licence to renew, a search provider to configure.
 */

import {
  readEnrichmentPayload,
  type EnrichmentPayload,
  type EnrichmentRunOutcome,
} from 'src/enrichment';
import {
  runLeadEnrichment,
  type EnrichmentRunDeps,
} from 'src/logic-functions/enrich-run';
import {
  describeError,
  isPlainRecord,
  logGreenlight,
  readConnectionNodes,
} from 'src/logic-functions/greenlight-api';

export interface EnrichRequestResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const badRequest = (message: string): EnrichRequestResult => ({
  status: 400,
  body: { ok: false, error: message },
});

/**
 * Human-readable explanations, keyed by the run's own skip reasons.
 *
 * Written for a CRM admin, not a developer — the same standard the scoring
 * engine's degradation messages are held to. Anything not listed falls back to
 * the reason code itself, which is ugly but never wrong.
 */
const SKIP_MESSAGES: Readonly<Record<string, string>> = {
  licence_not_entitled:
    'Enrichment is not included in this workspace’s Greenlight licence. Scoring is unaffected.',
  lead_unreadable: 'That record could not be read.',
  no_gaps:
    'Nothing to look up: every field Greenlight can enrich is either already filled in by your team or was checked recently.',
  cap_exhausted:
    'This workspace has used its monthly enrichment allowance. Enrichment resumes next month, or sooner if an admin raises MONTHLY_ENRICHMENT_CAP.',
  search_not_configured:
    'No web search provider is configured. Set SEARCH_PROVIDER and SEARCH_API_KEY in the app’s settings.',
  search_unavailable:
    'The search provider could not be reached. Greenlight will try again automatically.',
  search_no_results: 'The search returned nothing usable about this lead.',
  reasoning_not_configured:
    'No AI is available. Either enable AI in this Twenty workspace, or set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL in the app’s settings.',
  reasoning_unavailable:
    'The AI provider could not be reached. Greenlight will try again automatically.',
  circuit_open:
    'A provider is failing repeatedly, so Greenlight has paused calls to it for a few minutes.',
  no_supported_values:
    'Nothing could be sourced. Greenlight only records a value when it can point at the page that states it.',
  no_identity_to_search:
    'This record has neither a name nor a company, so there is nothing to search for.',
};

export const describeOutcome = (outcome: EnrichmentRunOutcome): string => {
  if (outcome.status === 'enriched') {
    const count = outcome.fieldsWritten.length;

    return count === 1
      ? 'Enriched 1 field. Open the Greenlight enrichment panel to see the source.'
      : `Enriched ${count} fields. Open the Greenlight enrichment panel to see the sources.`;
  }

  if (outcome.status === 'failed') {
    return 'Enrichment failed. The lead is unaffected and remains scored.';
  }

  return SKIP_MESSAGES[outcome.reason] ?? outcome.reason;
};

export interface EnrichRequestInput {
  readonly deps: EnrichmentRunDeps;
  /** The request body as delivered. Untyped on purpose. */
  readonly body: unknown;
}

export const runEnrichLeadRequest = async ({
  deps,
  body,
}: EnrichRequestInput): Promise<EnrichRequestResult> => {
  if (!isPlainRecord(body)) {
    return badRequest('A JSON body with a leadRecordId is required.');
  }

  const leadRecordId = body['leadRecordId'];

  if (typeof leadRecordId !== 'string' || leadRecordId.trim().length === 0) {
    return badRequest('leadRecordId is required.');
  }

  const id = leadRecordId.trim();
  const outcome = await runLeadEnrichment(deps, { leadRecordId: id, force: true });

  // 200 for every outcome, including the skips. A skip is a *successful*
  // answer to "should this lead be enriched right now" and the panel renders
  // its reason; returning 4xx would make a correctly-working fail-open path
  // look like a broken request in every network log the customer keeps.
  return {
    status: outcome.status === 'failed' ? 502 : 200,
    body: {
      ok: outcome.status !== 'failed',
      status: outcome.status,
      reason: outcome.status === 'skipped' ? outcome.reason : null,
      fieldsWritten:
        outcome.status === 'enriched' ? [...outcome.fieldsWritten] : [],
      message: describeOutcome(outcome),
      // Returned on every outcome, not only on a successful one. The panel is
      // where a human meets enriched data, and the most common outcome of
      // pressing the button is `no_gaps` — "everything is already known". A
      // response that showed nothing in that case would look like a failure and
      // would hide exactly the sourced values the panel exists to display.
      enrichment: await readCurrentEnrichment(deps, id),
    },
  };
};

/**
 * Re-read the provenance document after the run.
 *
 * One extra query, on a human-triggered path only, and it buys the panel the
 * one thing it cannot get anywhere else: the values *with their sources*. Read
 * back from the record rather than returned out of the run so that what the
 * panel shows is what was actually persisted — if the write silently failed,
 * the panel says "nothing", which is the truth.
 *
 * A failed read returns `null` and is logged. The enrichment already happened;
 * failing the request over a display read would report a successful run as a
 * server error.
 */
const readCurrentEnrichment = async (
  deps: EnrichmentRunDeps,
  leadRecordId: string,
): Promise<EnrichmentPayload | null> => {
  try {
    const response = await deps.client.query({
      people: {
        __args: { filter: { id: { eq: leadRecordId } } },
        edges: { node: { id: true, greenlightEnrichment: true } },
      },
    });

    const [person] = readConnectionNodes(response, 'people');

    return person === undefined
      ? null
      : readEnrichmentPayload(person['greenlightEnrichment']);
  } catch (error) {
    logGreenlight('enrichment_panel_read_failed', {
      leadRecordId,
      error: describeError(error),
    });

    return null;
  }
};
