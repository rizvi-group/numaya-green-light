/**
 * The HTTP adapter, driven against a fake `fetch`. No test here opens a socket.
 *
 * Two things are being pinned: that every wire condition maps to the right
 * outcome (especially the three that contradict the service's documentation),
 * and that the licence key does not survive into anything the adapter returns.
 */

import {
  LICENCE_ACTIVATE_PATH,
  LICENCE_ENVIRONMENT_HEADER,
  LICENCE_VALIDATE_PATH,
} from 'src/constants/licence-identifiers';
import {
  createHttpLicensingClient,
  type FetchLike,
} from 'src/logic-functions/licence-http-client';
import { SANDBOX_TRIAL_KEY } from 'src/licensing/__tests__/fixtures';
import { describe, expect, it } from 'vitest';

const BASE_URL = 'https://license.numaya.ai';

interface Recorded {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

const respondWith = (
  status: number,
  body: string,
  headers: Record<string, string> = {},
): { fetchImpl: FetchLike; calls: Recorded[] } => {
  const calls: Recorded[] = [];

  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as unknown, headers: init.headers });

    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: async () => body,
    };
  };

  return { fetchImpl, calls };
};

const throwingFetch =
  (error: unknown): FetchLike =>
  async () => {
    throw error;
  };

const VALID_BODY = JSON.stringify({
  valid: true,
  reason: null,
  hasFeature: true,
  features: ['rules', 'enrichment'],
  tier: 'Pro',
  type: 'Trial',
  daysRemaining: 14,
});

describe('request shape', () => {
  it('should POST to the base URL plus the validate path', async () => {
    const { fetchImpl, calls } = respondWith(200, VALID_BODY);

    await createHttpLicensingClient({ baseUrl: BASE_URL, fetchImpl }).validate({
      key: SANDBOX_TRIAL_KEY,
      deviceFingerprint: '20202020-1c25-4d02-bf25-6aef55b25000',
      feature: 'enrichment',
    });

    expect(calls[0]?.url).toBe(`${BASE_URL}${LICENCE_VALIDATE_PATH}`);
    expect(calls[0]?.body).toEqual({
      key: SANDBOX_TRIAL_KEY,
      deviceFingerprint: '20202020-1c25-4d02-bf25-6aef55b25000',
      feature: 'enrichment',
    });
  });

  it('should tolerate a trailing slash on the configured base URL', async () => {
    const { fetchImpl, calls } = respondWith(200, VALID_BODY);

    await createHttpLicensingClient({
      baseUrl: 'https://license.numaya.ai///',
      fetchImpl,
    }).validate({ key: SANDBOX_TRIAL_KEY });

    expect(calls[0]?.url).toBe(`${BASE_URL}${LICENCE_VALIDATE_PATH}`);
  });

  it('should omit an absent fingerprint and feature rather than sending nulls', async () => {
    const { fetchImpl, calls } = respondWith(200, VALID_BODY);

    await createHttpLicensingClient({ baseUrl: BASE_URL, fetchImpl }).validate({
      key: SANDBOX_TRIAL_KEY,
      deviceFingerprint: null,
      feature: null,
    });

    expect(calls[0]?.body).toEqual({ key: SANDBOX_TRIAL_KEY });
  });

  it('should send only the key, the fingerprint and the device name — no lead data can leak', async () => {
    const { fetchImpl, calls } = respondWith(200, '{"id":"act-1"}');

    await createHttpLicensingClient({ baseUrl: BASE_URL, fetchImpl }).activate({
      key: SANDBOX_TRIAL_KEY,
      deviceFingerprint: 'ws-1',
      deviceName: 'Acme Corp',
    });

    expect(calls[0]?.url).toBe(`${BASE_URL}${LICENCE_ACTIVATE_PATH}`);
    expect(Object.keys(calls[0]?.body as object).sort()).toEqual([
      'deviceFingerprint',
      'deviceName',
      'key',
    ]);
  });
});

describe('gotcha 4 — the environment header', () => {
  const headerOf = (calls: Recorded[]): string | undefined =>
    calls[0]?.headers[LICENCE_ENVIRONMENT_HEADER];

  it('should send the sandbox header when the client is pointed at sandbox', async () => {
    // Without this header a sandbox licence answers `200 valid:false
    // reason:license_not_found` — a plausible rejection on the happy status
    // code, which the fail-open ladder then hides perfectly.
    const { fetchImpl, calls } = respondWith(200, VALID_BODY);

    await createHttpLicensingClient({
      baseUrl: BASE_URL,
      environment: 'sandbox',
      fetchImpl,
    }).validate({ key: SANDBOX_TRIAL_KEY });

    expect(headerOf(calls)).toBe('sandbox');
  });

  it('should send it on activate too', async () => {
    // `activate` is environment-scoped the same way, and answers a misrouted
    // request with a 404 rather than a 200.
    const { fetchImpl, calls } = respondWith(200, '{"id":"act-1"}');

    await createHttpLicensingClient({
      baseUrl: BASE_URL,
      environment: 'sandbox',
      fetchImpl,
    }).activate({ key: SANDBOX_TRIAL_KEY, deviceFingerprint: 'ws-1' });

    expect(headerOf(calls)).toBe('sandbox');
  });

  it('should send no environment header at all for production', async () => {
    // Production is the service's own default. A header we send
    // unconditionally is one that has to be right unconditionally; omitting it
    // leaves the customer-facing path byte-for-byte what it was.
    for (const environment of ['production', undefined] as const) {
      const { fetchImpl, calls } = respondWith(200, VALID_BODY);

      await createHttpLicensingClient({
        baseUrl: BASE_URL,
        environment,
        fetchImpl,
      }).validate({ key: SANDBOX_TRIAL_KEY });

      expect(headerOf(calls)).toBeUndefined();
    }
  });
});

describe('validate — a failed validation is a 200, not an error', () => {
  it('should return a validated outcome for valid: false', async () => {
    const { fetchImpl } = respondWith(
      200,
      JSON.stringify({ valid: false, reason: 'suspended', hasFeature: true }),
    );

    const outcome = await createHttpLicensingClient({
      baseUrl: BASE_URL,
      fetchImpl,
    }).validate({ key: SANDBOX_TRIAL_KEY });

    expect(outcome.kind).toBe('validated');
    expect(outcome.kind === 'validated' && outcome.response.valid).toBe(false);
    expect(outcome.kind === 'validated' && outcome.response.reason).toBe('suspended');
    // Gotcha 1: the feature list survives suspension.
    expect(outcome.kind === 'validated' && outcome.response.hasFeature).toBe(true);
  });

  it('should return a validated outcome for a rules-only licence asked about enrichment', async () => {
    const { fetchImpl } = respondWith(
      200,
      JSON.stringify({ valid: true, reason: null, hasFeature: false, features: ['rules'] }),
    );

    const outcome = await createHttpLicensingClient({
      baseUrl: BASE_URL,
      fetchImpl,
    }).validate({ key: SANDBOX_TRIAL_KEY, feature: 'enrichment' });

    expect(outcome.kind === 'validated' && outcome.response.valid).toBe(true);
    expect(outcome.kind === 'validated' && outcome.response.hasFeature).toBe(false);
  });
});

describe('failure classification', () => {
  it('should classify 429 as rate limited and read Retry-After', async () => {
    const { fetchImpl } = respondWith(429, 'slow down', { 'retry-after': '120' });

    const outcome = await createHttpLicensingClient({
      baseUrl: BASE_URL,
      fetchImpl,
    }).validate({ key: SANDBOX_TRIAL_KEY });

    expect(outcome).toEqual({ kind: 'rate_limited', retryAfterSeconds: 120 });
  });

  it('should tolerate a Retry-After it cannot read', async () => {
    const { fetchImpl } = respondWith(429, '', { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' });

    const outcome = await createHttpLicensingClient({
      baseUrl: BASE_URL,
      fetchImpl,
    }).validate({ key: SANDBOX_TRIAL_KEY });

    expect(outcome).toEqual({ kind: 'rate_limited', retryAfterSeconds: null });
  });

  it('should classify 5xx as service unavailable', async () => {
    for (const status of [500, 502, 503, 504]) {
      const { fetchImpl } = respondWith(status, 'nope');

      const outcome = await createHttpLicensingClient({
        baseUrl: BASE_URL,
        fetchImpl,
      }).validate({ key: SANDBOX_TRIAL_KEY });

      expect(outcome).toEqual({ kind: 'service_unavailable', statusCode: status });
    }
  });

  it('should classify a 401 or 403 as the key being refused, not as an outage', async () => {
    // The key is the credential on these endpoints — it travels in the body in
    // place of an Authorization header. Measured live: an unknown key, and a
    // real key with one character altered, both return a bare 401. Reading that
    // as "cannot reach the licensing service" would send an admin to check DNS
    // over a typo.
    for (const status of [401, 403]) {
      const { fetchImpl } = respondWith(status, '');

      const outcome = await createHttpLicensingClient({
        baseUrl: BASE_URL,
        fetchImpl,
      }).validate({ key: SANDBOX_TRIAL_KEY });

      expect(outcome).toEqual({ kind: 'key_rejected', statusCode: status });
    }
  });

  it('should classify a 404 on validate as an unexpected status, not a missing licence', async () => {
    // `validate` reports a missing licence in-band, with a 200 and a reason. A
    // 404 there means the *path* was wrong — a misconfigured base URL — and
    // calling that "licence not found" would send an admin to check their
    // licence instead of their endpoint.
    const { fetchImpl } = respondWith(404, 'not found');

    const outcome = await createHttpLicensingClient({
      baseUrl: BASE_URL,
      fetchImpl,
    }).validate({ key: SANDBOX_TRIAL_KEY });

    expect(outcome).toEqual({ kind: 'unexpected_status', statusCode: 404 });
  });

  it('should classify a 404 on activate as the licence being absent from this environment', async () => {
    // Measured live: activating a sandbox licence without the sandbox header
    // returns `404 license_not_found`. It is the same cause as validate's
    // in-band `200 valid:false reason:license_not_found`, reported out of band.
    const { fetchImpl } = respondWith(
      404,
      JSON.stringify({ title: 'license_not_found', status: 404 }),
    );

    const outcome = await createHttpLicensingClient({
      baseUrl: BASE_URL,
      fetchImpl,
    }).activate({ key: SANDBOX_TRIAL_KEY, deviceFingerprint: 'ws-1' });

    expect(outcome).toEqual({ kind: 'licence_not_found', statusCode: 404 });
  });

  it('should classify a thrown fetch as a transport failure, never rethrowing', async () => {
    const client = createHttpLicensingClient({
      baseUrl: BASE_URL,
      fetchImpl: throwingFetch(new TypeError('fetch failed: ENOTFOUND license.numaya.ai')),
    });

    const outcome = await client.validate({ key: SANDBOX_TRIAL_KEY });

    expect(outcome.kind).toBe('transport_failure');
  });

  it('should classify an unconfigured base URL as a transport failure', async () => {
    // The failure mode of the unconfirmed default: it walks the same cached
    // entitlement ladder as a real outage rather than being a special case.
    const outcome = await createHttpLicensingClient({
      baseUrl: '   ',
      fetchImpl: throwingFetch(new Error('should not be called')),
    }).validate({ key: SANDBOX_TRIAL_KEY });

    expect(outcome.kind).toBe('transport_failure');
  });
});

describe('garbage responses', () => {
  const garbage = [
    ['an HTML error page', '<html><body>502 Bad Gateway</body></html>'],
    ['an empty body', ''],
    ['truncated JSON', '{"valid": tru'],
    ['a JSON array', '[1,2,3]'],
    ['a JSON error envelope', '{"error":true,"statusCode":500,"message":"boom"}'],
  ] as const;

  for (const [label, body] of garbage) {
    it(`should classify ${label} as malformed, never throwing`, async () => {
      const { fetchImpl } = respondWith(200, body);

      const outcome = await createHttpLicensingClient({
        baseUrl: BASE_URL,
        fetchImpl,
      }).validate({ key: SANDBOX_TRIAL_KEY });

      expect(outcome.kind).toBe('malformed_response');
    });
  }
});

describe('gotcha 3 — the activation limit is matched on the 409 alone', () => {
  it('should match the RFC 7807 body the REST layer actually sends', async () => {
    // Verbatim from the live service on 2026-08-04. The REST layer *does* carry
    // `title: max_activations_reached`; the MCP layer's body did not. Two
    // surfaces, two bodies, one status code — so the status code is what we
    // branch on, and the body is never inspected.
    const { fetchImpl } = respondWith(
      409,
      JSON.stringify({
        type: 'https://httpstatuses.io/409',
        title: 'max_activations_reached',
        status: 409,
        detail: 'Max activations reached for this license.',
        instance: '/v1/licenses/activate',
        retryable: false,
      }),
    );

    const outcome = await createHttpLicensingClient({
      baseUrl: BASE_URL,
      fetchImpl,
    }).activate({ key: SANDBOX_TRIAL_KEY, deviceFingerprint: 'ws-2' });

    expect(outcome).toEqual({ kind: 'activation_limit_reached' });
  });

  it('should match the older, title-less body just as well', async () => {
    // The body previously observed through the MCP layer. Both must work; only
    // the status code is load-bearing.
    const { fetchImpl } = respondWith(
      409,
      JSON.stringify({
        error: true,
        statusCode: 409,
        message: 'Max activations reached for this license.',
        retryable: false,
      }),
    );

    const outcome = await createHttpLicensingClient({
      baseUrl: BASE_URL,
      fetchImpl,
    }).activate({ key: SANDBOX_TRIAL_KEY, deviceFingerprint: 'ws-2' });

    expect(outcome).toEqual({ kind: 'activation_limit_reached' });
  });

  it('should match a 409 with an empty body just as well', async () => {
    const { fetchImpl } = respondWith(409, '');

    const outcome = await createHttpLicensingClient({
      baseUrl: BASE_URL,
      fetchImpl,
    }).activate({ key: SANDBOX_TRIAL_KEY, deviceFingerprint: 'ws-2' });

    expect(outcome).toEqual({ kind: 'activation_limit_reached' });
  });

  it('should not read a 409 on validate as an activation limit', async () => {
    // The 409 belongs to `activate`. Inventing a meaning for one on `validate`,
    // which has never been observed, would be exactly the sort of guess the
    // three gotchas are a warning about.
    const { fetchImpl } = respondWith(409, '{}');

    const outcome = await createHttpLicensingClient({
      baseUrl: BASE_URL,
      fetchImpl,
    }).validate({ key: SANDBOX_TRIAL_KEY });

    expect(outcome).toEqual({ kind: 'unexpected_status', statusCode: 409 });
  });
});

describe('activate success', () => {
  it('should read the activation id when present', async () => {
    const { fetchImpl } = respondWith(200, '{"id":"59e2bbaf-0000-4000-8000-000000000000"}');

    const outcome = await createHttpLicensingClient({
      baseUrl: BASE_URL,
      fetchImpl,
    }).activate({ key: SANDBOX_TRIAL_KEY, deviceFingerprint: 'ws-1' });

    expect(outcome).toEqual({
      kind: 'activated',
      activationId: '59e2bbaf-0000-4000-8000-000000000000',
    });
  });

  it('should still count as activated when the id is unreadable', async () => {
    // Nothing branches on the id. Refusing to record a claimed slot because the
    // response shape moved would be strictly worse than recording it blind.
    const { fetchImpl } = respondWith(200, '{}');

    const outcome = await createHttpLicensingClient({
      baseUrl: BASE_URL,
      fetchImpl,
    }).activate({ key: SANDBOX_TRIAL_KEY, deviceFingerprint: 'ws-1' });

    expect(outcome).toEqual({ kind: 'activated', activationId: null });
  });
});

describe('the licence key never survives into an outcome', () => {
  const containsKey = (value: unknown): boolean =>
    JSON.stringify(value ?? null).includes(SANDBOX_TRIAL_KEY);

  it('should redact a key echoed back inside a transport error', async () => {
    // `fetch` implementations do echo request details, and the message is not
    // ours to control — hence the belt-and-braces redaction.
    const client = createHttpLicensingClient({
      baseUrl: BASE_URL,
      fetchImpl: throwingFetch(
        new Error(`request failed: {"key":"${SANDBOX_TRIAL_KEY}"}`),
      ),
    });

    expect(containsKey(await client.validate({ key: SANDBOX_TRIAL_KEY }))).toBe(false);
  });

  it('should keep the key out of every failure outcome', async () => {
    const cases: FetchLike[] = [
      respondWith(429, SANDBOX_TRIAL_KEY).fetchImpl,
      respondWith(503, SANDBOX_TRIAL_KEY).fetchImpl,
      respondWith(404, SANDBOX_TRIAL_KEY).fetchImpl,
      respondWith(200, `garbage ${SANDBOX_TRIAL_KEY}`).fetchImpl,
      throwingFetch(new Error(SANDBOX_TRIAL_KEY)),
    ];

    for (const fetchImpl of cases) {
      const client = createHttpLicensingClient({ baseUrl: BASE_URL, fetchImpl });

      expect(containsKey(await client.validate({ key: SANDBOX_TRIAL_KEY }))).toBe(false);
      expect(
        containsKey(
          await client.activate({ key: SANDBOX_TRIAL_KEY, deviceFingerprint: 'ws-1' }),
        ),
      ).toBe(false);
    }
  });
});
