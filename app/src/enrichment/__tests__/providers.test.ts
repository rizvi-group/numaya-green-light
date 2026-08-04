import {
  effectiveTwentyAiAvailability,
  readEnrichmentEnvironment,
  resolveReasoningProvider,
  resolveSearchProvider,
  TWENTY_AI_PROBE_TTL_MS,
  type EnrichmentEnvironment,
} from 'src/enrichment';
import { describe, expect, it } from 'vitest';

const baseEnvironment = (
  overrides: Partial<EnrichmentEnvironment> = {},
): EnrichmentEnvironment => ({
  useTwentyAi: true,
  llmBaseUrl: null,
  llmApiKey: null,
  llmModel: null,
  searchProvider: 'none',
  searchApiKey: null,
  monthlyCap: 1000,
  ...overrides,
});

describe('readEnrichmentEnvironment', () => {
  it('should default USE_TWENTY_AI to true when unset', () => {
    expect(readEnrichmentEnvironment({}).useTwentyAi).toBe(true);
  });

  it('should read only an explicit denial as false', () => {
    expect(readEnrichmentEnvironment({ USE_TWENTY_AI: 'false' }).useTwentyAi).toBe(
      false,
    );
    expect(readEnrichmentEnvironment({ USE_TWENTY_AI: '0' }).useTwentyAi).toBe(
      false,
    );
    expect(readEnrichmentEnvironment({ USE_TWENTY_AI: 'true' }).useTwentyAi).toBe(
      true,
    );
    // A value that failed to serialise must not silently disable the path that
    // needs no configuration.
    expect(readEnrichmentEnvironment({ USE_TWENTY_AI: 'yes' }).useTwentyAi).toBe(
      true,
    );
  });

  it('should turn blank strings into null', () => {
    const environment = readEnrichmentEnvironment({
      LLM_BASE_URL: '   ',
      LLM_API_KEY: '',
      SEARCH_API_KEY: '\t',
    });

    expect(environment.llmBaseUrl).toBeNull();
    expect(environment.llmApiKey).toBeNull();
    expect(environment.searchApiKey).toBeNull();
  });

  it('should only accept the two known search providers', () => {
    expect(readEnrichmentEnvironment({ SEARCH_PROVIDER: 'brave' }).searchProvider).toBe(
      'brave',
    );
    expect(readEnrichmentEnvironment({ SEARCH_PROVIDER: 'SERPER' }).searchProvider).toBe(
      'serper',
    );
    expect(readEnrichmentEnvironment({ SEARCH_PROVIDER: 'google' }).searchProvider).toBe(
      'none',
    );
    expect(readEnrichmentEnvironment({}).searchProvider).toBe('none');
  });

  it('should honour a cap of zero but fall back on nonsense', () => {
    expect(readEnrichmentEnvironment({ MONTHLY_ENRICHMENT_CAP: '0' }).monthlyCap).toBe(
      0,
    );
    expect(readEnrichmentEnvironment({ MONTHLY_ENRICHMENT_CAP: '250' }).monthlyCap).toBe(
      250,
    );
    expect(
      readEnrichmentEnvironment({ MONTHLY_ENRICHMENT_CAP: 'lots' }).monthlyCap,
    ).toBe(1000);
    expect(readEnrichmentEnvironment({ MONTHLY_ENRICHMENT_CAP: '-5' }).monthlyCap).toBe(
      1000,
    );
  });
});

describe('resolveReasoningProvider', () => {
  it('should prefer Twenty AI when it is on and not known to be unavailable', () => {
    const withLlm = baseEnvironment({
      llmBaseUrl: 'https://api.example.com/v1',
      llmApiKey: 'sk-test',
      llmModel: 'gpt-test',
    });

    expect(resolveReasoningProvider(withLlm, 'unknown')).toEqual({
      kind: 'twenty-ai',
    });
    expect(resolveReasoningProvider(withLlm, 'available')).toEqual({
      kind: 'twenty-ai',
    });
  });

  it('should fall through to the customer endpoint once Twenty AI is known unavailable', () => {
    const environment = baseEnvironment({
      llmBaseUrl: 'https://api.example.com/v1',
      llmApiKey: 'sk-test',
      llmModel: 'gpt-test',
    });

    expect(resolveReasoningProvider(environment, 'unavailable')).toEqual({
      kind: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-test',
    });
  });

  it('should fall through when Twenty AI is switched off', () => {
    const environment = baseEnvironment({
      useTwentyAi: false,
      llmBaseUrl: 'https://api.example.com/v1',
      llmApiKey: 'sk-test',
      llmModel: 'gpt-test',
    });

    expect(resolveReasoningProvider(environment, 'unknown').kind).toBe(
      'openai-compatible',
    );
  });

  it('should exclude Twenty AI when told to fall back from it mid-run', () => {
    const environment = baseEnvironment({
      llmBaseUrl: 'https://api.example.com/v1',
      llmApiKey: 'sk-test',
      llmModel: 'gpt-test',
    });

    expect(
      resolveReasoningProvider(environment, 'unknown', 'twenty-ai').kind,
    ).toBe('openai-compatible');
  });

  it('should resolve to none, with a reason, when nothing is configured', () => {
    expect(
      resolveReasoningProvider(baseEnvironment({ useTwentyAi: false }), 'unknown'),
    ).toEqual({ kind: 'none', reason: 'no_provider_configured' });
  });

  it('should refuse an endpoint it cannot address', () => {
    const environment = baseEnvironment({
      useTwentyAi: false,
      llmBaseUrl: 'https://api.example.com/v1',
      llmApiKey: 'sk-test',
      llmModel: null,
    });

    expect(resolveReasoningProvider(environment, 'unknown')).toEqual({
      kind: 'none',
      reason: 'llm_model_missing',
    });
  });

  it('should distinguish a half-configured endpoint from an absent one', () => {
    const environment = baseEnvironment({
      useTwentyAi: false,
      llmBaseUrl: 'https://api.example.com/v1',
    });

    expect(resolveReasoningProvider(environment, 'unknown')).toEqual({
      kind: 'none',
      reason: 'llm_partially_configured',
    });
  });
});

describe('resolveSearchProvider', () => {
  it('should resolve the selected provider with its key', () => {
    expect(
      resolveSearchProvider(
        baseEnvironment({ searchProvider: 'brave', searchApiKey: 'k' }),
      ),
    ).toEqual({ kind: 'brave', apiKey: 'k' });
  });

  it('should refuse rather than send an unauthenticated request', () => {
    expect(
      resolveSearchProvider(baseEnvironment({ searchProvider: 'serper' })),
    ).toEqual({ kind: 'none', reason: 'api_key_missing' });
  });

  it('should report an unselected provider distinctly', () => {
    expect(resolveSearchProvider(baseEnvironment())).toEqual({
      kind: 'none',
      reason: 'not_selected',
    });
  });
});

describe('effectiveTwentyAiAvailability', () => {
  const now = new Date('2026-08-03T12:00:00.000Z');

  it('should keep an unexpired unavailable verdict', () => {
    const checkedAt = new Date(now.getTime() - 60_000).toISOString();

    expect(
      effectiveTwentyAiAvailability({ availability: 'unavailable', checkedAt }, now),
    ).toBe('unavailable');
  });

  it('should re-probe once the verdict expires', () => {
    const checkedAt = new Date(
      now.getTime() - TWENTY_AI_PROBE_TTL_MS - 1,
    ).toISOString();

    expect(
      effectiveTwentyAiAvailability({ availability: 'unavailable', checkedAt }, now),
    ).toBe('unknown');
  });

  it('should treat an unparseable timestamp as expired', () => {
    expect(
      effectiveTwentyAiAvailability(
        { availability: 'unavailable', checkedAt: 'not a date' },
        now,
      ),
    ).toBe('unknown');
  });

  it('should pass through anything that is not a denial', () => {
    expect(
      effectiveTwentyAiAvailability({ availability: 'available', checkedAt: null }, now),
    ).toBe('available');
    expect(
      effectiveTwentyAiAvailability({ availability: 'unknown', checkedAt: null }, now),
    ).toBe('unknown');
  });
});
