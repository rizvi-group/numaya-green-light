/**
 * Fakes for the enrichment run.
 *
 * Everything a real run touches is a port, so a test needs no network, no clock
 * and no workspace. What is deliberately *not* provided here is a way to make a
 * provider succeed by accident: `fakeSearch` and `fakeReasoning` both start
 * empty and record every call, so a test that expects "no provider was reached"
 * asserts on a count rather than on the absence of an error.
 */

import type {
  BreakerStates,
  EnrichmentBudgetState,
  EnrichmentEnvironment,
  EnrichmentStorePort,
  ReasoningOutcome,
  ReasoningPort,
  ReasoningTier,
  SearchOutcome,
  SearchPort,
  TwentyAiProbe,
} from 'src/enrichment';
import type { LicenceState } from 'src/licensing/types';

export const NOW = new Date('2026-08-03T09:00:00.000Z');

export const environment = (
  overrides: Partial<EnrichmentEnvironment> = {},
): EnrichmentEnvironment => ({
  useTwentyAi: true,
  llmBaseUrl: null,
  llmApiKey: null,
  llmModel: null,
  searchProvider: 'brave',
  searchApiKey: 'search-key',
  monthlyCap: 100,
  ...overrides,
});

/** A licence state that opens the gate. `mode: 'full'` is the only thing checked. */
export const licensed = (): LicenceState => ({
  mode: 'full',
  reason: 'licensed',
  source: 'live',
  severity: 'ok',
  maskedKey: 'NUMAYA-…-M',
  environment: 'production',
  checkedAt: NOW.toISOString(),
  cacheAgeMs: null,
  failureKind: null,
  observedValid: true,
  observedHasFeature: true,
  tier: 'Trial',
  daysRemaining: 30,
  expiryWarning: false,
  expiryAt: null,
  features: ['enrichment'],
});

export const rulesOnly = (): LicenceState => ({
  ...licensed(),
  mode: 'rules-only',
  reason: 'feature_not_licensed',
  observedHasFeature: false,
  features: [],
});

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

export interface FakeStore extends EnrichmentStorePort {
  budget: EnrichmentBudgetState | null;
  breakers: BreakerStates;
  probe: TwentyAiProbe;
  readonly budgetWrites: EnrichmentBudgetState[];
  readonly probeWrites: TwentyAiProbe[];
}

export const fakeStore = (
  seed: {
    budget?: EnrichmentBudgetState | null;
    breakers?: BreakerStates;
    probe?: TwentyAiProbe;
  } = {},
): FakeStore => {
  const budgetWrites: EnrichmentBudgetState[] = [];
  const probeWrites: TwentyAiProbe[] = [];

  const store: FakeStore = {
    budget: seed.budget ?? null,
    breakers: seed.breakers ?? {},
    probe: seed.probe ?? { availability: 'unknown', checkedAt: null, detail: null },
    budgetWrites,
    probeWrites,

    readBudget: async () => store.budget,
    writeBudget: async (state) => {
      store.budget = state;
      budgetWrites.push(state);
    },
    readBreakers: async () => store.breakers,
    writeBreakers: async (states) => {
      store.breakers = states;
    },
    readTwentyAiProbe: async () => store.probe,
    writeTwentyAiProbe: async (probe) => {
      store.probe = probe;
      probeWrites.push(probe);
    },
  };

  return store;
};

/* -------------------------------------------------------------------------- */
/* Providers                                                                   */
/* -------------------------------------------------------------------------- */

export interface FakeSearch extends SearchPort {
  readonly queries: string[];
}

export const fakeSearch = (outcome: SearchOutcome): FakeSearch => {
  const queries: string[] = [];

  return {
    providerName: 'brave',
    queries,
    search: async ({ query }) => {
      queries.push(query);

      return outcome;
    },
  };
};

export interface ReasoningCall {
  readonly tier: ReasoningTier;
  readonly instruction: string;
  readonly untrustedEvidence: string;
}

export interface FakeReasoning extends ReasoningPort {
  readonly calls: ReasoningCall[];
}

/**
 * A reasoning port driven by a per-tier script.
 *
 * Two tiers rather than one queue because the tests care *which* call failed:
 * an extraction failure skips the lead, whereas a verification failure must
 * leave every substantiated value in place at a capped confidence.
 */
export const fakeReasoning = (
  script: {
    capable?: ReasoningOutcome;
    cheap?: ReasoningOutcome;
    providerName?: 'twenty-ai' | 'openai-compatible';
  } = {},
): FakeReasoning => {
  const calls: ReasoningCall[] = [];

  return {
    providerName: script.providerName ?? 'twenty-ai',
    calls,
    complete: async ({ tier, instruction, untrustedEvidence }) => {
      calls.push({ tier, instruction, untrustedEvidence });

      const outcome = tier === 'cheap' ? script.cheap : script.capable;

      return (
        outcome ?? {
          kind: 'malformed_response',
          detail: 'no scripted outcome for this tier',
        }
      );
    },
  };
};

export const completed = (text: string, model = 'test-model'): ReasoningOutcome => ({
  kind: 'completed',
  text,
  model,
});

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

export const person = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: 'person-1',
  name: { firstName: 'Dana', lastName: 'Fry' },
  company: { name: 'Acme Pumps Ltd' },
  ...overrides,
});

export const searchResults = () => [
  {
    url: 'https://example.com/about',
    title: 'About Acme Pumps Ltd',
    snippet:
      'Acme Pumps Ltd is an industrial manufacturing business based in Leeds, United Kingdom, employing 240 people.',
  },
];

/** A model reply that cites the fixture above correctly. */
export const goodReply = JSON.stringify({
  fields: [
    {
      key: 'industry',
      value: 'industrial manufacturing',
      evidenceId: 'e1',
      quote: 'is an industrial manufacturing business',
      confidence: 0.9,
    },
  ],
});
