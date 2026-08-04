import {
  ENRICHMENT_EXTRACTOR_AGENT_UNIVERSAL_IDENTIFIER,
  ENRICHMENT_VERIFIER_AGENT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/enrichment-identifiers';
import {
  buildAgentPrompt,
  classifyAgentError,
  createTwentyAiClient,
  readAgentText,
  type RunAgentLike,
} from 'src/logic-functions/enrich-twenty-ai-client';
import { describe, expect, it } from 'vitest';

/**
 * `runAgent` is injected throughout. Nothing here reaches the platform, and the
 * import of the SDK module is inert — the real `runAgent` is only ever the
 * default, never the value used.
 */

const request = {
  tier: 'capable' as const,
  instruction: 'INSTRUCTION TEXT',
  untrustedEvidence: '[{"id":"e1"}]',
  maxOutputTokens: 100,
};

const stub = (
  response: { result?: object | null; error?: string | null; success?: boolean },
  recorded: { agentUniversalIdentifier: string; prompt: string }[] = [],
): RunAgentLike =>
  async (input) => {
    recorded.push(input);

    return {
      result: response.result ?? null,
      error: response.error ?? null,
      success: response.success ?? true,
    };
  };

describe('createTwentyAiClient', () => {
  it('should route the two tiers to two different agents', async () => {
    const recorded: { agentUniversalIdentifier: string; prompt: string }[] = [];
    const client = createTwentyAiClient({
      runAgentImpl: stub({ result: { text: '{"fields":[]}' } }, recorded),
    });

    await client.complete(request);
    await client.complete({ ...request, tier: 'cheap' });

    expect(recorded[0]?.agentUniversalIdentifier).toBe(
      ENRICHMENT_EXTRACTOR_AGENT_UNIVERSAL_IDENTIFIER,
    );
    expect(recorded[1]?.agentUniversalIdentifier).toBe(
      ENRICHMENT_VERIFIER_AGENT_UNIVERSAL_IDENTIFIER,
    );
  });

  it('should keep the evidence behind a fence, after the instruction', async () => {
    const recorded: { agentUniversalIdentifier: string; prompt: string }[] = [];
    const client = createTwentyAiClient({
      runAgentImpl: stub({ result: { text: '{}' } }, recorded),
    });

    await client.complete(request);

    const prompt = recorded[0]?.prompt ?? '';

    expect(prompt.indexOf('INSTRUCTION TEXT')).toBeLessThan(
      prompt.indexOf('UNTRUSTED_SEARCH_RESULTS_BEGIN'),
    );
    expect(prompt).toContain('UNTRUSTED_SEARCH_RESULTS_END');
  });

  it('should report a workspace with no AI as not configured', async () => {
    const client = createTwentyAiClient({
      runAgentImpl: stub({ success: false, error: 'No AI model configured' }),
    });

    expect((await client.complete(request)).kind).toBe('not_configured');
  });

  it('should treat an unreadable result as malformed', async () => {
    const client = createTwentyAiClient({
      runAgentImpl: stub({ success: true, result: null }),
    });

    expect((await client.complete(request)).kind).toBe('malformed_response');
  });

  it('should never throw, even if runAgent does', async () => {
    const client = createTwentyAiClient({
      runAgentImpl: async () => {
        throw new Error('alpha surface changed');
      },
    });

    expect((await client.complete(request)).kind).toBe('transport_failure');
  });
});

describe('classifyAgentError', () => {
  it.each([
    'No AI model configured for this workspace',
    'model not found',
    'AI is not enabled',
    'missing api key',
    'unknown agent',
  ])('should read %s as a configuration answer', (message) => {
    expect(classifyAgentError(message).kind).toBe('not_configured');
  });

  it('should read a rate limit as a rate limit', () => {
    expect(classifyAgentError('Rate limit exceeded').kind).toBe('rate_limited');
  });

  it('should read an unrecognised message as a retriable outage', () => {
    // The safe direction: a message we do not recognise trips the breaker and
    // is retried, rather than being mistaken for "this workspace has no AI".
    expect(classifyAgentError('something odd happened').kind).toBe(
      'service_unavailable',
    );
    expect(classifyAgentError(null).kind).toBe('service_unavailable');
  });
});

describe('readAgentText', () => {
  it('should find the answer under any of the plausible keys', () => {
    expect(readAgentText({ text: 'a' })).toBe('a');
    expect(readAgentText({ content: 'b' })).toBe('b');
    expect(readAgentText({ output: 'c' })).toBe('c');
  });

  it('should re-serialise an already-parsed object', () => {
    expect(readAgentText({ fields: [] })).toBe('{"fields":[]}');
  });

  it('should return null for nothing', () => {
    expect(readAgentText(null)).toBeNull();
  });
});

describe('buildAgentPrompt', () => {
  it('should not interleave the two', () => {
    const prompt = buildAgentPrompt('A', 'B');

    expect(prompt.startsWith('A')).toBe(true);
    expect(prompt.trimEnd().endsWith('<<<UNTRUSTED_SEARCH_RESULTS_END>>>')).toBe(
      true,
    );
  });
});
