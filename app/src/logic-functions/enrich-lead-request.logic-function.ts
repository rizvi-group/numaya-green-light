import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';
import { Response, type RoutePayload } from 'twenty-sdk/logic-function';

import {
  ENRICH_LEAD_REQUEST_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
  ENRICH_LEAD_REQUEST_ROUTE_PATH,
} from 'src/constants/enrichment-identifiers';
import { readEnrichmentEnvironment } from 'src/enrichment';
import {
  createReasoningPort,
  createSearchPort,
} from 'src/logic-functions/enrich-adapters';
import { runEnrichLeadRequest } from 'src/logic-functions/enrich-request-run';
import { kvEnrichmentStore } from 'src/logic-functions/enrich-store';
import { readPublishedLicenceState } from 'src/logic-functions/licence-cache-store';

/**
 * "Enrich now (Greenlight)" — the admin-requested half of Path 2's trigger.
 *
 * A shell, like `suppress-lead.logic-function.ts`: the validation and the
 * response shape are in `enrich-request-run.ts`, the decisions are in
 * `src/enrichment/`, and this file hands over a real client, a real clock, real
 * providers and the published licence state.
 *
 * ## Why the button exists when the event trigger already covers it
 *
 * Three cases the event cannot reach. A lead scored before enrichment was
 * licensed, and nothing has changed it since. A lead whose fields went stale
 * without anyone touching the record — the event trigger fires on *changes*, and
 * going stale is not a change. And the one that matters most in practice: an
 * admin who has just configured a search provider and wants to see whether it
 * works, on a record of their choosing, without editing a lead to provoke it.
 *
 * ## What it does not let a user do
 *
 * Step over the licence, the monthly cap, the circuit breaker, or a value a
 * person typed. It bypasses the shelf-life cache and nothing else — see
 * `enrich-request-run.ts` for why each of those is not negotiable from a button.
 *
 * ## Auth
 *
 * `isAuthRequired: true`, and the enrichment write happens under the app's own
 * least-privilege role. The caller's identity is not used to decide anything
 * here: there is no per-user entitlement in this product, the licence is per
 * workspace, and pretending otherwise would be security theatre over a call that
 * spends a shared budget either way.
 */
const handler = async (event: RoutePayload) => {
  const result = await runEnrichLeadRequest({
    deps: {
      client: new CoreApiClient(),
      store: kvEnrichmentStore,
      environment: readEnrichmentEnvironment(process.env),
      createReasoning: createReasoningPort,
      createSearch: createSearchPort,
      licence: await readPublishedLicenceState(),
      now: new Date(),
    },
    body: event.body,
  });

  return new Response(result.body, { status: result.status });
};

export default defineLogicFunction({
  universalIdentifier: ENRICH_LEAD_REQUEST_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
  name: 'greenlight-enrich-lead-request',
  description:
    'Runs Greenlight enrichment against one lead on request, ignoring the freshness cache but honouring the licence, the monthly cap and every provider circuit breaker.',
  // Same budget as the event-triggered run: one search, two model calls, one
  // write. Failing fast beats holding a worker on a provider having a bad day.
  timeoutSeconds: 60,
  handler,
  httpRouteTriggerSettings: {
    path: ENRICH_LEAD_REQUEST_ROUTE_PATH,
    httpMethod: 'POST',
    isAuthRequired: true,
  },
});
