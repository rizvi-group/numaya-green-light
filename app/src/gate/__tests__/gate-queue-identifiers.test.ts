import * as gateIdentifiers from 'src/constants/gate-queue-identifiers';
import * as coreIdentifiers from 'src/constants/universal-identifiers';
import { describe, expect, it } from 'vitest';

// Same guard as src/__tests__/universal-identifiers.test.ts, extended across
// both constant files. The gate-queue identifiers live in their own module, so
// the original test does not see them — and a collision between the two files
// is exactly the failure mode splitting them introduces.
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
        collected.push({ path: `${moduleName}.${key}.${nested}`, value });
      }
    }
  }

  return collected;
};

describe('gate queue universal identifiers', () => {
  const gate = collect(gateIdentifiers, 'gate-queue-identifiers');

  it('should have collected every declared gate queue identifier', () => {
    // 24 for the gate queue, the unscored queue and the override action; 10 more
    // for the compliance-blocked queue (view, nav item, filter, sort, 6 columns);
    // 2 more columns added to that queue for the suppression reason and date;
    // 11 for the do-not-contact list (view, nav item, filter, sort, 7 columns);
    // and 6 for the two block-list actions (menu item, panel, function, twice).
    expect(gate.length).toBe(53);
  });

  it('should only contain valid UUID v4 values', () => {
    expect(gate.filter(({ value }) => !UUID_V4.test(value))).toEqual([]);
  });

  it('should never reuse an identifier, including across the two constant files', () => {
    const all = [...collect(coreIdentifiers, 'universal-identifiers'), ...gate];
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

  it('should keep the client path derived from the route path', () => {
    expect(gateIdentifiers.RELEASE_LEAD_CLIENT_PATH).toBe(
      `/s${gateIdentifiers.RELEASE_LEAD_ROUTE_PATH}`,
    );
    expect(gateIdentifiers.SUPPRESS_LEAD_CLIENT_PATH).toBe(
      `/s${gateIdentifiers.SUPPRESS_LEAD_ROUTE_PATH}`,
    );
    expect(gateIdentifiers.UNSUPPRESS_LEAD_CLIENT_PATH).toBe(
      `/s${gateIdentifiers.UNSUPPRESS_LEAD_ROUTE_PATH}`,
    );
  });

  it('should give every HTTP route its own path', () => {
    const paths = [
      gateIdentifiers.RELEASE_LEAD_ROUTE_PATH,
      gateIdentifiers.SUPPRESS_LEAD_ROUTE_PATH,
      gateIdentifiers.UNSUPPRESS_LEAD_ROUTE_PATH,
    ];

    expect(new Set(paths).size).toBe(paths.length);
  });
});
