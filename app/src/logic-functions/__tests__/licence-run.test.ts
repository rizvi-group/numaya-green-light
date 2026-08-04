/**
 * The composition root, driven entirely by fakes: no network, no key-value
 * store, no API client, and an injected clock.
 */

import {
  type CachedLicenceValidation,
  type LicenceActivationState,
  type LicenceState,
  type LicenceStorePort,
  type LicenceValidateOutcome,
} from 'src/licensing';
import {
  cachedEntitlement,
  fakeLicensingPort,
  hoursBefore,
  NOW,
  SANDBOX_TRIAL_KEY,
  validationResponse,
} from 'src/licensing/__tests__/fixtures';
import { DEFAULT_LICENCE_API_BASE_URL } from 'src/constants/licence-identifiers';
import { type GreenlightApiClient } from 'src/logic-functions/greenlight-api';
import {
  readLicenceEnvironment,
  runLicenceInstall,
  runLicenceRevalidation,
  type WorkspaceIdentityPort,
} from 'src/logic-functions/licence-run';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* -------------------------------------------------------------------------- */
/* Fakes                                                                       */
/* -------------------------------------------------------------------------- */

interface FakeStore extends LicenceStorePort {
  cache: CachedLicenceValidation | null;
  activation: LicenceActivationState;
  published: LicenceState | null;
  writes: number;
}

const fakeStore = (
  cache: CachedLicenceValidation | null = null,
  activation: LicenceActivationState = { status: 'unknown' },
): FakeStore => {
  const store: FakeStore = {
    cache,
    activation,
    published: null,
    writes: 0,
    readCache: async () => store.cache,
    writeCache: async (entry) => {
      store.cache = entry;
      store.writes += 1;
    },
    readActivation: async () => store.activation,
    writeActivation: async (state) => {
      store.activation = state;
    },
    publishState: async (state) => {
      store.published = state;
    },
  };

  return store;
};

const fakeIdentity = (
  workspaceId: string | null = '20202020-1c25-4d02-bf25-6aef55b25000',
): WorkspaceIdentityPort => ({
  read: async () =>
    workspaceId === null
      ? null
      : { workspaceId, workspaceName: 'Acme Corp' },
});

const fakeClient = (): {
  client: GreenlightApiClient;
  mutations: Record<string, unknown>[];
} => {
  const mutations: Record<string, unknown>[] = [];

  return {
    mutations,
    client: {
      query: async () => ({}),
      mutation: async (request) => {
        mutations.push(request);

        return {};
      },
    },
  };
};

const auditRowData = (mutation: Record<string, unknown>): Record<string, unknown> =>
  (
    (mutation['createGreenlightAuditLog'] as Record<string, unknown>)[
      '__args'
    ] as Record<string, unknown>
  )['data'] as Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* Log capture — the key must not reach stdout either                          */
/* -------------------------------------------------------------------------- */

let logged: string[] = [];

beforeEach(() => {
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map((value) => String(value)).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* Environment                                                                 */
/* -------------------------------------------------------------------------- */

describe('readLicenceEnvironment', () => {
  it('should read the key and the base URL from application variables', () => {
    expect(
      readLicenceEnvironment({
        LICENCE_KEY: SANDBOX_TRIAL_KEY,
        LICENCE_API_BASE_URL: 'https://licensing.internal',
      }),
    ).toEqual({
      licenceKey: SANDBOX_TRIAL_KEY,
      baseUrl: 'https://licensing.internal',
      environment: 'production',
    });
  });

  it('should select sandbox only for the exact value, forgiving case and padding', () => {
    for (const raw of ['sandbox', 'SANDBOX', ' Sandbox ']) {
      expect(readLicenceEnvironment({ LICENCE_ENVIRONMENT: raw }).environment).toBe(
        'sandbox',
      );
    }
  });

  it('should resolve every unrecognised environment value to production', () => {
    // The asymmetry is the point. A typo that quietly routed a paying customer
    // at the sandbox estate would put them in the exact failure this variable
    // was added to make visible — their licence does not exist there.
    for (const raw of ['', '  ', 'production', 'prod', 'sandbox-2', 'staging', 'SANDBOXX']) {
      expect(readLicenceEnvironment({ LICENCE_ENVIRONMENT: raw }).environment).toBe(
        'production',
      );
    }

    expect(readLicenceEnvironment({}).environment).toBe('production');
  });

  it('should treat a blank or absent key as the unlicensed configuration', () => {
    expect(readLicenceEnvironment({}).licenceKey).toBeNull();
    expect(readLicenceEnvironment({ LICENCE_KEY: '   ' }).licenceKey).toBeNull();
  });

  it('should trim a pasted key, because admins paste', () => {
    expect(
      readLicenceEnvironment({ LICENCE_KEY: `\n ${SANDBOX_TRIAL_KEY} ` }).licenceKey,
    ).toBe(SANDBOX_TRIAL_KEY);
  });

  it('should fall back to the shipped default base URL', () => {
    expect(readLicenceEnvironment({}).baseUrl).toBe(DEFAULT_LICENCE_API_BASE_URL);
    expect(readLicenceEnvironment({ LICENCE_API_BASE_URL: '  ' }).baseUrl).toBe(
      DEFAULT_LICENCE_API_BASE_URL,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Install                                                                     */
/* -------------------------------------------------------------------------- */

describe('install run', () => {
  it('should activate once, then validate, using the workspace id as the fingerprint', async () => {
    const licensing = fakeLicensingPort({
      kind: 'validated',
      response: validationResponse(),
    });
    const store = fakeStore();

    const outcome = await runLicenceInstall({
      licensing,
      store,
      identity: fakeIdentity(),
      licenceKey: SANDBOX_TRIAL_KEY,
      environment: 'production',
      now: NOW,
    });

    expect(licensing.calls.map((call) => call.method)).toEqual([
      'activate',
      'validate',
    ]);
    expect(outcome.activation).toBe('claimed');
    expect(outcome.state.mode).toBe('full');
    expect(store.activation).toEqual({ status: 'claimed', at: NOW.toISOString() });
  });

  it('should make no network call at all without a licence key', async () => {
    const licensing = fakeLicensingPort({
      kind: 'validated',
      response: validationResponse(),
    });

    const outcome = await runLicenceInstall({
      licensing,
      store: fakeStore(),
      identity: fakeIdentity(),
      licenceKey: null,
      environment: 'production',
      now: NOW,
    });

    expect(licensing.calls).toEqual([]);
    expect(outcome.state.reason).toBe('no_licence_key');
    expect(outcome.state.mode).toBe('rules-only');
  });

  it('should validate without a fingerprint when the workspace cannot be identified', async () => {
    // Losing the fingerprint costs a readable device name in Numaya's admin
    // view. Failing the check would cost the customer their entitlement.
    const licensing = fakeLicensingPort({
      kind: 'validated',
      response: validationResponse(),
    });

    const outcome = await runLicenceInstall({
      licensing,
      store: fakeStore(),
      identity: fakeIdentity(null),
      licenceKey: SANDBOX_TRIAL_KEY,
      environment: 'production',
      now: NOW,
    });

    expect(licensing.calls.map((call) => call.method)).toEqual(['validate']);
    expect(outcome.activation).toBe('skipped');
    expect(outcome.state.mode).toBe('full');
  });

  it('should persist a 409 so the nightly run cannot undo it', async () => {
    const store = fakeStore();

    const outcome = await runLicenceInstall({
      licensing: fakeLicensingPort(
        { kind: 'validated', response: validationResponse() },
        { kind: 'activation_limit_reached' },
      ),
      store,
      identity: fakeIdentity(),
      licenceKey: SANDBOX_TRIAL_KEY,
      environment: 'production',
      now: NOW,
    });

    expect(outcome.activation).toBe('limit_reached');
    expect(store.activation.status).toBe('limit_reached');
    // Validation succeeded — gotcha 2 means slots are not consulted — yet the
    // workspace is still rules-only.
    expect(outcome.state.observedValid).toBe(true);
    expect(outcome.state.mode).toBe('rules-only');
    expect(outcome.state.reason).toBe('max_activations_reached');
  });

  it('should keep the sticky 409 in force on the next nightly run', async () => {
    const store = fakeStore(null, {
      status: 'limit_reached',
      at: NOW.toISOString(),
    });

    const outcome = await runLicenceRevalidation({
      licensing: fakeLicensingPort({
        kind: 'validated',
        response: validationResponse(),
      }),
      store,
      identity: fakeIdentity(),
      licenceKey: SANDBOX_TRIAL_KEY,
      environment: 'production',
      now: NOW,
    });

    expect(outcome.state.mode).toBe('rules-only');
    expect(outcome.state.reason).toBe('max_activations_reached');
  });

  it('should clear a previous 409 when a reinstall claims a slot', async () => {
    const store = fakeStore(null, {
      status: 'limit_reached',
      at: hoursBefore(48).toISOString(),
    });

    const outcome = await runLicenceInstall({
      licensing: fakeLicensingPort({
        kind: 'validated',
        response: validationResponse(),
      }),
      store,
      identity: fakeIdentity(),
      licenceKey: SANDBOX_TRIAL_KEY,
      environment: 'production',
      now: NOW,
    });

    expect(store.activation.status).toBe('claimed');
    expect(outcome.state.mode).toBe('full');
  });

  it('should leave a known activation state alone when activation fails in transport', async () => {
    // A network blip tells us nothing about the slot. Overwriting `claimed`
    // with `unknown` would be losing information, not recording it.
    const store = fakeStore(null, {
      status: 'claimed',
      at: hoursBefore(48).toISOString(),
    });

    await runLicenceInstall({
      licensing: fakeLicensingPort(
        { kind: 'validated', response: validationResponse() },
        { kind: 'transport_failure', detail: 'ENOTFOUND' },
      ),
      store,
      identity: fakeIdentity(),
      licenceKey: SANDBOX_TRIAL_KEY,
      environment: 'production',
      now: NOW,
    });

    expect(store.activation.status).toBe('claimed');
  });
});

/* -------------------------------------------------------------------------- */
/* Nightly                                                                     */
/* -------------------------------------------------------------------------- */

describe('nightly re-validation', () => {
  it('should validate and never activate', async () => {
    const licensing = fakeLicensingPort({
      kind: 'validated',
      response: validationResponse(),
    });

    await runLicenceRevalidation({
      licensing,
      store: fakeStore(),
      identity: fakeIdentity(),
      licenceKey: SANDBOX_TRIAL_KEY,
      environment: 'production',
      now: NOW,
    });

    expect(licensing.calls.map((call) => call.method)).toEqual(['validate']);
  });

  it('should refresh the cache after a live validation', async () => {
    const store = fakeStore(
      cachedEntitlement({ cachedAt: hoursBefore(20).toISOString() }),
    );

    await runLicenceRevalidation({
      licensing: fakeLicensingPort({
        kind: 'validated',
        response: validationResponse(),
      }),
      store,
      identity: fakeIdentity(),
      licenceKey: SANDBOX_TRIAL_KEY,
      environment: 'production',
      now: NOW,
    });

    expect(store.cache?.cachedAt).toBe(NOW.toISOString());
    expect(store.writes).toBe(1);
  });

  const FAILURES: LicenceValidateOutcome[] = [
    { kind: 'transport_failure', detail: 'ENOTFOUND' },
    { kind: 'service_unavailable', statusCode: 503 },
    { kind: 'rate_limited', retryAfterSeconds: 60 },
    { kind: 'malformed_response', detail: 'not json' },
    { kind: 'unexpected_status', statusCode: 404 },
  ];

  for (const failure of FAILURES) {
    it(`should never touch the cache after ${failure.kind}`, async () => {
      const store = fakeStore(
        cachedEntitlement({ cachedAt: hoursBefore(20).toISOString() }),
      );

      await runLicenceRevalidation({
        licensing: fakeLicensingPort(failure),
        store,
        identity: fakeIdentity(),
        licenceKey: SANDBOX_TRIAL_KEY,
        environment: 'production',
        now: NOW,
      });

      expect(store.writes).toBe(0);
      expect(store.cache?.cachedAt).toBe(hoursBefore(20).toISOString());
    });
  }

  it('should publish state on every run, including failures', async () => {
    for (const failure of FAILURES) {
      const store = fakeStore();

      await runLicenceRevalidation({
        licensing: fakeLicensingPort(failure),
        store,
        identity: fakeIdentity(),
        licenceKey: SANDBOX_TRIAL_KEY,
        environment: 'production',
        now: NOW,
      });

      expect(store.published, failure.kind).not.toBeNull();
      expect(store.published?.mode).toBe('rules-only');
    }
  });

  it('should not throw when the port misbehaves and throws', async () => {
    // `LicensingPort` is documented as never throwing, but "documented" is not
    // "enforced" — a cron run that dies before publishing state leaves
    // yesterday's answer in place indefinitely.
    const store = fakeStore();

    const outcome = await runLicenceRevalidation({
      licensing: {
        validate: async () => {
          throw new Error(`boom ${SANDBOX_TRIAL_KEY}`);
        },
        activate: async () => ({ kind: 'activated', activationId: null }),
      },
      store,
      identity: fakeIdentity(),
      licenceKey: SANDBOX_TRIAL_KEY,
      environment: 'production',
      now: NOW,
    });

    expect(outcome.state.mode).toBe('rules-only');
    expect(store.published).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Audit                                                                       */
/* -------------------------------------------------------------------------- */

describe('audit', () => {
  it('should write one row per validation', async () => {
    const { client, mutations } = fakeClient();

    await runLicenceRevalidation({
      licensing: fakeLicensingPort({
        kind: 'validated',
        response: validationResponse(),
      }),
      store: fakeStore(),
      identity: fakeIdentity(),
      client,
      licenceKey: SANDBOX_TRIAL_KEY,
      environment: 'production',
      now: NOW,
    });

    expect(mutations).toHaveLength(1);
    expect(auditRowData(mutations[0]!)).toMatchObject({
      eventType: 'LICENCE',
      actorType: 'SYSTEM',
    });
  });

  it('should record the two booleans, the reason, cached-vs-live and the mode', async () => {
    const { client, mutations } = fakeClient();

    await runLicenceRevalidation({
      licensing: fakeLicensingPort({ kind: 'transport_failure', detail: 'ENOTFOUND' }),
      store: fakeStore(cachedEntitlement({ hasFeature: false })),
      identity: fakeIdentity(),
      client,
      licenceKey: SANDBOX_TRIAL_KEY,
      environment: 'production',
      now: NOW,
    });

    expect(auditRowData(mutations[0]!)['ruleTrace']).toMatchObject({
      valid: true,
      hasFeature: false,
      reason: 'feature_not_licensed',
      cached: true,
      source: 'cache',
      mode: 'rules-only',
      failureKind: 'transport_failure',
      checkedAt: NOW.toISOString(),
    });
  });

  it('should still resolve and publish state when the audit write fails', async () => {
    const store = fakeStore();

    const outcome = await runLicenceRevalidation({
      licensing: fakeLicensingPort({
        kind: 'validated',
        response: validationResponse(),
      }),
      store,
      identity: fakeIdentity(),
      client: {
        query: async () => ({}),
        mutation: async () => {
          throw new Error('audit object missing');
        },
      },
      licenceKey: SANDBOX_TRIAL_KEY,
      environment: 'production',
      now: NOW,
    });

    expect(outcome.state.mode).toBe('full');
    expect(store.published?.mode).toBe('full');
  });
});

/* -------------------------------------------------------------------------- */
/* Secret containment, end to end                                              */
/* -------------------------------------------------------------------------- */

describe('the licence key never leaves the edge', () => {
  const SECRET_FRAGMENTS = [SANDBOX_TRIAL_KEY, 'VN3D3', 'ZUDPJ', 'FKCW4'];

  const OUTCOMES: LicenceValidateOutcome[] = [
    { kind: 'validated', response: validationResponse() },
    { kind: 'validated', response: validationResponse({ valid: false, reason: 'revoked' }) },
    { kind: 'transport_failure', detail: `boom ${SANDBOX_TRIAL_KEY}` },
    { kind: 'malformed_response', detail: `garbage ${SANDBOX_TRIAL_KEY}` },
    { kind: 'rate_limited', retryAfterSeconds: 60 },
    { kind: 'service_unavailable', statusCode: 503 },
  ];

  for (const outcome of OUTCOMES) {
    it(`should keep it out of logs, published state and audit rows for ${outcome.kind}`, async () => {
      const { client, mutations } = fakeClient();
      const store = fakeStore(cachedEntitlement());

      const result = await runLicenceInstall({
        licensing: fakeLicensingPort(outcome),
        store,
        identity: fakeIdentity(),
        client,
        licenceKey: SANDBOX_TRIAL_KEY,
        environment: 'production',
        now: NOW,
      });

      const surfaces = [
        logged.join('\n'),
        JSON.stringify(store.published),
        JSON.stringify(store.cache),
        JSON.stringify(store.activation),
        JSON.stringify(mutations),
        JSON.stringify(result.state),
        JSON.stringify(result.notice),
      ].join('\n');

      for (const fragment of SECRET_FRAGMENTS) {
        expect(surfaces, `${outcome.kind} leaked ${fragment}`).not.toContain(fragment);
      }
    });
  }

  it('should still log something useful — the mask identifies which key', async () => {
    await runLicenceRevalidation({
      licensing: fakeLicensingPort({
        kind: 'validated',
        response: validationResponse(),
      }),
      store: fakeStore(),
      identity: fakeIdentity(),
      licenceKey: SANDBOX_TRIAL_KEY,
      environment: 'production',
      now: NOW,
    });

    const output = logged.join('\n');

    expect(output).toContain('licence_resolved');
    expect(output).toMatch(/NUMAYA-\\?\*{5}/);
  });
});
