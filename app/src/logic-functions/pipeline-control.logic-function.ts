import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';
import { runAgent, Response, type RoutePayload } from 'twenty-sdk/logic-function';

import {
  PIPELINE_CONTROL_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
  PIPELINE_NEXT_ACTION_AGENT_UNIVERSAL_IDENTIFIER,
  PIPELINE_ROUTE_PATH,
} from 'src/constants/pipeline-identifiers';
import { readEnrichmentEnvironment } from 'src/enrichment';
import {
  createReasoningPort,
  createSearchPort,
} from 'src/logic-functions/enrich-adapters';
import { runLeadEnrichment } from 'src/logic-functions/enrich-run';
import { kvEnrichmentStore } from 'src/logic-functions/enrich-store';
import { readAgentText } from 'src/logic-functions/enrich-twenty-ai-client';
import { readPublishedLicenceState } from 'src/logic-functions/licence-cache-store';
import {
  parsePipelineRequest,
  runPipelineCommand,
  type NarrativePort,
} from 'src/logic-functions/pipeline-run';
import { kvReleaseMarkerStore } from 'src/logic-functions/release-marker-store';
import { runPersonScoring } from 'src/logic-functions/scoring-run';

/**
 * The pipeline board — one route, four actions, and no decisions of its own.
 *
 * A shell, like every other `define*` file in this folder. What a lane means,
 * what a card should do next and how far through a stage it is are all decided
 * in `src/pipeline/`, which is pure; the sequencing lives in `pipeline-run.ts`,
 * which takes ports; this file exists to hand over a real client, a real clock,
 * the authenticated actor and the three ports that reach the platform.
 *
 * ## Why one route and not four
 *
 * `wire.ts` makes the argument and it is the one `icp-control` and
 * `backfill-control` both arrived at: board, capture, advance and advise need
 * the same authentication, the same configuration read and the same schema
 * probe before any of them does anything, and four routes means four copies of
 * that preamble, three of which will eventually be missing a check the fourth
 * has.
 *
 * ## Identity
 *
 * `userWorkspaceId` comes off the authenticated request, so it is server-derived
 * and cannot be asserted by the caller — the same limitation and the same
 * reasoning as the release, suppression, backfill and ICP actions. It is what
 * lands in the audit row every move writes, so "who moved this deal to Proposal
 * with two criteria outstanding" has an answer.
 *
 * ## The three ports
 *
 *   - **enrich** is `runLeadEnrichment`, unchanged. PIPELINE_SPEC.md is explicit
 *     that the capture drawer is "orchestration, not new capability": step 3 of
 *     its chain is the enrichment run that already exists, with its own licence
 *     check, its own spend cap and its own circuit breaker, and reimplementing
 *     any of that here would produce a second set of rules to keep in step.
 *   - **score** is `runPersonScoring`, called with the envelope the platform
 *     would have delivered — the same trick `backfill-plan.ts:toScoringEvent`
 *     uses, so every guard, the release-marker pin, the audit row and the trace
 *     payload are the live path's and not a second implementation. Creating the
 *     Person also fires `score-person-created`; the outcome fingerprint makes
 *     whichever runs second a no-op, which is what that guard is for.
 *   - **narrative** is `runAgent` against this app's own wording agent. It
 *     returns null on any failure, because `applyNarrative` treats "no model" and
 *     "an unusable answer" identically and both mean *keep the deterministic
 *     sentence*.
 *
 * ## Licensing
 *
 * Nothing here is gated. `src/licensing/feature-gate.ts` is explicit that there
 * is no switch for the deterministic product, and the board, its lanes, its
 * readiness arithmetic and its next actions are all deterministic. The one part
 * that spends money is the narrative rewrite, and it is gated exactly where
 * enrichment already is — inside `runLeadEnrichment`, by the licence state read
 * below — so an unlicensed workspace gets the same correct board with Greenlight's
 * own wording on it. `licence_required` is therefore a code `wire.ts` declares
 * and this route never returns.
 *
 * ## Timeout
 *
 * Ninety seconds, against a worst case that is entirely one action: capture,
 * whose enrichment step inherits `enrich-lead`'s own 60-second budget (a 6-second
 * search plus two model calls capped at 20 each) and adds a configuration read, a
 * schema probe, two dedupe lookups, two inserts, a scoring pass and one read
 * back. The board's own worst case is 45 requests and no provider call at all.
 * Being killed costs one capture, and the Person it created is already on the
 * board — the chain writes the record before it spends anything.
 */

const actorFor = (event: RoutePayload): string =>
  event.userWorkspaceId === null || event.userWorkspaceId === undefined
    ? 'Unidentified workspace member'
    : `Workspace member ${event.userWorkspaceId}`;

/**
 * The wording agent, reduced to `prompt -> text | null`.
 *
 * Every failure mode collapses to null on purpose. `runAgent` is an alpha
 * surface and is not documented as never throwing; a workspace with no AI
 * configured is indistinguishable from an outage without a capability query
 * (see `classifyAgentError`); and none of those distinctions changes what the
 * board does, which is to keep the sentence the deterministic ranker wrote.
 */
const narrativePort: NarrativePort = async (prompt) => {
  try {
    const response = await runAgent({
      agentUniversalIdentifier: PIPELINE_NEXT_ACTION_AGENT_UNIVERSAL_IDENTIFIER,
      prompt,
    });

    return response.success ? readAgentText(response.result) : null;
  } catch {
    return null;
  }
};

const handler = async (event: RoutePayload) => {
  const parsed = parsePipelineRequest(event.body);

  if (!parsed.ok) {
    return new Response(
      { action: 'error', code: 'invalid_request', message: parsed.message },
      { status: 400 },
    );
  }

  const client = new CoreApiClient();
  const now = new Date();

  const outcome = await runPipelineCommand(parsed.request, {
    client,
    now,
    actor: actorFor(event),
    narrative: narrativePort,
    enrich: async (leadRecordId) => {
      await runLeadEnrichment(
        {
          client,
          store: kvEnrichmentStore,
          environment: readEnrichmentEnvironment(process.env),
          createReasoning: createReasoningPort,
          createSearch: createSearchPort,
          licence: await readPublishedLicenceState(),
          now,
        },
        { leadRecordId },
      );
    },
    score: async (leadRecordId, record) => {
      await runPersonScoring({
        client,
        event: { recordId: leadRecordId, properties: { after: record } },
        now,
        markers: kvReleaseMarkerStore,
      });
    },
  });

  return new Response(outcome.body, { status: outcome.status });
};

export default defineLogicFunction({
  universalIdentifier: PIPELINE_CONTROL_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
  name: 'greenlight-pipeline',
  description:
    'The Greenlight pipeline board: paints every lane and every next action in one call, captures a lead from three fields, moves a card between lanes (opening the deal when it crosses the handoff line), and recomputes the advice on a card or the whole board.',
  timeoutSeconds: 90,
  handler,
  httpRouteTriggerSettings: {
    path: PIPELINE_ROUTE_PATH,
    httpMethod: 'POST',
    isAuthRequired: true,
  },
});
