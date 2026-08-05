/**
 * The HTTP adapter for the three search providers.
 *
 * Implements `SearchPort`, which is what keeps `src/enrichment/` and
 * `enrich-run.ts` testable without a network. Exercised on its own against a
 * fake `fetch`, exactly like `licence-http-client.ts`.
 *
 * ## The three response shapes
 *
 * | Provider | Container        | URL     | Title   | Snippet       |
 * |----------|------------------|---------|---------|---------------|
 * | Brave    | `web.results[]`  | `url`   | `title` | `description` |
 * | Serper   | `organic[]`      | `link`  | `title` | `snippet`     |
 * | SearXNG  | `results[]`      | `url`   | `title` | `content`     |
 *
 * Three containers and three different names for the snippet, which is why each
 * gets its own total reader rather than a shared "find the array" heuristic.
 *
 * SearXNG differs in two further ways that matter to a caller:
 *
 *  - **It has no result-count parameter.** Brave takes `count` and Serper takes
 *    `num`; SearXNG's only pagination control is `pageno`, and it returns
 *    whatever its configured engines produced — around fifty entries for a
 *    typical query. The `maxResults` contract is therefore honoured by slicing,
 *    which the shared tail already does for every provider.
 *  - **Its results are aggregated, so `number_of_results` is not a count of
 *    `results`.** It is a metasearch layer over several engines and reports that
 *    field as `0` when the engines disagree or do not supply one. Nothing here
 *    reads it; the length of `results` is the only count that is true.
 *
 * ## When the instance has JSON switched off
 *
 * SearXNG ships with `search.formats: [html]` and nothing else. An instance in
 * that state does not fail like a broken provider — it fails like a working web
 * page, which is far worse, because the naive outcome is `JSON.parse` choking on
 * `<!DOCTYPE html>` and the admin being told "malformed response" about an
 * instance that is perfectly healthy and simply has one line missing from its
 * `settings.yml`. Two checks turn that into an answer somebody can act on:
 *
 *  - a `403`, which is what the SearXNG application itself returns when the
 *    requested output format is not in its allow-list; and
 *  - a `200` carrying HTML, which is what a reverse proxy or an older build in
 *    front of it returns instead.
 *
 * Both name the missing setting in their detail. Neither is a guess about the
 * body's contents: the first reads the status, the second reads the
 * content-type and the first non-whitespace byte.
 *
 * ## It never throws
 *
 * Every branch returns a discriminated outcome. The call site is a database
 * event handler on the enrichment path, and a thrown error there would be caught
 * by the run's outer `catch` and reported as a *failure* — when what actually
 * happened is a provider being briefly unavailable, which is a `skipped` with a
 * reason and a circuit-breaker tick. Making failure a return value is what keeps
 * those two apart.
 *
 * ## Status handling
 *
 * | Wire                          | Outcome               |
 * |-------------------------------|-----------------------|
 * | `200` + parseable body        | `results`             |
 * | `200` + unparseable body      | `malformed_response`  |
 * | `401` / `403`                 | `unexpected_status`   |
 * | `429`                         | `rate_limited` (honours `Retry-After`) |
 * | `5xx`                         | `service_unavailable` |
 * | anything else non-2xx         | `unexpected_status`   |
 * | thrown (DNS, TLS, timeout)    | `transport_failure`   |
 *
 * `401` is deliberately not special-cased into `not_configured`. A bad key and a
 * revoked key are the same wire response, both need an admin, and collapsing
 * them into "not configured" would stop the breaker counting a condition that
 * will not fix itself.
 *
 * ## The key never appears in what this returns
 *
 * Failure details are built from the error's name and message and then have the
 * key redacted, for the same reason `licence-http-client.ts` does it: the
 * messages come from `fetch` and from `JSON.parse`, neither of which we control,
 * and at least one plausible implementation echoes the request.
 */

import {
  BRAVE_SEARCH_ENDPOINT,
  SEARXNG_SEARCH_PATH,
  SERPER_SEARCH_ENDPOINT,
} from 'src/constants/enrichment-identifiers';
import type {
  ProviderFailure,
  RawSearchResult,
  SearchOutcome,
  SearchPort,
  SearchProviderName,
} from 'src/enrichment';

/** Injected so tests never touch the network and never need a timer. */
export type SearchFetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

interface SearchClientCommonOptions {
  readonly fetchImpl?: SearchFetchLike | null;
  /**
   * 6 seconds. The enrichment function is given 60s and has an LLM round trip
   * still to come; a search that has not answered in six seconds is not going
   * to make the run better, and the whole point of enrichment being optional is
   * that waiting for it is never the right call.
   *
   * It applies to SearXNG too, and there it is a real constraint rather than a
   * formality: a metasearch instance is as slow as the slowest engine it is
   * waiting on, so six seconds is a timeout that will genuinely fire on a busy
   * instance. That is the intended behaviour — a slow search costs the lead
   * nothing, because the lead is already scored.
   */
  readonly timeoutMs?: number;
}

/**
 * A union rather than one interface with optional fields, so that "SearXNG with
 * an API key" and "Brave with a base URL" are not expressible. Each provider's
 * one required piece of configuration is required by the type.
 */
export type SearchClientOptions =
  | (SearchClientCommonOptions & {
      readonly provider: 'brave' | 'serper';
      readonly apiKey: string;
    })
  | (SearchClientCommonOptions & {
      readonly provider: 'searxng';
      readonly baseUrl: string;
    });

const DEFAULT_TIMEOUT_MS = 6_000;

const describe = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return typeof error === 'string' ? error : 'unknown transport error';
};

/** Both the raw and URL-encoded forms, as `redactLicenceKey` does. */
const redactKey = (text: string, key: string): string => {
  if (key.length === 0) {
    return text;
  }

  return text
    .split(key)
    .join('[redacted]')
    .split(encodeURIComponent(key))
    .join('[redacted]');
};

const readRetryAfter = (headers: {
  get(name: string): string | null;
}): number | null => {
  const raw = headers.get('retry-after');

  if (raw === null) {
    return null;
  }

  const seconds = Number(raw.trim());

  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
};

const classifyStatus = (
  status: number,
  headers: { get(name: string): string | null },
): ProviderFailure => {
  if (status === 429) {
    return { kind: 'rate_limited', retryAfterSeconds: readRetryAfter(headers) };
  }

  if (status >= 500) {
    return { kind: 'service_unavailable', statusCode: status };
  }

  return { kind: 'unexpected_status', statusCode: status };
};

const timeoutSignal = (timeoutMs: number): AbortSignal | undefined => {
  if (
    typeof AbortSignal !== 'undefined' &&
    typeof AbortSignal.timeout === 'function'
  ) {
    return AbortSignal.timeout(timeoutMs);
  }

  return undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : '';

/**
 * Brave: `{ web: { results: [{ url, title, description }] } }`.
 * Serper: `{ organic: [{ link, title, snippet }] }`.
 *
 * Both readers are total: a shape we do not recognise yields zero results, not
 * an exception. A provider changing its response shape should present as "no
 * enrichment this month" and a log line, never as a broken event handler.
 */
const readBrave = (payload: unknown): readonly RawSearchResult[] => {
  if (!isRecord(payload) || !isRecord(payload['web'])) {
    return [];
  }

  const results = (payload['web'] as Record<string, unknown>)['results'];

  if (!Array.isArray(results)) {
    return [];
  }

  return results.flatMap((entry): RawSearchResult[] =>
    isRecord(entry)
      ? [
          {
            url: asText(entry['url']),
            title: asText(entry['title']),
            snippet: asText(entry['description']),
          },
        ]
      : [],
  );
};

const readSerper = (payload: unknown): readonly RawSearchResult[] => {
  if (!isRecord(payload) || !Array.isArray(payload['organic'])) {
    return [];
  }

  return payload['organic'].flatMap((entry): RawSearchResult[] =>
    isRecord(entry)
      ? [
          {
            url: asText(entry['link']),
            title: asText(entry['title']),
            snippet: asText(entry['snippet']),
          },
        ]
      : [],
  );
};

/**
 * SearXNG: `{ results: [{ url, title, content }] }`.
 *
 * `content` is the snippet. Each entry also carries `engine`, `engines`,
 * `positions`, `score`, `category`, `template`, `parsed_url`, `img_src`,
 * `thumbnail` and sometimes `publishedDate` — all of it aggregation metadata,
 * and none of it read. Taking only the three fields the port defines is what
 * keeps a metasearch instance's richer output from reaching the model as extra
 * untrusted text: `sanitise.ts` screens what it is given, and the cheapest way
 * to keep a field out of the evidence set is never to lift it.
 *
 * Entries whose `url` is blank are dropped. A result with no address cannot
 * become a `sourceUrl`, and provenance without a source URL is exactly the state
 * `EnrichedFieldProvenance` exists to make unrepresentable — better to lose the
 * row here than to have it rejected three layers later with a worse reason.
 */
const readSearxng = (payload: unknown): readonly RawSearchResult[] => {
  if (!isRecord(payload) || !Array.isArray(payload['results'])) {
    return [];
  }

  return payload['results'].flatMap((entry): RawSearchResult[] => {
    if (!isRecord(entry)) {
      return [];
    }

    const url = asText(entry['url']);

    return url.length === 0
      ? []
      : [
          {
            url,
            title: asText(entry['title']),
            snippet: asText(entry['content']),
          },
        ];
  });
};

/**
 * The one line an admin needs, in both JSON-disabled branches.
 *
 * Names the setting and the file rather than describing the symptom, because
 * the symptom is already in front of them and the fix is not.
 */
const SEARXNG_JSON_DISABLED_HINT =
  'searxng did not return JSON; add `- json` under `search: formats:` in the instance settings.yml and restart it';

/** Is this body an HTML page rather than the JSON we asked for? */
const looksLikeHtml = (
  raw: string,
  headers: { get(name: string): string | null },
): boolean =>
  (headers.get('content-type') ?? '').toLowerCase().includes('html') ||
  raw.trimStart().startsWith('<');

/**
 * Build a search client.
 *
 * Serper's API is a `POST` with a JSON body in its own documentation, but it
 * also accepts the query on the URL, and SearXNG's JSON output is a `GET` with
 * `format=json`. Using the same GET shape for all three means one code path, one
 * timeout, one status ladder and one set of tests. If that ever stops working
 * the failure is an `unexpected_status` that trips the breaker and skips
 * enrichment — visible, bounded, and unable to touch a lead.
 *
 * The API key is empty string for SearXNG, which is not a special case anywhere
 * below: `redactKey` with a blank needle is the identity, and the blank-key
 * refusal is asked only of the providers that have one.
 */
export const createSearchClient = (options: SearchClientOptions): SearchPort => {
  const providerName: SearchProviderName = options.provider;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Both settled once, here, so the request builder below reads a plain string
  // rather than re-narrowing the union on every branch it touches.
  const apiKey = options.provider === 'searxng' ? '' : options.apiKey;
  const baseUrl = options.provider === 'searxng' ? options.baseUrl : '';
  const doFetch =
    options.fetchImpl ??
    (typeof globalThis.fetch === 'function'
      ? (globalThis.fetch as unknown as SearchFetchLike)
      : null);

  return {
    providerName,

    search: async ({ query, maxResults }): Promise<SearchOutcome> => {
      // A self-hosted instance on the customer's own network has no key to
      // check. Its equivalent precondition — a usable base URL — was settled in
      // `resolveSearchProvider` before this client was ever constructed.
      if (options.provider !== 'searxng' && apiKey.length === 0) {
        return { kind: 'not_configured', detail: 'search api key is blank' };
      }

      if (doFetch === null) {
        return {
          kind: 'transport_failure',
          detail: 'no fetch implementation available in this runtime',
        };
      }

      const count = Math.min(20, Math.max(1, maxResults));
      const encodedQuery = encodeURIComponent(query);
      const url =
        options.provider === 'brave'
          ? `${BRAVE_SEARCH_ENDPOINT}?q=${encodedQuery}&count=${count}`
          : options.provider === 'serper'
            ? `${SERPER_SEARCH_ENDPOINT}?q=${encodedQuery}&num=${count}`
            : `${baseUrl}${SEARXNG_SEARCH_PATH}?q=${encodedQuery}&format=json`;

      const headers: Record<string, string> =
        options.provider === 'brave'
          ? {
              accept: 'application/json',
              'accept-encoding': 'gzip',
              'x-subscription-token': apiKey,
            }
          : options.provider === 'serper'
            ? { accept: 'application/json', 'x-api-key': apiKey }
            : { accept: 'application/json' };

      let response: Awaited<ReturnType<SearchFetchLike>>;

      try {
        response = await doFetch(url, {
          method: 'GET',
          headers,
          signal: timeoutSignal(timeoutMs),
        });
      } catch (error) {
        return {
          kind: 'transport_failure',
          detail: redactKey(describe(error), apiKey),
        };
      }

      if (!response.ok) {
        // SearXNG returns 403 from its own request handler when the requested
        // output format is not in `search.formats`. Reported as a configuration
        // answer rather than an `unexpected_status`, because it is one: no
        // amount of backing off fixes it, and the breaker's retry ladder would
        // only delay the admin finding out.
        if (options.provider === 'searxng' && response.status === 403) {
          return {
            kind: 'not_configured',
            detail: `${SEARXNG_JSON_DISABLED_HINT} (http 403)`,
          };
        }

        return classifyStatus(response.status, response.headers);
      }

      let raw: string;

      try {
        raw = await response.text();
      } catch (error) {
        return {
          kind: 'malformed_response',
          detail: redactKey(describe(error), apiKey),
        };
      }

      // The other shape the same misconfiguration takes: a 200 carrying the
      // search page a browser would have got. Caught before `JSON.parse` so the
      // admin reads the missing setting rather than a syntax error at byte one.
      if (looksLikeHtml(raw, response.headers)) {
        return {
          kind: 'malformed_response',
          detail:
            options.provider === 'searxng'
              ? `${SEARXNG_JSON_DISABLED_HINT} (http 200 with an html body)`
              : `${providerName} returned an html body where json was expected`,
        };
      }

      let payload: unknown;

      try {
        payload = JSON.parse(raw) as unknown;
      } catch (error) {
        return {
          kind: 'malformed_response',
          detail: redactKey(describe(error), apiKey),
        };
      }

      const results =
        options.provider === 'brave'
          ? readBrave(payload)
          : options.provider === 'serper'
            ? readSerper(payload)
            : readSearxng(payload);

      return { kind: 'results', results: results.slice(0, count) };
    },
  };
};
