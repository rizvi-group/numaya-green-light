import {
  buildEnrichmentPayload,
  buildEnrichmentRunId,
  enrichmentStatusFor,
  readEnrichmentPayload,
  type AcceptedField,
  type EvidenceSet,
} from 'src/enrichment';
import { describe, expect, it } from 'vitest';

const NOW = new Date('2026-08-03T09:00:00.000Z');

const EVIDENCE: EvidenceSet = {
  documents: [
    {
      id: 'e1',
      url: 'https://example.com/about',
      title: 'About Acme',
      snippet: 'industrial manufacturing',
    },
  ],
  quarantined: [
    { url: 'https://attacker.example/seo', title: 'Acme', markers: ['marker'] },
  ],
};

const accepted = (overrides: Partial<AcceptedField> = {}): AcceptedField => ({
  key: 'industry',
  value: 'industrial manufacturing',
  parsedValue: 'industrial manufacturing',
  sourceUrl: 'https://example.com/about',
  sourceTitle: 'About Acme',
  confidence: 0.85,
  verification: 'confirmed',
  ...overrides,
});

const build = (
  overrides: Partial<Parameters<typeof buildEnrichmentPayload>[0]> = {},
) =>
  buildEnrichmentPayload({
    runId: 'gle-test',
    now: NOW,
    previous: null,
    accepted: [accepted()],
    requested: ['industry', 'region'],
    evidence: EVIDENCE,
    reasoningProvider: 'twenty-ai',
    reasoningModel: 'twenty-agent:extractor',
    searchProvider: 'brave',
    notes: [],
    ...overrides,
  });

describe('buildEnrichmentPayload', () => {
  it('should write the value with its source, date and confidence together', () => {
    const payload = build();
    const industry = payload.fields.industry;

    expect(industry).toBeDefined();
    expect(industry?.sourceUrl).toBe('https://example.com/about');
    expect(industry?.retrievedAt).toBe(NOW.toISOString());
    expect(industry?.confidence).toBe(0.85);
    expect(industry?.searchProvider).toBe('brave');
  });

  it('should record every field it asked about and could not source', () => {
    expect(build().unresolved).toEqual(['region']);
  });

  it('should record the pages it refused to read', () => {
    const payload = build();

    expect(payload.sources).toContainEqual({
      url: 'https://attacker.example/seo',
      title: 'Acme',
      quarantined: true,
    });
  });

  it('should carry forward a field it did not revisit, date intact', () => {
    const previous = readEnrichmentPayload({
      version: 1,
      runId: 'earlier',
      runAt: '2026-07-01T00:00:00.000Z',
      engineVersion: '0.2.0',
      fields: {
        employeeCount: {
          value: '240',
          parsedValue: 240,
          sourceUrl: 'https://example.com/old',
          sourceTitle: 'Old',
          retrievedAt: '2026-07-01T00:00:00.000Z',
          confidence: 0.7,
        },
      },
      sources: [],
      unresolved: [],
      notes: [],
    });

    const payload = build({ previous });

    // Rewriting the date on a value nobody re-checked would reset its shelf
    // life and make the cache immortal.
    expect(payload.fields.employeeCount?.retrievedAt).toBe(
      '2026-07-01T00:00:00.000Z',
    );
    expect(payload.fields.industry?.retrievedAt).toBe(NOW.toISOString());
  });
});

describe('readEnrichmentPayload', () => {
  it('should drop a stored value that has no source', () => {
    const payload = readEnrichmentPayload({
      fields: {
        industry: { value: 'Healthcare', retrievedAt: NOW.toISOString(), confidence: 1 },
      },
    });

    // No `sourceUrl`. An unsourced value is not a weaker record, it is a record
    // that must not exist — dropping it makes the field re-fetch.
    expect(payload?.fields.industry).toBeUndefined();
  });

  it('should drop a value for a key outside the catalogue', () => {
    const payload = readEnrichmentPayload({
      fields: {
        email: {
          value: 'x@example.com',
          sourceUrl: 'https://example.com',
          retrievedAt: NOW.toISOString(),
          confidence: 1,
        },
      },
    });

    expect(Object.keys(payload?.fields ?? {})).toEqual([]);
  });

  it('should return null for anything that is not a record', () => {
    expect(readEnrichmentPayload(null)).toBeNull();
    expect(readEnrichmentPayload('{}')).toBeNull();
    expect(readEnrichmentPayload([])).toBeNull();
  });

  it('should survive a shape from a future version', () => {
    const payload = readEnrichmentPayload({ version: 9, fields: 'nope', extra: true });

    expect(payload?.fields).toEqual({});
  });
});

describe('enrichmentStatusFor', () => {
  it('should distinguish the outcomes an admin acts on differently', () => {
    expect(enrichmentStatusFor({ kind: 'enriched', fieldsWritten: 2 })).toBe(
      'ENRICHED',
    );
    expect(enrichmentStatusFor({ kind: 'enriched', fieldsWritten: 0 })).toBe(
      'NOTHING_FOUND',
    );
    expect(enrichmentStatusFor({ kind: 'skipped', reason: 'cap_exhausted' })).toBe(
      'CAPPED',
    );
    expect(
      enrichmentStatusFor({ kind: 'skipped', reason: 'licence_not_entitled' }),
    ).toBe('UNLICENSED');
    expect(
      enrichmentStatusFor({ kind: 'skipped', reason: 'no_supported_values' }),
    ).toBe('NOTHING_FOUND');
    expect(enrichmentStatusFor({ kind: 'skipped', reason: 'no_gaps' })).toBe(
      'SKIPPED',
    );
    expect(enrichmentStatusFor({ kind: 'failed' })).toBe('FAILED');
  });
});

describe('buildEnrichmentRunId', () => {
  it('should be stable for a lead within the same minute', () => {
    const a = buildEnrichmentRunId('person-1', new Date('2026-08-03T09:00:01Z'));
    const b = buildEnrichmentRunId('person-1', new Date('2026-08-03T09:00:59Z'));

    expect(a).toBe(b);
  });

  it('should differ across leads', () => {
    expect(buildEnrichmentRunId('person-1', NOW)).not.toBe(
      buildEnrichmentRunId('person-2', NOW),
    );
  });
});
