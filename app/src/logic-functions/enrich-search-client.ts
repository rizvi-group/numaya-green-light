/**
 * The HTTP adapter for the two search providers.
 *
 * Implements `SearchPort`, which is what keeps `src/enrichment/` and
 * `enrich-run.ts` testable without a network. Exercised on its own against a
 * fake `fetch`, exactly like `licence-http-client.ts`.
 *
 * ## It never throws
 *
 * Both branches return a discriminated outcome. The call site is a database
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

export interface SearchClientOptions {
  readonly provider: 'brave' | 'serper';
  readonly apiKey: string;
  readonly fetchImpl?: SearchFetchLike | null;
  /**
   * 6 seconds. The enrichment function is given 60s and has an LLM round trip
   * still to come; a search that has not answered in six seconds is not going
   * to make the run better, and the whole point of enrichment being optional is
   * that waiting for it is never the right call.
   */
  readonly timeoutMs?: number;
}

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
 * Build a search client.
 *
 * Serper's API is a `POST` with a JSON body in its own documentation, but it
 * also accepts the query on the URL, and using the same GET shape for both
 * providers means one code path, one timeout, one status ladder and one set of
 * tests. If that ever stops working the failure is a `unexpected_status` that
 * trips the breaker and skips enrichment — visible, bounded, and unable to touch
 * a lead.
 */
export const createSearchClient = (options: SearchClientOptions): SearchPort => {
  const providerName: SearchProviderName = options.provider;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch =
    options.fetchImpl ??
    (typeof globalThis.fetch === 'function'
      ? (globalThis.fetch as unknown as SearchFetchLike)
      : null);

  return {
    providerName,

    search: async ({ query, maxResults }): Promise<SearchOutcome> => {
      if (options.apiKey.length === 0) {
        return { kind: 'not_configured', detail: 'search api key is blank' };
      }

      if (doFetch === null) {
        return {
          kind: 'transport_failure',
          detail: 'no fetch implementation available in this runtime',
        };
      }

      const count = Math.min(20, Math.max(1, maxResults));
      const url =
        providerName === 'brave'
          ? `${BRAVE_SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}&count=${count}`
          : `${SERPER_SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}&num=${count}`;

      const headers: Record<string, string> =
        providerName === 'brave'
          ? {
              accept: 'application/json',
              'accept-encoding': 'gzip',
              'x-subscription-token': options.apiKey,
            }
          : { accept: 'application/json', 'x-api-key': options.apiKey };

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
          detail: redactKey(describe(error), options.apiKey),
        };
      }

      if (!response.ok) {
        return classifyStatus(response.status, response.headers);
      }

      let raw: string;

      try {
        raw = await response.text();
      } catch (error) {
        return {
          kind: 'malformed_response',
          detail: redactKey(describe(error), options.apiKey),
        };
      }

      let payload: unknown;

      try {
        payload = JSON.parse(raw) as unknown;
      } catch (error) {
        return {
          kind: 'malformed_response',
          detail: redactKey(describe(error), options.apiKey),
        };
      }

      const results =
        providerName === 'brave' ? readBrave(payload) : readSerper(payload);

      return { kind: 'results', results: results.slice(0, count) };
    },
  };
};
