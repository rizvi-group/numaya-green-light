import { describe, expect, it } from 'vitest';

import {
  buildConfigUpgradePatch,
  buildGreenlightConfigSeed,
} from 'src/logic-functions/greenlight-config-record';
import { runPostInstall, runUninstall } from 'src/logic-functions/install-run';
import { buildDefaultConfig } from 'src/scoring';

import {
  asConnection,
  createFakeClient,
  mutationData,
} from 'src/logic-functions/__tests__/fake-client';

const noConfigs = () => asConnection('greenlightConfigs', []);

const oneConfig = (overrides: Record<string, unknown> = {}) =>
  asConnection('greenlightConfigs', [
    {
      id: 'config-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      ...buildGreenlightConfigSeed(),
      ...overrides,
    },
  ]);

describe('post-install seeding', () => {
  it('creates exactly one config record on a fresh install', async () => {
    const client = createFakeClient({
      query: () => noConfigs(),
      mutation: () => ({ createGreenlightConfig: { id: 'config-1' } }),
    });

    const outcome = await runPostInstall({
      client,
      payload: { newVersion: '0.1.0' },
    });

    expect(outcome).toEqual({ status: 'seeded', configId: 'config-1' });
    expect(
      client.mutationNames().filter((name) => name === 'createGreenlightConfig'),
    ).toHaveLength(1);
  });

  it('seeds the engine defaults, not the field-manifest defaults', async () => {
    const client = createFakeClient({ query: () => noConfigs() });

    await runPostInstall({ client, payload: { newVersion: '0.1.0' } });

    const data = mutationData(client.callsTo('createGreenlightConfig')[0]!);
    const defaults = buildDefaultConfig();

    expect(data['gateThreshold']).toBe(defaults.gateThreshold);
    expect(data['bandExcellentThreshold']).toBe(85);
    expect(data['bandGoodThreshold']).toBe(70);
    expect(data['bandFairThreshold']).toBe(50);
    expect(data['decisionMakerMatchValues']).toEqual([
      ...defaults.decisionMakerTitles,
    ]);
    expect(Object.keys(data['ruleSettings'] as object)).toEqual(
      Object.keys(defaults.rules),
    );
  });

  it('is idempotent: a retry after a successful create writes nothing', async () => {
    const client = createFakeClient({ query: () => oneConfig() });

    const outcome = await runPostInstall({
      client,
      payload: { newVersion: '0.1.0' },
    });

    expect(outcome).toEqual({ status: 'already_seeded', configCount: 1 });
    expect(client.mutationNames()).toHaveLength(0);
  });

  it('running the whole hook twice creates only one record', async () => {
    const created: Record<string, unknown>[] = [];
    const client = createFakeClient({
      query: () =>
        created.length === 0
          ? noConfigs()
          : asConnection('greenlightConfigs', [
              { id: 'config-1', createdAt: '2026-01-01T00:00:00.000Z', ...created[0] },
            ]),
      mutation: (request) => {
        const call = request['createGreenlightConfig'] as
          | Record<string, unknown>
          | undefined;

        if (call !== undefined) {
          created.push(mutationData(call));
        }

        return { createGreenlightConfig: { id: 'config-1' } };
      },
    });

    await runPostInstall({ client, payload: { newVersion: '0.1.0' } });
    await runPostInstall({ client, payload: { newVersion: '0.1.0' } });

    expect(created).toHaveLength(1);
  });
});

describe('post-install upgrade merge', () => {
  it('does nothing when the record already covers every shipped key', async () => {
    const client = createFakeClient({ query: () => oneConfig() });

    const outcome = await runPostInstall({
      client,
      payload: { previousVersion: '0.1.0', newVersion: '0.2.0' },
    });

    expect(outcome).toEqual({ status: 'up_to_date', configId: 'config-1' });
    expect(client.mutationNames()).toHaveLength(0);
  });

  it('fills a key added by the new release without touching tuned values', async () => {
    const client = createFakeClient({
      query: () =>
        oneConfig({
          gateThreshold: 72,
          icpIndustries: ['manufacturing'],
          defaultShelfLifeDays: null,
        }),
    });

    const outcome = await runPostInstall({
      client,
      payload: { previousVersion: '0.1.0', newVersion: '0.2.0' },
    });

    expect(outcome.status).toBe('merged');

    const data = mutationData(client.callsTo('updateGreenlightConfig')[0]!);

    expect(Object.keys(data)).toEqual(['defaultShelfLifeDays']);
    expect(data['gateThreshold']).toBeUndefined();
    expect(data['icpIndustries']).toBeUndefined();
  });

  it('adds a newly-shipped rule without disturbing existing rule settings', async () => {
    const defaults = buildDefaultConfig();
    const [firstRuleId, ...rest] = Object.keys(defaults.rules);
    const tuned = { enabled: false, severity: 'advisory' };

    const client = createFakeClient({
      query: () =>
        oneConfig({
          // The workspace has tuned one rule and has never seen the others.
          ruleSettings: { [firstRuleId!]: tuned },
          scoreWeights: { [firstRuleId!]: 99 },
        }),
    });

    await runPostInstall({
      client,
      payload: { previousVersion: '0.0.9', newVersion: '0.1.0' },
    });

    const data = mutationData(client.callsTo('updateGreenlightConfig')[0]!);
    const ruleSettings = data['ruleSettings'] as Record<string, unknown>;
    const scoreWeights = data['scoreWeights'] as Record<string, unknown>;

    expect(ruleSettings[firstRuleId!]).toEqual(tuned);
    expect(scoreWeights[firstRuleId!]).toBe(99);

    for (const ruleId of rest) {
      expect(ruleSettings[ruleId]).toBeDefined();
      expect(scoreWeights[ruleId]).toBe(defaults.rules[ruleId]!.weight);
    }
  });

  it('never resets a deliberately-empty list back to the seed', () => {
    const patch = buildConfigUpgradePatch({
      ...buildGreenlightConfigSeed(),
      icpIndustries: [],
      optOutFieldNames: [],
      fieldShelfLives: {},
      gateThreshold: 0,
    });

    expect(patch).toEqual({});
  });

  it('treats a config record it cannot read as entirely missing', () => {
    const patch = buildConfigUpgradePatch(null);
    const seed = buildGreenlightConfigSeed();

    // Everything except the intentionally-null seed values, and except seeds
    // whose value is empty. Twenty stores an empty RAW_JSON as `null`, so
    // writing `{}` over a missing key leaves it reading `null` again and the
    // patch never converges — every upgrade would re-patch the same key and
    // file an audit row for a merge that never landed. An empty seed written
    // over a missing field is a no-op, so it is skipped and the field
    // manifest's own default stands. See `isNoOpSeed`.
    const isEmpty = (value: unknown) =>
      (Array.isArray(value) && value.length === 0) ||
      (typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0);

    expect(Object.keys(patch).sort()).toEqual(
      Object.entries(seed)
        .filter(([, value]) => value !== null && !isEmpty(value))
        .map(([key]) => key)
        .sort(),
    );
  });
});

describe('uninstall hook', () => {
  it('reports what it observed and performs no cleanup', async () => {
    const client = createFakeClient({ query: () => oneConfig() });

    const outcome = await runUninstall({
      client,
      payload: { version: '0.1.0' },
    });

    expect(outcome).toEqual({
      version: '0.1.0',
      configRecordsObserved: 1,
      cleanupPerformed: 'none',
    });
    expect(client.mutationNames()).toHaveLength(0);
  });

  it('never throws, even when the API is unreachable', async () => {
    const client = createFakeClient({
      query: () => {
        throw new Error('connection refused');
      },
    });

    await expect(
      runUninstall({ client, payload: {} }),
    ).resolves.toMatchObject({ version: null, configRecordsObserved: 0 });
  });
});
