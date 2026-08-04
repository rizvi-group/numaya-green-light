import {
  buildSearchQuery,
  planEnrichment,
  readSubject,
  UNRESOLVED_RETRY_DAYS,
  type EnrichedFieldProvenance,
  type EnrichmentPayload,
  type EnrichmentPlanInput,
} from 'src/enrichment';
import { describe, expect, it } from 'vitest';

const NOW = new Date('2026-08-03T09:00:00.000Z');
const daysAgo = (days: number): string =>
  new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

const provenance = (
  overrides: Partial<EnrichedFieldProvenance> = {},
): EnrichedFieldProvenance => ({
  value: 'industrial manufacturing',
  parsedValue: 'industrial manufacturing',
  sourceUrl: 'https://example.com/about',
  sourceTitle: 'About',
  retrievedAt: daysAgo(1),
  confidence: 0.8,
  verification: 'confirmed',
  reasoningProvider: 'twenty-ai',
  reasoningModel: 'twenty-agent:extractor',
  searchProvider: 'brave',
  engineVersion: '0.2.0',
  ...overrides,
});

const payload = (
  overrides: Partial<EnrichmentPayload> = {},
): EnrichmentPayload => ({
  version: 1,
  runId: 'gle-test',
  runAt: daysAgo(1),
  engineVersion: '0.2.0',
  fields: {},
  sources: [],
  unresolved: [],
  notes: [],
  ...overrides,
});

const LEAD = {
  id: 'person-1',
  name: { firstName: 'Dana', lastName: 'Fry' },
  company: { name: 'Acme Pumps Ltd' },
};

const input = (
  overrides: Partial<EnrichmentPlanInput> = {},
): EnrichmentPlanInput => ({
  lead: LEAD,
  existing: null,
  defaultShelfLifeDays: 30,
  fieldShelfLifeDays: {},
  now: NOW,
  force: false,
  ...overrides,
});

describe('planEnrichment', () => {
  it('should request every enrichable field on a bare lead', () => {
    const plan = planEnrichment(input());

    expect(plan.requested).toEqual([
      'industry',
      'region',
      'employeeCount',
      'jobTitle',
      'seniority',
    ]);
  });

  it('should never ask about a field a person has already filled in', () => {
    const plan = planEnrichment(
      input({ lead: { ...LEAD, jobTitle: 'Chief Operating Officer' } }),
    );

    expect(plan.humanHeld).toContain('jobTitle');
    expect(plan.requested).not.toContain('jobTitle');
  });

  it('should ignore placeholder text in a human column', () => {
    const plan = planEnrichment(input({ lead: { ...LEAD, jobTitle: 'n/a' } }));

    expect(plan.requested).toContain('jobTitle');
  });

  it('should treat a fresh enriched value as a cache hit', () => {
    const plan = planEnrichment(
      input({ existing: payload({ fields: { industry: provenance() } }) }),
    );

    expect(plan.fresh).toEqual(['industry']);
    expect(plan.requested).not.toContain('industry');
  });

  it('should re-ask once the shelf life has passed', () => {
    const plan = planEnrichment(
      input({
        existing: payload({
          fields: { industry: provenance({ retrievedAt: daysAgo(31) }) },
        }),
      }),
    );

    expect(plan.requested).toContain('industry');
  });

  it('should honour a per-field shelf life over the default', () => {
    const stale = payload({
      fields: { industry: provenance({ retrievedAt: daysAgo(3) }) },
    });

    expect(
      planEnrichment(input({ existing: stale, fieldShelfLifeDays: { industry: 2 } }))
        .requested,
    ).toContain('industry');
    expect(
      planEnrichment(input({ existing: stale, fieldShelfLifeDays: { industry: 90 } }))
        .fresh,
    ).toContain('industry');
  });

  it('should treat an unparseable retrieval date as stale', () => {
    const plan = planEnrichment(
      input({
        existing: payload({
          fields: { industry: provenance({ retrievedAt: 'whenever' }) },
        }),
      }),
    );

    expect(plan.requested).toContain('industry');
  });

  it('should back off on a field a recent run could not source', () => {
    const plan = planEnrichment(
      input({ existing: payload({ unresolved: ['region'], runAt: daysAgo(1) }) }),
    );

    expect(plan.recentlyUnresolved).toEqual(['region']);
    expect(plan.requested).not.toContain('region');
  });

  it('should try again once the back-off window has passed', () => {
    const plan = planEnrichment(
      input({
        existing: payload({
          unresolved: ['region'],
          runAt: daysAgo(UNRESOLVED_RETRY_DAYS + 1),
        }),
      }),
    );

    expect(plan.requested).toContain('region');
  });

  it('should let force bypass freshness but not a human value', () => {
    const plan = planEnrichment(
      input({
        force: true,
        lead: { ...LEAD, jobTitle: 'Chief Operating Officer' },
        existing: payload({
          fields: { industry: provenance() },
          unresolved: ['region'],
        }),
      }),
    );

    expect(plan.requested).toContain('industry');
    expect(plan.requested).toContain('region');
    expect(plan.requested).not.toContain('jobTitle');
  });

  it('should produce no query when there is nothing identifying to search for', () => {
    const plan = planEnrichment(input({ lead: { id: 'person-1' } }));

    expect(plan.query).toBeNull();
  });
});

describe('readSubject', () => {
  it('should flatten a composite name and read the company through the relation', () => {
    expect(readSubject(LEAD)).toEqual({
      personName: 'Dana Fry',
      companyName: 'Acme Pumps Ltd',
    });
  });

  it('should return blanks rather than undefined', () => {
    expect(readSubject({})).toEqual({ personName: '', companyName: '' });
  });
});

describe('buildSearchQuery', () => {
  it('should search the company, with keywords derived from what is being asked', () => {
    const query = buildSearchQuery(
      { personName: 'Dana Fry', companyName: 'Acme Pumps Ltd' },
      ['industry', 'employeeCount'],
    );

    expect(query).toContain('Acme Pumps Ltd');
    expect(query).toContain('industry');
    expect(query).toContain('number of employees');
    // The person is irrelevant to a firmographic lookup and only adds homonyms.
    expect(query).not.toContain('Dana Fry');
  });

  it('should add the person only when a title is being asked for', () => {
    const query = buildSearchQuery(
      { personName: 'Dana Fry', companyName: 'Acme Pumps Ltd' },
      ['jobTitle'],
    );

    expect(query).toContain('Dana Fry');
  });

  it('should fall back to the person when there is no company', () => {
    expect(
      buildSearchQuery({ personName: 'Dana Fry', companyName: '' }, ['jobTitle']),
    ).toContain('Dana Fry');
  });

  it('should refuse to search for nothing', () => {
    expect(buildSearchQuery({ personName: '', companyName: '' }, ['industry'])).toBeNull();
  });
});
