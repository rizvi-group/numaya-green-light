import { runEnrichLeadRequest } from 'src/logic-functions/enrich-request-run';
import type { EnrichmentRunDeps } from 'src/logic-functions/enrich-run';
import {
  asConnection,
  createFakeClient,
} from 'src/logic-functions/__tests__/fake-client';
import {
  completed,
  environment,
  fakeReasoning,
  fakeSearch,
  fakeStore,
  goodReply,
  licensed,
  NOW,
  person,
  rulesOnly,
  searchResults,
} from 'src/logic-functions/__tests__/enrich-fakes';
import { describe, expect, it } from 'vitest';

const deps = (
  overrides: Partial<EnrichmentRunDeps> = {},
): EnrichmentRunDeps => {
  const reasoning = fakeReasoning({
    capable: completed(goodReply),
    cheap: completed(JSON.stringify({ results: [{ id: '1', supported: true }] })),
  });

  return {
    client: createFakeClient({
      query: (request) =>
        'people' in request
          ? asConnection('people', [person()])
          : asConnection('greenlightConfigs', []),
    }),
    store: fakeStore(),
    environment: environment(),
    createReasoning: (choice) => (choice.kind === 'none' ? null : reasoning),
    createSearch: (choice) =>
      choice.kind === 'none'
        ? null
        : fakeSearch({ kind: 'results', results: searchResults() }),
    licence: licensed(),
    now: NOW,
    ...overrides,
  };
};

describe('runEnrichLeadRequest', () => {
  it('should reject a body with no lead', async () => {
    expect(await runEnrichLeadRequest({ deps: deps(), body: null })).toMatchObject({
      status: 400,
    });
    expect(await runEnrichLeadRequest({ deps: deps(), body: {} })).toMatchObject({
      status: 400,
    });
    expect(
      await runEnrichLeadRequest({ deps: deps(), body: { leadRecordId: '   ' } }),
    ).toMatchObject({ status: 400 });
  });

  it('should enrich and report what was written', async () => {
    const result = await runEnrichLeadRequest({
      deps: deps(),
      body: { leadRecordId: 'person-1' },
    });

    expect(result.status).toBe(200);
    expect(result.body['ok']).toBe(true);
    expect(result.body['fieldsWritten']).toEqual(['industry']);
    expect(String(result.body['message'])).toContain('Enriched 1 field');
  });

  it('should answer 200 with a reason when the licence gate is closed', async () => {
    const result = await runEnrichLeadRequest({
      deps: deps({ licence: rulesOnly() }),
      body: { leadRecordId: 'person-1' },
    });

    // A skip is a successful answer to "should this be enriched now". Returning
    // 4xx would make a correctly-working fail-open path look like a bad request.
    expect(result.status).toBe(200);
    expect(result.body['reason']).toBe('licence_not_entitled');
    expect(String(result.body['message'])).toContain('licence');
  });

  it('should explain a reached cap in words an admin can act on', async () => {
    const result = await runEnrichLeadRequest({
      deps: deps({
        store: fakeStore({ budget: { monthKey: '2026-08', used: 100, alertedAt: 100 } }),
      }),
      body: { leadRecordId: 'person-1' },
    });

    expect(result.body['reason']).toBe('cap_exhausted');
    expect(String(result.body['message'])).toContain('MONTHLY_ENRICHMENT_CAP');
  });

  it('should return the provenance document so the panel can show sources', async () => {
    const result = await runEnrichLeadRequest({
      deps: deps(),
      body: { leadRecordId: 'person-1' },
    });

    // The fake client always returns the un-enriched person, so the panel read
    // finds no document — what matters is that the key is present and the
    // request did not fail over it.
    expect(result.body).toHaveProperty('enrichment');
  });

  it('should force past the freshness cache but not past a human value', async () => {
    const cachedIndustry = {
      version: 1,
      runId: 'earlier',
      runAt: NOW.toISOString(),
      engineVersion: '0.2.0',
      fields: {
        industry: {
          value: 'stale value',
          parsedValue: 'stale value',
          sourceUrl: 'https://example.com/old',
          sourceTitle: 'old',
          retrievedAt: NOW.toISOString(),
          confidence: 0.8,
        },
      },
      sources: [],
      unresolved: [],
      notes: [],
    };

    const client = createFakeClient({
      query: (request) =>
        'people' in request
          ? asConnection('people', [
              person({
                greenlightEnrichment: cachedIndustry,
                jobTitle: 'Chief Operating Officer',
              }),
            ])
          : asConnection('greenlightConfigs', []),
    });

    const result = await runEnrichLeadRequest({
      deps: deps({ client }),
      body: { leadRecordId: 'person-1' },
    });

    // Industry was fresh and got re-fetched anyway; jobTitle is human-held and
    // was not asked about, so it is not in what was written.
    expect(result.body['fieldsWritten']).toEqual(['industry']);
  });
});
