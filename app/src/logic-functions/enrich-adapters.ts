/**
 * Provider factories — the one place that turns a resolved `ReasoningChoice` or
 * `SearchChoice` into a live adapter.
 *
 * It exists so the two `define*` files stay three lines each and so
 * `enrich-run.ts` never names an adapter: the run asks a factory, the factory
 * decides, and a test passes a different factory. That indirection is what makes
 * the Twenty-AI fallback testable at all — the run re-resolves mid-flight and
 * asks for a *different* provider, which it could not do if the provider were
 * fixed at construction.
 *
 * Nothing here makes a decision. If a branch below ever grows an `if` about
 * configuration, it belongs in `src/enrichment/providers.ts` with the rest of
 * the resolution rules and the tests that cover them.
 */

import type {
  ReasoningChoice,
  ReasoningPort,
  SearchChoice,
  SearchPort,
} from 'src/enrichment';
import { createOpenAiCompatibleClient } from 'src/logic-functions/enrich-reasoning-client';
import { createSearchClient } from 'src/logic-functions/enrich-search-client';
import { createTwentyAiClient } from 'src/logic-functions/enrich-twenty-ai-client';

export const createReasoningPort = (
  choice: ReasoningChoice,
): ReasoningPort | null => {
  if (choice.kind === 'twenty-ai') {
    return createTwentyAiClient();
  }

  if (choice.kind === 'openai-compatible') {
    return createOpenAiCompatibleClient({
      baseUrl: choice.baseUrl,
      apiKey: choice.apiKey,
      model: choice.model,
    });
  }

  return null;
};

export const createSearchPort = (choice: SearchChoice): SearchPort | null => {
  if (choice.kind === 'none') {
    return null;
  }

  if (choice.kind === 'searxng') {
    return createSearchClient({ provider: 'searxng', baseUrl: choice.baseUrl });
  }

  return createSearchClient({ provider: choice.kind, apiKey: choice.apiKey });
};
