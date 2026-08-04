import {
  createOpenAiCompatibleClient,
  readCompletionText,
  type ReasoningFetchLike,
} from 'src/logic-functions/enrich-reasoning-client';
import { describe, expect, it } from 'vitest';

interface Recorded {
  readonly url: string;
  readonly body: string;
}

const fakeFetch = (
  response: {
    ok?: boolean;
    status?: number;
    body?: string;
    headers?: Record<string, string>;
    throws?: unknown;
  },
  recorded: Recorded[] = [],
): ReasoningFetchLike =>
  async (url, init) => {
    recorded.push({ url, body: init.body });

    if (response.throws !== undefined) {
      throw response.throws;
    }

    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      headers: {
        get: (name: string) => response.headers?.[name.toLowerCase()] ?? null,
      },
      text: async () => response.body ?? '{}',
    };
  };

const completion = (content: unknown): string =>
  JSON.stringify({ choices: [{ message: { content } }] });

const request = {
  tier: 'capable' as const,
  instruction: 'INSTRUCTION TEXT',
  untrustedEvidence: '[{"id":"e1","title":"t","snippet":"s"}]',
  maxOutputTokens: 100,
};

describe('createOpenAiCompatibleClient', () => {
  it('should send the instruction and the evidence as separate messages', async () => {
    const recorded: Recorded[] = [];
    const client = createOpenAiCompatibleClient({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-test',
      fetchImpl: fakeFetch({ body: completion('{"fields":[]}') }, recorded),
    });

    await client.complete(request);

    const sent = JSON.parse(recorded[0]?.body ?? '{}') as {
      messages: { role: string; content: string }[];
      temperature: number;
    };

    expect(sent.messages).toHaveLength(2);
    expect(sent.messages[0]?.role).toBe('system');
    expect(sent.messages[0]?.content).toBe('INSTRUCTION TEXT');
    expect(sent.messages[1]?.role).toBe('user');
    // The evidence is never concatenated onto the instruction.
    expect(sent.messages[1]?.content).not.toContain('INSTRUCTION TEXT');
    expect(sent.messages[1]?.content).toContain('UNTRUSTED_SEARCH_RESULTS_BEGIN');
    expect(sent.temperature).toBe(0);
  });

  it('should normalise a trailing slash on the base URL', async () => {
    const recorded: Recorded[] = [];
    const client = createOpenAiCompatibleClient({
      baseUrl: 'https://api.example.com/v1/',
      apiKey: 'sk-test',
      model: 'gpt-test',
      fetchImpl: fakeFetch({ body: completion('{}') }, recorded),
    });

    await client.complete(request);

    expect(recorded[0]?.url).toBe('https://api.example.com/v1/chat/completions');
  });

  it('should return the completed text', async () => {
    const client = createOpenAiCompatibleClient({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-test',
      fetchImpl: fakeFetch({ body: completion('{"fields":[]}') }),
    });

    expect(await client.complete(request)).toEqual({
      kind: 'completed',
      text: '{"fields":[]}',
      model: 'gpt-test',
    });
  });

  it('should refuse when any of the three variables is missing', async () => {
    const client = createOpenAiCompatibleClient({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: '',
      fetchImpl: fakeFetch({ body: completion('{}') }),
    });

    expect((await client.complete(request)).kind).toBe('not_configured');
  });

  it('should classify a rate limit', async () => {
    const client = createOpenAiCompatibleClient({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-test',
      fetchImpl: fakeFetch({
        ok: false,
        status: 429,
        headers: { 'retry-after': '12' },
      }),
    });

    expect(await client.complete(request)).toEqual({
      kind: 'rate_limited',
      retryAfterSeconds: 12,
    });
  });

  it('should classify a server error and a malformed body', async () => {
    const failing = createOpenAiCompatibleClient({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-test',
      fetchImpl: fakeFetch({ ok: false, status: 500 }),
    });

    expect((await failing.complete(request)).kind).toBe('service_unavailable');

    const garbled = createOpenAiCompatibleClient({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-test',
      fetchImpl: fakeFetch({ body: 'not json' }),
    });

    expect((await garbled.complete(request)).kind).toBe('malformed_response');
  });

  it('should treat a response with no assistant content as malformed', async () => {
    const client = createOpenAiCompatibleClient({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-test',
      fetchImpl: fakeFetch({ body: JSON.stringify({ choices: [] }) }),
    });

    expect((await client.complete(request)).kind).toBe('malformed_response');
  });

  it('should never leak the key in a transport failure', async () => {
    const client = createOpenAiCompatibleClient({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-super-secret',
      model: 'gpt-test',
      fetchImpl: fakeFetch({
        throws: new Error('request failed: authorization Bearer sk-super-secret'),
      }),
    });

    const outcome = await client.complete(request);

    expect(JSON.stringify(outcome)).not.toContain('sk-super-secret');
  });
});

describe('readCompletionText', () => {
  it('should read a plain string content', () => {
    expect(readCompletionText(JSON.parse(completion('hello')))).toBe('hello');
  });

  it('should read content parts', () => {
    const payload = JSON.parse(
      completion([{ type: 'text', text: 'he' }, { type: 'text', text: 'llo' }]),
    );

    expect(readCompletionText(payload)).toBe('hello');
  });

  it('should return null for anything else', () => {
    expect(readCompletionText(null)).toBeNull();
    expect(readCompletionText({ choices: [{}] })).toBeNull();
    expect(readCompletionText(JSON.parse(completion(42)))).toBeNull();
  });
});
