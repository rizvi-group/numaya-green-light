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

/**
 * Trimmed from a real response off a running SearXNG instance, keeping the
 * aggregation metadata the adapter is supposed to ignore. Note `content` where
 * Brave says `description` and Serper says `snippet`, and `results` at the top
 * level rather than nested under a container.
 */
const SEARXNG_BODY = JSON.stringify({
  query: 'Acme',
  number_of_results: 0,
  results: [
    {
      title: 'About Acme',
      url: 'https://example.com/about',
      content: 'Acme makes pumps.',
      engine: 'brave',
      engines: ['duckduckgo', 'brave'],
      positions: [1, 1],
      score: 4,
      category: 'general',
      template: 'default.html',
      parsed_url: ['https', 'example.com', '/about', '', '', ''],
    },
  ],
  answers: [],
  corrections: [],
  infoboxes: [],
  suggestions: [],
  unresponsive_engines: [['google', 'CAPTCHA']],
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

describe('createSearchClient — searxng', () => {
  it('should read SearXNG’s response shape', async () => {
    const client = createSearchClient({
      provider: 'searxng',
      baseUrl: 'http://searxng:8080',
      fetchImpl: fakeFetch({ body: SEARXNG_BODY }),
    });

    // `content` becomes `snippet`, and none of the aggregation metadata
    // survives into the evidence set.
    expect(await client.search({ query: 'Acme', maxResults: 5 })).toEqual({
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

  it('should ask the configured instance for JSON and send no credential', async () => {
    const recorded: Recorded[] = [];

    await createSearchClient({
      provider: 'searxng',
      baseUrl: 'http://searxng:8080',
      fetchImpl: fakeFetch({ body: SEARXNG_BODY }, recorded),
    }).search({ query: 'Acme Pumps', maxResults: 5 });

    expect(recorded[0]?.url).toBe(
      'http://searxng:8080/search?q=Acme%20Pumps&format=json',
    );
    // There is no key to send, so there must be no key header. A self-hosted
    // instance is reached without a credential — that is the whole point of it.
    expect(Object.keys(recorded[0]?.headers ?? {})).toEqual(['accept']);
  });

  it('should not refuse the request for want of an API key', async () => {
    // Brave and Serper refuse to send an unauthenticated request. SearXNG has
    // no authentication to be missing, so the same guard must not fire.
    const client = createSearchClient({
      provider: 'searxng',
      baseUrl: 'http://searxng:8080',
      fetchImpl: fakeFetch({ body: SEARXNG_BODY }),
    });

    expect((await client.search({ query: 'Acme', maxResults: 5 })).kind).toBe(
      'results',
    );
  });

  it('should honour maxResults by slicing, since SearXNG has no count parameter', async () => {
    const many = JSON.stringify({
      results: Array.from({ length: 40 }, (_unused, index) => ({
        title: `Result ${index}`,
        url: `https://example.com/${index}`,
        content: 'Acme makes pumps.',
      })),
    });

    const outcome = await createSearchClient({
      provider: 'searxng',
      baseUrl: 'http://searxng:8080',
      fetchImpl: fakeFetch({ body: many }),
    }).search({ query: 'Acme', maxResults: 10 });

    expect(outcome).toMatchObject({ kind: 'results' });
    expect(outcome.kind === 'results' ? outcome.results.length : -1).toBe(10);
  });

  it('should drop a result that carries no URL', async () => {
    const body = JSON.stringify({
      results: [
        { title: 'No address', url: '', content: 'Acme makes pumps.' },
        {
          title: 'About Acme',
          url: 'https://example.com/about',
          content: 'Acme makes pumps.',
        },
      ],
    });

    const outcome = await createSearchClient({
      provider: 'searxng',
      baseUrl: 'http://searxng:8080',
      fetchImpl: fakeFetch({ body }),
    }).search({ query: 'Acme', maxResults: 5 });

    // A result with no address can never become a `sourceUrl`, and provenance
    // without one is the state `EnrichedFieldProvenance` forbids.
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

  it('should diagnose a 403 as the JSON output format being disabled', async () => {
    const outcome = await createSearchClient({
      provider: 'searxng',
      baseUrl: 'http://searxng:8080',
      fetchImpl: fakeFetch({ ok: false, status: 403 }),
    }).search({ query: 'Acme', maxResults: 5 });

    // A configuration answer, not an `unexpected_status`: backing off does not
    // fix a missing line in settings.yml, and the breaker's ladder would only
    // delay the admin finding out which line it is.
    expect(outcome.kind).toBe('not_configured');
    expect(JSON.stringify(outcome)).toContain('settings.yml');
  });

  it('should diagnose an HTML body on a 200 rather than crash on the parse', async () => {
    const outcome = await createSearchClient({
      provider: 'searxng',
      baseUrl: 'http://searxng:8080',
      fetchImpl: fakeFetch({
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: '<!DOCTYPE html>\n<html><body>results</body></html>',
      }),
    }).search({ query: 'Acme', maxResults: 5 });

    expect(outcome.kind).toBe('malformed_response');
    expect(JSON.stringify(outcome)).toContain('settings.yml');
    // The admin must not be shown a syntax error about byte one of a page that
    // is, in itself, perfectly valid.
    expect(JSON.stringify(outcome)).not.toContain('SyntaxError');
    expect(JSON.stringify(outcome)).not.toContain('Unexpected token');
  });

  it('should detect an HTML body even when the content-type does not say so', async () => {
    const outcome = await createSearchClient({
      provider: 'searxng',
      baseUrl: 'http://searxng:8080',
      fetchImpl: fakeFetch({
        headers: { 'content-type': 'application/json' },
        body: '  <!DOCTYPE html><html></html>',
      }),
    }).search({ query: 'Acme', maxResults: 5 });

    expect(outcome.kind).toBe('malformed_response');
    expect(JSON.stringify(outcome)).toContain('settings.yml');
  });

  it('should still classify a genuine outage as an outage', async () => {
    // The JSON-disabled diagnosis must not swallow the failures the breaker
    // exists for: a 502 from a reverse proxy is a provider being down.
    const outcome = await createSearchClient({
      provider: 'searxng',
      baseUrl: 'http://searxng:8080',
      fetchImpl: fakeFetch({ ok: false, status: 502 }),
    }).search({ query: 'Acme', maxResults: 5 });

    expect(outcome).toEqual({ kind: 'service_unavailable', statusCode: 502 });
  });

  it('should report the provider it is', async () => {
    expect(
      createSearchClient({ provider: 'searxng', baseUrl: 'http://x:8080' })
        .providerName,
    ).toBe('searxng');
  });
});
