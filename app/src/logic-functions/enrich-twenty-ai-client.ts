/**
 * The Twenty-native reasoning adapter — the default path, and the reason most
 * customers need no LLM configuration at all.
 *
 * ===========================================================================
 * ## What was found, and where
 *
 * ARCHITECTURE.md asks for "Twenty's AI integration" without saying how an app
 * reaches it. It is reachable, and this is the evidence, taken from the
 * installed SDK rather than from the documentation:
 *
 * `node_modules/twenty-sdk/dist/logic-function/index.d.ts`
 * ```ts
 *   declare const runAgent: (input: {
 *     agentUniversalIdentifier: string;
 *     prompt: string;
 *   }) => Promise<{ result: object | null; error: string | null; success: boolean }>;
 * ```
 *
 * and in the built bundle (`dist/logic-function/index.mjs`) it is a GraphQL
 * mutation issued against the host instance with the app's own access token:
 * ```
 *   mutation RunAgent($input: RunAgentInput!) {
 *     runAgent(input: $input) { result error success }
 *   }
 * ```
 *
 * So: declare an agent with `defineAgent` (`src/agents/`), then call `runAgent`
 * with its identifier. The model, the vendor and the API key are all the
 * workspace's own; nothing about them appears in this app, and no key of ours is
 * involved. The data-egress table is unchanged by this path — the lead fields
 * and search results go to whatever provider the *customer* has already
 * configured inside their own Twenty instance.
 *
 * ## The three things this adapter has to paper over
 *
 * 1. **No capability query.** There is no way to ask whether a workspace has AI
 *    configured; `runAgent` failing is the only signal. `classifyAgentError`
 *    below is what turns that signal into `not_configured`, which is what makes
 *    the fallback in `enrich-run.ts` fire and the probe cache remember.
 *
 * 2. **`result` is typed `object | null` and its shape is undocumented.**
 *    `readAgentText` therefore tries the plausible keys and falls back to
 *    serialising the object, because a JSON object is exactly what the prompt
 *    asked for and `parseModelJson` will read it either way. A shape we cannot
 *    read at all becomes `malformed_response`, which skips the lead.
 *
 * 3. **Agents are alpha.** Every failure mode of an alpha API lands in one of
 *    the arms of `ProviderFailure`, walks the breaker, and ends in a skipped
 *    lead. There is no path from this file to a scoring decision.
 *
 * ## Tier routing
 *
 * The tier selects the *agent*, and the agent carries the model. That is the
 * only place in the product where PRODUCT_SPEC's "cheap for verification,
 * capable for briefings" is fully expressible — see
 * `src/constants/enrichment-identifiers.ts`.
 *
 * ## The prompt
 *
 * `runAgent` takes one string, so the two-message separation the
 * OpenAI-compatible adapter uses is not available here. The instruction and the
 * evidence are still kept apart by an explicit labelled fence, and the evidence
 * is still JSON with every quote escaped — so a snippet cannot terminate the
 * block it is inside. The other four injection layers (sanitisation,
 * quarantine, no capability, output validation) are unaffected by this
 * limitation, which is the point of there being five of them.
 * ===========================================================================
 */

import { runAgent } from 'twenty-sdk/logic-function';

import {
  ENRICHMENT_EXTRACTOR_AGENT_UNIVERSAL_IDENTIFIER,
  ENRICHMENT_VERIFIER_AGENT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/enrichment-identifiers';
import type {
  ProviderFailure,
  ReasoningOutcome,
  ReasoningPort,
  ReasoningTier,
} from 'src/enrichment';

/** Injected so tests never reach the platform. */
export type RunAgentLike = (input: {
  agentUniversalIdentifier: string;
  prompt: string;
}) => Promise<{
  result: object | null;
  error: string | null;
  success: boolean;
}>;

export interface TwentyAiClientOptions {
  readonly runAgentImpl?: RunAgentLike | null;
}

const UNTRUSTED_OPEN = '<<<UNTRUSTED_SEARCH_RESULTS_BEGIN>>>';
const UNTRUSTED_CLOSE = '<<<UNTRUSTED_SEARCH_RESULTS_END>>>';

/**
 * The single string `runAgent` accepts.
 *
 * The order matters: the instruction — including the sentence telling the model
 * that everything after the fence is data — comes first, so a model reading top
 * to bottom is warned before it meets the payload.
 */
export const buildAgentPrompt = (
  instruction: string,
  untrustedEvidence: string,
): string =>
  [
    instruction,
    '',
    UNTRUSTED_OPEN,
    untrustedEvidence,
    UNTRUSTED_CLOSE,
  ].join('\n');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Keys an agent runtime might plausibly put the answer under. */
const TEXT_KEYS = ['text', 'content', 'output', 'answer', 'message', 'result'];

/**
 * Get the model's reply out of `result`.
 *
 * Falls back to `JSON.stringify` rather than giving up: the prompt asks for a
 * JSON object, so a runtime that already parsed it into `result` has handed us
 * the answer in a different container, and re-serialising it is lossless for
 * this purpose. `parseModelJson` reads either form.
 */
export const readAgentText = (result: object | null): string | null => {
  if (result === null) {
    return null;
  }

  if (typeof result === 'string') {
    return result;
  }

  if (isRecord(result)) {
    for (const key of TEXT_KEYS) {
      const value = result[key];

      if (typeof value === 'string' && value.trim().length > 0) {
        return value;
      }
    }
  }

  try {
    return JSON.stringify(result);
  } catch {
    return null;
  }
};

/**
 * Turn an agent error string into a failure the run can act on.
 *
 * Matched on substrings because the platform gives us a message and not a code.
 * That is fragile in one direction only: a message we fail to recognise becomes
 * `service_unavailable`, which trips the breaker, skips the lead and retries
 * later — the same outcome as a genuine outage. The cost of a miss is therefore
 * that a workspace with no AI configured re-probes every six hours instead of
 * falling straight through to its own endpoint, which is a performance
 * annoyance rather than a correctness problem.
 */
export const classifyAgentError = (error: string | null): ProviderFailure => {
  const message = (error ?? '').toLowerCase();

  if (message.length === 0) {
    return { kind: 'service_unavailable', statusCode: 0 };
  }

  if (
    message.includes('no model') ||
    message.includes('model not') ||
    message.includes('not configured') ||
    message.includes('no ai') ||
    message.includes('ai is not') ||
    message.includes('missing api key') ||
    message.includes('no api key') ||
    message.includes('not found') ||
    message.includes('unknown agent') ||
    message.includes('agent does not exist')
  ) {
    return { kind: 'not_configured', detail: error ?? '' };
  }

  if (message.includes('rate limit') || message.includes('too many requests')) {
    return { kind: 'rate_limited', retryAfterSeconds: null };
  }

  if (message.includes('timeout') || message.includes('timed out')) {
    return { kind: 'transport_failure', detail: error ?? '' };
  }

  return { kind: 'service_unavailable', statusCode: 0 };
};

const agentFor = (tier: ReasoningTier): string =>
  tier === 'cheap'
    ? ENRICHMENT_VERIFIER_AGENT_UNIVERSAL_IDENTIFIER
    : ENRICHMENT_EXTRACTOR_AGENT_UNIVERSAL_IDENTIFIER;

export const createTwentyAiClient = (
  options: TwentyAiClientOptions = {},
): ReasoningPort => {
  const invoke = options.runAgentImpl ?? (runAgent as RunAgentLike);

  return {
    providerName: 'twenty-ai',

    complete: async ({ tier, instruction, untrustedEvidence }): Promise<ReasoningOutcome> => {
      let response: Awaited<ReturnType<RunAgentLike>>;

      try {
        response = await invoke({
          agentUniversalIdentifier: agentFor(tier),
          prompt: buildAgentPrompt(instruction, untrustedEvidence),
        });
      } catch (error) {
        // `runAgent` is not documented as never throwing, and it is an alpha
        // surface. A thrown error here would otherwise escape into the run's
        // outer catch and be reported as an enrichment *failure* rather than as
        // a provider being unavailable.
        return {
          kind: 'transport_failure',
          detail:
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : 'runAgent threw a non-Error',
        };
      }

      if (!response.success) {
        return classifyAgentError(response.error);
      }

      const text = readAgentText(response.result);

      if (text === null) {
        return {
          kind: 'malformed_response',
          detail: 'runAgent returned success with no readable result',
        };
      }

      // The model id is the workspace's business and is not returned to us.
      // Recording which agent answered is the honest substitute: it is what an
      // admin would look up in Twenty's settings to find the model.
      return {
        kind: 'completed',
        text,
        model: tier === 'cheap' ? 'twenty-agent:verifier' : 'twenty-agent:extractor',
      };
    },
  };
};
