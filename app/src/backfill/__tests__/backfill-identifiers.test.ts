import * as backfillIdentifiers from 'src/constants/backfill-identifiers';
import * as gateIdentifiers from 'src/constants/gate-queue-identifiers';
import * as coreIdentifiers from 'src/constants/universal-identifiers';
import { describe, expect, it } from 'vitest';

// Same guard as the other two identifier tests, extended across all three
// constant files at once. Splitting the constants into three modules is what
// lets three workstreams add entities without colliding in a file; a collision
// *between* the files is the failure mode that split introduces, and only a test
// that imports all three can see it.
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

describe('backfill universal identifiers', () => {
  const backfill = collect(backfillIdentifiers, 'backfill-identifiers');

  it('should have collected every declared backfill identifier', () => {
    // 2 logic functions (cron drain, control route); 2 for the admin surface
    // (command menu item, front component); 4 for the never-scored view (view,
    // nav item, filter, sort) and 5 more for its columns.
    expect(backfill.length).toBe(13);
  });

  it('should only contain valid UUID v4 values', () => {
    expect(backfill.filter(({ value }) => !UUID_V4.test(value))).toEqual([]);
  });

  it('should never reuse an identifier, across all three constant files', () => {
    const all = [
      ...collect(coreIdentifiers, 'universal-identifiers'),
      ...collect(gateIdentifiers, 'gate-queue-identifiers'),
      ...backfill,
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

  it('should keep the client path derived from the route path', () => {
    expect(backfillIdentifiers.BACKFILL_CLIENT_PATH).toBe(
      `/s${backfillIdentifiers.BACKFILL_ROUTE_PATH}`,
    );
  });

  it('should not collide with an existing app route', () => {
    const paths = [
      backfillIdentifiers.BACKFILL_ROUTE_PATH,
      gateIdentifiers.RELEASE_LEAD_ROUTE_PATH,
      gateIdentifiers.SUPPRESS_LEAD_ROUTE_PATH,
      gateIdentifiers.UNSUPPRESS_LEAD_ROUTE_PATH,
    ];

    expect(new Set(paths).size).toBe(paths.length);
  });

  it('should version the state key, so a shape change can never resume against a cursor it cannot read', () => {
    expect(backfillIdentifiers.BACKFILL_STATE_KEY).toMatch(/:v\d+$/);
  });
});
