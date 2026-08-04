/**
 * The HTTP adapter for the Numaya licensing service — the only module in
 * Greenlight that opens a socket to Numaya.
 *
 * It implements `LicensingPort`, which is what keeps `src/licensing/` testable
 * without a network: every test in this repo drives the core through a fake
 * port, and this file is exercised on its own against a fake `fetch`.
 *
 * ===========================================================================
 * ## It never throws
 *
 * Both methods return a discriminated outcome instead. A thrown error crossing
 * this boundary would have to be caught identically at every call site, and the
 * call sites are a cron handler and an install hook — places where one missing
 * `catch` is a workspace that silently stops re-validating and nobody notices
 * for a month. Making failure a return value makes the compiler enumerate it.
 *
 * ## What the status codes mean here
 *
 * | Wire                              | Outcome                      | Why |
 * |-----------------------------------|------------------------------|-----|
 * | `200` + `{ valid: false, … }`     | `validated`                  | **Not an error.** A failed validation is a normal 200; the caller branches on the boolean. |
 * | `200` + unparseable body          | `malformed_response`         | A proxy error page, or a schema change. |
 * | `401` / `403`                     | `key_rejected`               | The key **is** the credential here. Measured: an unknown or mistyped key gets a bare `401`. |
 * | `404`                             | `licence_not_found`          | On `activate`, this is the misrouted-environment failure. See below. |
 * | `409` on `activate`               | `activation_limit_reached`   | Matched on the **status code**, never on a title — see below. |
 * | `429`                             | `rate_limited`               | Honours `Retry-After` if present. |
 * | `500` / `502` / `503` / `504`     | `service_unavailable`        | Numaya-side, retriable on the next run. |
 * | anything else non-2xx             | `unexpected_status`          | Deliberately not silently retried. |
 * | thrown (DNS, TLS, timeout, abort) | `transport_failure`          | Includes a base URL that does not resolve. |
 *
 * ### Gotcha 3 — match the activation limit on the status code
 *
 * The REST layer answers a consumed licence with RFC 7807 problem details:
 *
 * ```json
 * { "type": "https://httpstatuses.io/409", "title": "max_activations_reached",
 *   "status": 409, "detail": "Max activations reached for this license.",
 *   "instance": "/v1/licenses/activate", "retryable": false }
 * ```
 *
 * The `title` is present over REST, and absent from the body previously observed
 * through the MCP layer — which is exactly why the match is
 * `response.status === 409` and only that. The status code is the half of the
 * contract both surfaces agree on. The body is never inspected.
 *
 * ### Gotcha 4 — `activate` reports a wrong environment as a `404`
 *
 * `validate` hides a misrouted environment inside a `200` (see
 * `src/licensing/entitlement.ts`). `activate` does not — it returns a bare
 * `404 license_not_found`. Classifying that as `unexpected_status` would bury
 * the clearest signal the service gives us, so it gets its own kind and lands on
 * the same admin notice as the `200` form.
 *
 * ## The licence key does not appear in anything this module returns
 *
 * Failure details are built from the error's name and message, then passed
 * through `redactLicenceKey`. That second step is belt-and-braces: the messages
 * come from `fetch`, from `JSON.parse` and from future runtimes, none of which
 * we control, and at least one plausible implementation echoes the request. Both
 * the raw and URL-encoded forms are replaced.
 * ===========================================================================
 */

import {
  DEFAULT_LICENCE_ENVIRONMENT,
  LICENCE_ACTIVATE_PATH,
  LICENCE_ENVIRONMENT_HEADER,
  LICENCE_REQUEST_FIELDS,
  LICENCE_VALIDATE_PATH,
} from 'src/constants/licence-identifiers';
import { parseValidationResponse } from 'src/licensing/parse';
import { redactLicenceKey } from 'src/licensing/mask';
import {
  type LicenceActivateOutcome,
  type LicenceCallFailure,
  type LicenceEnvironmentName,
  type LicensingPort,
  type LicenceValidateOutcome,
} from 'src/licensing/types';

/** Injected so tests never touch the network and never need a timer. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface HttpLicensingClientOptions {
  readonly baseUrl: string;
  /**
   * Which side of the service to ask. Optional, and `production` when omitted —
   * the same default the application variable ships with, so a caller that has
   * not been updated behaves exactly as this client did before the header
   * existed rather than silently switching a customer to sandbox.
   */
  readonly environment?: LicenceEnvironmentName;
  readonly fetchImpl?: FetchLike | null;
  /**
   * 8 seconds. The nightly cron is given 30s and the install hook 60s, so this
   * leaves room for the surrounding API writes. A licence check that takes
   * longer than eight seconds is a service that is down, not a service that is
   * slow, and the cache ladder is a better answer than waiting.
   */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;

const describe = (error: unknown): string => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return typeof error === 'string' ? error : 'unknown transport error';
};

/**
 * `Retry-After` is defined as either seconds or an HTTP date. Only the numeric
 * form is read: the date form would need a clock, and this value is advisory —
 * it is recorded for the audit row and never used to schedule anything, because
 * the next attempt is tomorrow's cron regardless.
 */
const readRetryAfter = (headers: { get(name: string): string | null }): number | null => {
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
): LicenceCallFailure => {
  if (status === 429) {
    return { kind: 'rate_limited', retryAfterSeconds: readRetryAfter(headers) };
  }

  if (status >= 500) {
    return { kind: 'service_unavailable', statusCode: status };
  }

  // The licence key is the credential on these endpoints — it travels in the
  // request body in place of an `Authorization` header — so a 401 means the
  // service does not recognise the key at all, in any environment. Measured
  // live: an unknown key, and a real key with one character changed, both
  // return `401` with an empty body.
  if (status === 401 || status === 403) {
    return { kind: 'key_rejected', statusCode: status };
  }

  // Note what is *not* here: `404`. On `validate` a 404 means the path was
  // wrong — a misconfigured base URL — not that the licence is missing, because
  // `validate` reports a missing licence in-band with a `200`. Only `activate`
  // uses 404 to mean "no such licence", and that is handled at its call site.
  return { kind: 'unexpected_status', statusCode: status };
};

const timeoutSignal = (timeoutMs: number): AbortSignal | undefined => {
  // `AbortSignal.timeout` is available on Node 20+ and in the logic-function
  // runtime; guarded anyway so a fake `fetch` in a stripped environment does not
  // take the whole module down over a nicety.
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }

  return undefined;
};

const normaliseBaseUrl = (baseUrl: string): string =>
  baseUrl.trim().replace(/\/+$/, '');

/**
 * Build the licensing client.
 *
 * A blank base URL is not an error to throw — it is a configuration the admin
 * has not finished, and it produces a `transport_failure` so it walks the same
 * cache → grace → rules-only ladder as a real outage. One ladder, one set of
 * tests, no special case.
 */
export const createHttpLicensingClient = (
  options: HttpLicensingClientOptions,
): LicensingPort => {
  const baseUrl = normaliseBaseUrl(options.baseUrl ?? '');
  const environment = options.environment ?? DEFAULT_LICENCE_ENVIRONMENT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /**
   * The header is sent **only** for sandbox. Production is the service's own
   * default, so sending `X-Numaya-Environment: production` would be a no-op that
   * every request then carries — and a header we send unconditionally is one
   * that has to be right unconditionally. Omitting it keeps the production path
   * byte-for-byte what it was before this feature existed.
   */
  const environmentHeaders: Record<string, string> =
    environment === 'sandbox' ? { [LICENCE_ENVIRONMENT_HEADER]: 'sandbox' } : {};
  const doFetch =
    options.fetchImpl ??
    (typeof globalThis.fetch === 'function'
      ? (globalThis.fetch as unknown as FetchLike)
      : null);

  const post = async (
    path: string,
    body: Record<string, unknown>,
    key: string,
  ): Promise<
    | { kind: 'ok'; payload: unknown }
    | { kind: 'status'; status: number; headers: { get(name: string): string | null } }
    | LicenceCallFailure
  > => {
    if (baseUrl.length === 0) {
      return {
        kind: 'transport_failure',
        detail: 'LICENCE_API_BASE_URL is not configured',
      };
    }

    if (doFetch === null) {
      return {
        kind: 'transport_failure',
        detail: 'no fetch implementation available in this runtime',
      };
    }

    let response: Awaited<ReturnType<FetchLike>>;

    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...environmentHeaders,
        },
        body: JSON.stringify(body),
        signal: timeoutSignal(timeoutMs),
      });
    } catch (error) {
      return {
        kind: 'transport_failure',
        detail: redactLicenceKey(describe(error), key),
      };
    }

    if (!response.ok) {
      return { kind: 'status', status: response.status, headers: response.headers };
    }

    let raw: string;

    try {
      raw = await response.text();
    } catch (error) {
      return {
        kind: 'malformed_response',
        detail: redactLicenceKey(describe(error), key),
      };
    }

    try {
      return { kind: 'ok', payload: JSON.parse(raw) as unknown };
    } catch (error) {
      return {
        kind: 'malformed_response',
        detail: redactLicenceKey(describe(error), key),
      };
    }
  };

  return {
    validate: async ({ key, deviceFingerprint, feature }): Promise<LicenceValidateOutcome> => {
      const body: Record<string, unknown> = { [LICENCE_REQUEST_FIELDS.key]: key };

      if (typeof deviceFingerprint === 'string' && deviceFingerprint.length > 0) {
        body[LICENCE_REQUEST_FIELDS.deviceFingerprint] = deviceFingerprint;
      }

      if (typeof feature === 'string' && feature.length > 0) {
        body[LICENCE_REQUEST_FIELDS.feature] = feature;
      }

      const result = await post(LICENCE_VALIDATE_PATH, body, key);

      if (result.kind === 'status') {
        // A 409 on `validate` is not the activation-limit error — that only
        // arises from `activate`. Left as an unexpected status rather than
        // pattern-matched into something more specific we have never observed.
        return classifyStatus(result.status, result.headers);
      }

      if (result.kind !== 'ok') {
        return result;
      }

      const parsed = parseValidationResponse(result.payload);

      return parsed.kind === 'parsed'
        ? { kind: 'validated', response: parsed.response }
        : { kind: 'malformed_response', detail: parsed.detail };
    },

    activate: async ({
      key,
      deviceFingerprint,
      deviceName,
    }): Promise<LicenceActivateOutcome> => {
      const body: Record<string, unknown> = {
        [LICENCE_REQUEST_FIELDS.key]: key,
        [LICENCE_REQUEST_FIELDS.deviceFingerprint]: deviceFingerprint,
      };

      if (typeof deviceName === 'string' && deviceName.length > 0) {
        body[LICENCE_REQUEST_FIELDS.deviceName] = deviceName;
      }

      const result = await post(LICENCE_ACTIVATE_PATH, body, key);

      if (result.kind === 'status') {
        // Gotcha 3. Status code only — the two surfaces disagree about the body.
        if (result.status === 409) {
          return { kind: 'activation_limit_reached' };
        }

        // Gotcha 4. `activate` has no in-band way to say "not found", so it uses
        // a 404 — measured live, that is exactly what a sandbox licence returns
        // when the request is routed to production.
        if (result.status === 404) {
          return { kind: 'licence_not_found', statusCode: 404 };
        }

        return classifyStatus(result.status, result.headers);
      }

      if (result.kind !== 'ok') {
        return result;
      }

      // Activation is idempotent on the fingerprint and returns the existing
      // activation id on a repeat call, so the id is informational: nothing
      // branches on it. A body we cannot read is therefore still a successful
      // activation — refusing to record the claimed slot because the id was
      // missing would be strictly worse.
      const payload = result.payload;
      const id =
        typeof payload === 'object' && payload !== null
          ? ((payload as Record<string, unknown>)['id'] ??
            (payload as Record<string, unknown>)['activationId'])
          : null;

      return { kind: 'activated', activationId: typeof id === 'string' ? id : null };
    },
  };
};
