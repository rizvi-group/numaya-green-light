import * as backfillIdentifiers from 'src/constants/backfill-identifiers';
import * as enrichmentIdentifiers from 'src/constants/enrichment-identifiers';
import * as gateIdentifiers from 'src/constants/gate-queue-identifiers';
import * as licenceIdentifiers from 'src/constants/licence-identifiers';
import * as logicFunctionIdentifiers from 'src/constants/logic-function-identifiers';
import * as coreIdentifiers from 'src/constants/universal-identifiers';
import { describe, expect, it } from 'vitest';

// The same guard as the other identifier tests, extended across all six constant
// files at once. Splitting the constants is what lets parallel workstreams add
// entities without fighting over a file; a collision *between* the files is the
// failure mode that split introduces, and only a test importing every one of
// them can see it. This is now the widest of those tests, so it is the one that
// catches a duplicate wherever it is introduced.
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const collect = (
  module: Record<string, unknown>,
  moduleName: string,
): { path: string; value: string }[] => {
  const collected: { path: string; value: string }[] = [];

  for (const [key, exported] of Object.entries(module)) {
    if (typeof exported === 'string') {
      if (key.endsWith('UNIVERSAL_IDENTIFIER')) {
        collected.push({ path: `${moduleName}.${key}`, value: exported });
      }
      continue;
    }

    if (typeof exported === 'object' && exported !== null) {
      for (const [nested, value] of Object.entries(
        exported as Record<string, string>,
      )) {
        if (typeof value === 'string' && UUID_V4.test(value)) {
          collected.push({ path: `${moduleName}.${key}.${nested}`, value });
        }
      }
    }
  }

  return collected;
};

describe('enrichment universal identifiers', () => {
  const enrichment = collect(enrichmentIdentifiers, 'enrichment-identifiers');

  it('should have collected every declared enrichment identifier', () => {
    // 2 agents (extractor, verifier); 2 logic functions (lead event, request
    // route); 3 provenance fields; 3 for the enrichment view (view, filter,
    // sort) and 6 more for its columns; 1 navigation menu item; and 2 for the
    // admin action (command menu item, front component).
    expect(enrichment.length).toBe(19);
  });

  it('should only contain valid UUID v4 values', () => {
    expect(enrichment.filter(({ value }) => !UUID_V4.test(value))).toEqual([]);
  });

  it('should never reuse an identifier, across all six constant files', () => {
    const all = [
      ...collect(coreIdentifiers, 'universal-identifiers'),
      ...collect(gateIdentifiers, 'gate-queue-identifiers'),
      ...collect(backfillIdentifiers, 'backfill-identifiers'),
      ...collect(licenceIdentifiers, 'licence-identifiers'),
      ...collect(logicFunctionIdentifiers, 'logic-function-identifiers'),
      ...enrichment,
    ];

    const seen = new Map<string, string>();
    const duplicates: string[] = [];

    for (const { path, value } of all) {
      const previous = seen.get(value);

      if (previous !== undefined) {
        duplicates.push(`${previous} and ${path} share ${value}`);
      } else {
        seen.set(value, path);
      }
    }

    expect(duplicates).toEqual([]);
  });

  it('should derive the client path from the route path', () => {
    expect(enrichmentIdentifiers.ENRICH_LEAD_REQUEST_CLIENT_PATH).toBe(
      `/s${enrichmentIdentifiers.ENRICH_LEAD_REQUEST_ROUTE_PATH}`,
    );
  });

  it('should not collide with an existing HTTP route path', () => {
    const paths = [
      gateIdentifiers.RELEASE_LEAD_ROUTE_PATH,
      gateIdentifiers.SUPPRESS_LEAD_ROUTE_PATH,
      gateIdentifiers.UNSUPPRESS_LEAD_ROUTE_PATH,
      enrichmentIdentifiers.ENRICH_LEAD_REQUEST_ROUTE_PATH,
    ];

    expect(new Set(paths).size).toBe(paths.length);
  });

  it('should give the two key-value keys distinct names', () => {
    const keys = [
      enrichmentIdentifiers.ENRICHMENT_BUDGET_KV_KEY,
      enrichmentIdentifiers.ENRICHMENT_BREAKER_KV_KEY,
      enrichmentIdentifiers.ENRICHMENT_TWENTY_AI_KV_KEY,
    ];

    expect(new Set(keys).size).toBe(keys.length);
  });
});
