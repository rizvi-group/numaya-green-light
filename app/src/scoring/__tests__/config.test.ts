import { ENRICHED_FIELD_MAPPING_PATHS } from 'src/enrichment/field-specs';
import { buildDefaultConfig, resolveConfig } from 'src/scoring/config';
import {
  DEFAULT_BANDS,
  DEFAULT_FIELD_MAPPING,
  DEFAULT_GATE_THRESHOLD,
} from 'src/scoring/defaults';
import { ALL_RULES } from 'src/scoring/rules';
import type { LeadFieldKey } from 'src/scoring/types';
import { describe, expect, it } from 'vitest';
import { stubRule } from 'src/scoring/__tests__/test-helpers';

const codeList = (resolution: { degradations: readonly { code: string }[] }): string[] =>
  resolution.degradations.map((degradation) => degradation.code);

const enrichedEntries = Object.entries(ENRICHED_FIELD_MAPPING_PATHS) as [
  LeadFieldKey,
  string,
][];

describe('buildDefaultConfig', () => {
  it('seeds a setting for every rule in the catalogue', () => {
    const config = buildDefaultConfig();

    for (const rule of ALL_RULES) {
      expect(config.rules[rule.id]).toEqual({
        enabled: rule.defaultEnabled,
        severity: rule.defaultSeverity,
        weight: rule.defaultWeight,
      });
    }
  });

  it('starts permissive: no ICP opinion until an admin sets one', () => {
    const config = buildDefaultConfig();

    expect(config.icp.industries).toHaveLength(0);
    expect(config.icp.regions).toHaveLength(0);
    expect(config.icp.sizeBands).toHaveLength(0);
    expect(config.gateThreshold).toBe(DEFAULT_GATE_THRESHOLD);
    expect(config.bands).toEqual(DEFAULT_BANDS);
  });
});

describe('resolveConfig', () => {
  it('reports a clean config as provided', () => {
    const resolution = resolveConfig({
      icp: { industries: ['Manufacturing'], regions: ['UK'], sizeBands: [] },
      gateThreshold: 65,
    });

    expect(resolution.source).toBe('provided');
    expect(resolution.degradations).toHaveLength(0);
    expect(resolution.config.gateThreshold).toBe(65);
  });

  it('reports a patched config as repaired', () => {
    const resolution = resolveConfig({ gateThreshold: 500 });

    expect(resolution.source).toBe('repaired');
    expect(codeList(resolution)).toContain('gate_threshold_malformed');
    expect(resolution.config.gateThreshold).toBe(DEFAULT_GATE_THRESHOLD);
  });

  it.each([
    ['negative', -1],
    ['over 100', 101],
    ['non-numeric', 'high'],
    ['NaN', Number.NaN],
  ])('rejects a %s gate threshold', (_label, gateThreshold) => {
    const resolution = resolveConfig({ gateThreshold });

    expect(resolution.config.gateThreshold).toBe(DEFAULT_GATE_THRESHOLD);
  });

  it('accepts the exact boundary thresholds', () => {
    expect(resolveConfig({ gateThreshold: 0 }).config.gateThreshold).toBe(0);
    expect(resolveConfig({ gateThreshold: 100 }).config.gateThreshold).toBe(100);
  });

  it('drops incomplete ICP size bands but keeps the good ones', () => {
    const resolution = resolveConfig({
      icp: {
        sizeBands: [
          { label: 'Mid', minEmployees: 50, maxEmployees: 500 },
          { label: 'Broken', minEmployees: 'lots' },
          { label: 'Inverted', minEmployees: 500, maxEmployees: 50 },
        ],
      },
    });

    expect(resolution.config.icp.sizeBands).toHaveLength(1);
    expect(codeList(resolution)).toContain('icp_malformed');
  });

  it('falls back to permissive ICP when the whole block is unreadable', () => {
    const resolution = resolveConfig({ icp: 'manufacturing only' });

    expect(resolution.config.icp.industries).toHaveLength(0);
    expect(codeList(resolution)).toContain('icp_malformed');
  });

  it('sorts bands high to low and clamps them into range', () => {
    const resolution = resolveConfig({
      bands: [
        { id: 'low', label: 'Low', minScore: -20 },
        { id: 'high', label: 'High', minScore: 400 },
        { id: 'mid', label: 'Mid', minScore: 40 },
      ],
    });

    expect(resolution.config.bands.map((band) => band.id)).toEqual([
      'high',
      'mid',
      'low',
    ]);
    expect(resolution.config.bands[0]?.minScore).toBe(100);
    expect(resolution.config.bands[2]?.minScore).toBe(0);
  });

  it.each([
    ['not an array', 'excellent,good'],
    ['an array of junk', [1, 'two', null]],
  ])('falls back to the standard bands when they are %s', (_label, bands) => {
    const resolution = resolveConfig({ bands });

    expect(resolution.config.bands).toEqual(DEFAULT_BANDS);
    expect(codeList(resolution)).toContain('bands_malformed');
  });

  it('accepts rule settings as a keyed object', () => {
    const rules = [stubRule('a', 10, { outcome: 'pass', explanation: 'ok.' })];
    const resolution = resolveConfig(
      { rules: { a: { enabled: false, weight: 3, severity: 'minor' } } },
      rules,
    );

    expect(resolution.config.rules['a']).toEqual({
      enabled: false,
      severity: 'minor',
      weight: 3,
    });
  });

  it('accepts rule settings as an array of records, as a CRM would store them', () => {
    const rules = [stubRule('a', 10, { outcome: 'pass', explanation: 'ok.' })];
    const resolution = resolveConfig({ rules: [{ id: 'a', weight: 7 }] }, rules);

    expect(resolution.config.rules['a']?.weight).toBe(7);
    expect(resolution.degradations).toHaveLength(0);
  });

  it('accepts a bare boolean as an on/off shorthand', () => {
    const rules = [stubRule('a', 10, { outcome: 'pass', explanation: 'ok.' })];
    const resolution = resolveConfig({ rules: { a: false } }, rules);

    expect(resolution.config.rules['a']?.enabled).toBe(false);
  });

  it('ignores settings for rules that no longer exist', () => {
    const rules = [stubRule('a', 10, { outcome: 'pass', explanation: 'ok.' })];
    const resolution = resolveConfig({ rules: { 'retired.rule': { weight: 5 } } }, rules);

    expect(Object.keys(resolution.config.rules)).toEqual(['a']);
    expect(resolution.degradations).toHaveLength(0);
  });

  it('repairs shelf lives', () => {
    const resolution = resolveConfig({
      defaultShelfLifeDays: 0,
      fieldShelfLifeDays: { lastVerifiedAt: 90, jobTitle: -5 },
    });

    expect(resolution.config.defaultShelfLifeDays).toBe(30);
    expect(resolution.config.fieldShelfLifeDays.lastVerifiedAt).toBe(90);
    expect(resolution.config.fieldShelfLifeDays.jobTitle).toBeUndefined();
    expect(codeList(resolution).filter((code) => code === 'shelf_life_malformed')).toHaveLength(2);
  });

  it('merges a partial field mapping over the defaults', () => {
    const resolution = resolveConfig({
      fieldMapping: { companyName: 'org.title', email: ['work_email'] },
    });

    expect(resolution.config.fieldMapping.companyName).toEqual(['org.title']);
    expect(resolution.config.fieldMapping.email).toEqual(['work_email']);
    expect(resolution.config.fieldMapping.phone.length).toBeGreaterThan(0);
    expect(resolution.degradations).toHaveLength(0);
  });

  it('offers the company firmographics behind every human-held candidate', () => {
    // A Twenty workspace keeps country and headcount on Company; the defaults
    // must reach them without a workspace configuring anything — but only after
    // every lead-held candidate, so a human value always wins the ordering.
    const { fieldMapping } = resolveConfig({}).config;

    expect(fieldMapping.region).toContain('company.country');
    expect(fieldMapping.region.indexOf('company.country')).toBeGreaterThan(
      fieldMapping.region.indexOf('country'),
    );

    expect(fieldMapping.employeeCount).toContain('company.employeeCount');
    expect(fieldMapping.employeeCount.indexOf('company.employeeCount')).toBeGreaterThan(
      fieldMapping.employeeCount.indexOf('employeeCount'),
    );
  });

  it('keeps the default mapping for an unusable entry', () => {
    const resolution = resolveConfig({ fieldMapping: { companyName: 42 } });

    expect(resolution.config.fieldMapping.companyName.length).toBeGreaterThan(1);
    expect(codeList(resolution)).toContain('field_mapping_malformed');
  });

  it('refuses to let configuration move Greenlight’s own suppression fields', () => {
    // Every other key is a genuine Layer 3 seam. These two are not: a config
    // able to point `suppressed` elsewhere is a config able to switch the block
    // list off by mistyping a column name.
    const resolution = resolveConfig({
      fieldMapping: {
        suppressed: ['somethingElse'],
        suppressionReason: ['alsoElse'],
        optedOut: ['ourOwnColumn'],
      },
    });

    expect(resolution.config.fieldMapping.suppressed).toEqual([
      'greenlightSuppressed',
    ]);
    expect(resolution.config.fieldMapping.suppressionReason).toEqual([
      'greenlightSuppressionReason',
    ]);
    // The customer's own opt-out mapping is untouched — union, not override.
    expect(resolution.config.fieldMapping.optedOut).toEqual(['ourOwnColumn']);
    expect(codeList(resolution)).toContain('field_mapping_malformed');
  });

  /* ------------------------------------------------------------------------ */
  /* The enriched-value tail                                                   */
  /* ------------------------------------------------------------------------ */

  it('appends the enriched path to every enrichable key, last', () => {
    const { fieldMapping } = resolveConfig({}).config;

    expect(enrichedEntries).toHaveLength(5);

    for (const [key, path] of enrichedEntries) {
      const candidates = fieldMapping[key];

      expect(candidates[candidates.length - 1]).toBe(path);
      // Last, not merely present: `field-access.ts` takes the first candidate
      // that yields a value, so anything after this position would be a path
      // that could beat a human-entered value.
      expect(candidates.indexOf(path)).toBe(candidates.length - 1);
      expect(candidates.slice(0, -1)).toEqual([...DEFAULT_FIELD_MAPPING[key]]);
    }
  });

  it('keeps the enriched path behind a workspace’s own candidates', () => {
    const { fieldMapping } = resolveConfig({
      fieldMapping: { industry: ['sectorCode', 'company.sic'] },
    }).config;

    expect(fieldMapping.industry).toEqual([
      'sectorCode',
      'company.sic',
      ENRICHED_FIELD_MAPPING_PATHS.industry,
    ]);
  });

  it('appends the enriched path even when the configuration is unusable', () => {
    // The enriched path is Greenlight's own column, so unlike the Layer 3 seams
    // around it there is no configuration — including no configuration at all,
    // and including a broken one — that can disconnect it.
    for (const raw of [undefined, null, 'not-an-object', { fieldMapping: 7 }]) {
      const { fieldMapping } = resolveConfig(raw as never).config;

      expect(fieldMapping.industry).toContain(
        ENRICHED_FIELD_MAPPING_PATHS.industry,
      );
    }

    const regionCandidates = buildDefaultConfig().fieldMapping.region;

    expect(regionCandidates[regionCandidates.length - 1]).toBe(
      ENRICHED_FIELD_MAPPING_PATHS.region,
    );
  });

  it('leaves the stock mapping itself alone', () => {
    // `src/enrichment/plan.ts` reads DEFAULT_FIELD_MAPPING to answer "has a
    // human already filled this in". An enriched value visible there would read
    // as human input and the field would never be refreshed again.
    for (const [key, path] of enrichedEntries) {
      expect(DEFAULT_FIELD_MAPPING[key]).not.toContain(path);
    }
  });

  it('lower-cases configured title lists so matching is case-insensitive', () => {
    const resolution = resolveConfig({ decisionMakerTitles: ['Practice LEAD'] });

    expect(resolution.config.decisionMakerTitles).toEqual(['practice lead']);
  });

  it('falls back to the built-in title list when the configured one is unusable', () => {
    const resolution = resolveConfig({ decisionMakerTitles: [] });

    expect(resolution.config.decisionMakerTitles.length).toBeGreaterThan(5);
    expect(codeList(resolution)).toContain('title_list_malformed');
  });
});
