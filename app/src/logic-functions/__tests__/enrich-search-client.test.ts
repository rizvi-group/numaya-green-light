import {
  createSearchClient,
  type SearchFetchLike,
} from 'src/logic-functions/enrich-search-client';
import { describe, expect, it } from 'vitest';

/**
 * No test in this file makes a network call. `fetch` is injected, and the
 * responses below are the shapes the two providers actually return.
 */

interface Recorded {
  readonly url: string;
  readonly headers: Record<string, string>;
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
): SearchFetchLike =>
  async (url, init) => {
    recorded.push({ url, headers: init.headers });

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

const BRAVE_BODY = JSON.stringify({
  web: {
    results: [
      {
        url: 'https://example.com/about',
        title: 'About Acme',
        description: 'Acme makes pumps.',
      },
    ],
  },
});

const SERPER_BODY = JSON.stringify({
  organic: [
    {
      link: 'https://example.com/about',
      title: 'About Acme',
      snippet: 'Acme makes pumps.',
    },
  ],
});

describe('createSearchClient', () => {
  it('should read Brave’s response shape', async () => {
    const client = createSearchClient({
      provider: 'brave',
      apiKey: 'k',
      fetchImpl: fakeFetch({ body: BRAVE_BODY }),
    });

    const outcome = await client.search({ query: 'Acme', maxResults: 5 });

    expect(outcome).toEqual({
      kind: 'results',
      results: [
        {
          url: 'https://example.com/about',
          title: 'About Acme',
          snippet: 'Acme makes pumps.',
        },
      ],
    });
  });

  it('should read Serper’s response shape', async () => {
    const client = createSearchClient({
      provider: 'serper',
      apiKey: 'k',
      fetchImpl: fakeFetch({ body: SERPER_BODY }),
    });

    const outcome = await client.search({ query: 'Acme', maxResults: 5 });

    expect(outcome).toMatchObject({ kind: 'results' });
  });

  it('should send each provider its own auth header', async () => {
    const brave: Recorded[] = [];
    const serper: Recorded[] = [];

    await createSearchClient({
      provider: 'brave',
      apiKey: 'brave-key',
      fetchImpl: fakeFetch({ body: BRAVE_BODY }, brave),
    }).search({ query: 'Acme', maxResults: 5 });

    await createSearchClient({
      provider: 'serper',
      apiKey: 'serper-key',
      fetchImpl: fakeFetch({ body: SERPER_BODY }, serper),
    }).search({ query: 'Acme', maxResults: 5 });

    expect(brave[0]?.headers['x-subscription-token']).toBe('brave-key');
    expect(serper[0]?.headers['x-api-key']).toBe('serper-key');
  });

  it('should refuse to send an unauthenticated request', async () => {
    const client = createSearchClient({
      provider: 'brave',
      apiKey: '',
      fetchImpl: fakeFetch({ body: BRAVE_BODY }),
    });

    expect(await client.search({ query: 'Acme', maxResults: 5 })).toMatchObject({
      kind: 'not_configured',
    });
  });

  it('should classify a rate limit and honour Retry-After', async () => {
    const client = createSearchClient({
      provider: 'brave',
      apiKey: 'k',
      fetchImpl: fakeFetch({
        ok: false,
        status: 429,
        headers: { 'retry-after': '45' },
      }),
    });

    expect(await client.search({ query: 'Acme', maxResults: 5 })).toEqual({
      kind: 'rate_limited',
      retryAfterSeconds: 45,
    });
  });

  it('should classify a server error', async () => {
    const client = createSearchClient({
      provider: 'brave',
      apiKey: 'k',
      fetchImpl: fakeFetch({ ok: false, status: 503 }),
    });

    expect(await client.search({ query: 'Acme', maxResults: 5 })).toEqual({
      kind: 'service_unavailable',
      statusCode: 503,
    });
  });

  it('should leave an auth failure as an unexpected status, not a configuration answer', async () => {
    const client = createSearchClient({
      provider: 'brave',
      apiKey: 'k',
      fetchImpl: fakeFetch({ ok: false, status: 401 }),
    });

    // A bad key needs an admin and will not fix itself; folding it into
    // `not_configured` would stop the breaker counting it.
    expect(await client.search({ query: 'Acme', maxResults: 5 })).toEqual({
      kind: 'unexpected_status',
      statusCode: 401,
    });
  });

  it('should classify an unparseable body', async () => {
    const client = createSearchClient({
      provider: 'brave',
      apiKey: 'k',
      fetchImpl: fakeFetch({ body: '<html>proxy error</html>' }),
    });

    expect(
      (await client.search({ query: 'Acme', maxResults: 5 })).kind,
    ).toBe('malformed_response');
  });

  it('should return zero results rather than throw on an unfamiliar shape', async () => {
    const client = createSearchClient({
      provider: 'brave',
      apiKey: 'k',
      fetchImpl: fakeFetch({ body: JSON.stringify({ unexpected: true }) }),
    });

    expect(await client.search({ query: 'Acme', maxResults: 5 })).toEqual({
      kind: 'results',
      results: [],
    });
  });

  it('should classify a thrown transport error and never leak the key', async () => {
    const client = createSearchClient({
      provider: 'brave',
      apiKey: 'super-secret',
      fetchImpl: fakeFetch({
        throws: new Error('connect ECONNREFUSED with key super-secret'),
      }),
    });

    const outcome = await client.search({ query: 'Acme', maxResults: 5 });

    expect(outcome.kind).toBe('transport_failure');
    expect(JSON.stringify(outcome)).not.toContain('super-secret');
    expect(JSON.stringify(outcome)).toContain('[redacted]');
  });

  it('should never throw', async () => {
    const client = createSearchClient({
      provider: 'brave',
      apiKey: 'k',
      fetchImpl: fakeFetch({ throws: 'a bare string' }),
    });

    await expect(
      client.search({ query: 'Acme', maxResults: 5 }),
    ).resolves.toBeDefined();
  });
});
