import { describe, expect, it } from 'vitest';

import {
  buildConfigUpgradePatch,
  buildGreenlightConfigSeed,
  isGateEnabled,
  readLeadObjectNameSingular,
  toScoringConfigInput,
} from 'src/logic-functions/greenlight-config-record';
import { buildDefaultConfig, resolveConfig } from 'src/scoring';

describe('seed <-> engine round trip', () => {
  it('resolves back to exactly the engine defaults, with nothing repaired', () => {
    const resolution = resolveConfig(
      toScoringConfigInput(buildGreenlightConfigSeed()),
    );

    // 'provided' means resolveConfig logged no degradation: the seeded record is
    // fully legible to the engine. If the adapter or the seed drifts, this is
    // the test that catches it.
    expect(resolution.source).toBe('provided');
    expect(resolution.degradations).toEqual([]);
    expect(resolution.config).toEqual(buildDefaultConfig());
  });
});

describe('record -> engine config adapter', () => {
  it('recombines ruleSettings and scoreWeights into one per-rule shape', () => {
    const [ruleId] = Object.keys(buildDefaultConfig().rules);

    const config = resolveConfig(
      toScoringConfigInput({
        ruleSettings: { [ruleId!]: { enabled: false, severity: 'minor' } },
        scoreWeights: { [ruleId!]: 7 },
      }),
    ).config;

    expect(config.rules[ruleId!]).toEqual({
      enabled: false,
      severity: 'minor',
      weight: 7,
    });
  });

  it('accepts isEnabled as an alias for enabled', () => {
    const [ruleId] = Object.keys(buildDefaultConfig().rules);

    const config = resolveConfig(
      toScoringConfigInput({
        ruleSettings: { [ruleId!]: { isEnabled: false } },
      }),
    ).config;

    expect(config.rules[ruleId!]?.enabled).toBe(false);
  });

  it('rebuilds the band array from the three threshold fields', () => {
    const config = resolveConfig(
      toScoringConfigInput({
        bandExcellentThreshold: 90,
        bandGoodThreshold: 75,
        bandFairThreshold: 55,
      }),
    ).config;

    expect(config.bands.map((band) => [band.id, band.minScore])).toEqual([
      ['excellent', 90],
      ['good', 75],
      ['fair', 55],
      ['poor', 0],
    ]);
  });

  it('unwraps icpSizeBands from its { bands } envelope', () => {
    const config = resolveConfig(
      toScoringConfigInput({
        icpSizeBands: {
          bands: [{ label: 'smb', minEmployees: 1, maxEmployees: 50 }],
        },
      }),
    ).config;

    expect(config.icp.sizeBands).toEqual([
      { label: 'smb', minEmployees: 1, maxEmployees: 50 },
    ]);
  });

  it('prepends a custom decision-maker field rather than replacing the defaults', () => {
    const config = resolveConfig(
      toScoringConfigInput({ decisionMakerFieldName: 'seniorityLabel' }),
    ).config;

    expect(config.fieldMapping.jobTitle[0]).toBe('seniorityLabel');
    expect(config.fieldMapping.jobTitle).toContain('jobTitle');
  });

  it('falls back cleanly on an unreadable record', () => {
    expect(toScoringConfigInput(null)).toBeUndefined();
    expect(toScoringConfigInput('nonsense')).toBeUndefined();
    expect(resolveConfig(toScoringConfigInput(undefined)).source).toBe(
      'defaults',
    );
  });
});

describe('record accessors', () => {
  it('treats an absent or unreadable gate flag as enabled', () => {
    expect(isGateEnabled(undefined)).toBe(true);
    expect(isGateEnabled({})).toBe(true);
    expect(isGateEnabled({ isGateEnabled: true })).toBe(true);
    expect(isGateEnabled({ isGateEnabled: false })).toBe(false);
  });

  it('maps the lead-object SELECT value to an API name', () => {
    expect(readLeadObjectNameSingular({ leadObjectNameSingular: 'PERSON' })).toBe(
      'person',
    );
    expect(
      readLeadObjectNameSingular({ leadObjectNameSingular: 'COMPANY' }),
    ).toBe('company');
    expect(readLeadObjectNameSingular(null)).toBe('person');
  });
});

/**
 * Twenty stores an empty `RAW_JSON` as `null`. Every earlier test in this file
 * compared the seed against a record shaped the way we *wrote* it, so none of
 * them could see that. The bug was found by running a real `app:install`
 * upgrade and reading the hook's logs.
 */
const asTwentyWouldStoreIt = (
  written: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(written).map(([key, value]) => [
      key,
      (Array.isArray(value) && value.length === 0) ||
      (typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0)
        ? null
        : value,
    ]),
  );

describe('upgrade patch convergence', () => {
  it('should have nothing to patch on a record it just seeded', () => {
    const stored = asTwentyWouldStoreIt(buildGreenlightConfigSeed());

    // Before the fix this returned { fieldShelfLives: {} } — forever, on every
    // upgrade, each one filing an audit row claiming a merge that never landed.
    expect(buildConfigUpgradePatch(stored)).toEqual({});
  });

  it('should still patch a key that is genuinely absent and carries a real value', () => {
    const stored = asTwentyWouldStoreIt(buildGreenlightConfigSeed());
    delete stored['gateThreshold'];

    expect(buildConfigUpgradePatch(stored)).toHaveProperty('gateThreshold');
  });

  it('should converge: applying the patch twice yields nothing the second time', () => {
    const stored = asTwentyWouldStoreIt(buildGreenlightConfigSeed());
    delete stored['gateThreshold'];

    const first = buildConfigUpgradePatch(stored);
    const after = asTwentyWouldStoreIt({ ...stored, ...first });

    expect(buildConfigUpgradePatch(after)).toEqual({});
  });
});
