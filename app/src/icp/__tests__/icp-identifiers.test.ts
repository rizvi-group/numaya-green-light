import * as backfillIdentifiers from 'src/constants/backfill-identifiers';
import * as gateIdentifiers from 'src/constants/gate-queue-identifiers';
import * as icpIdentifiers from 'src/constants/icp-identifiers';
import * as licenceIdentifiers from 'src/constants/licence-identifiers';
import * as logicFunctionIdentifiers from 'src/constants/logic-function-identifiers';
import * as coreIdentifiers from 'src/constants/universal-identifiers';
import { describe, expect, it } from 'vitest';

/**
 * The same permanence guard as the other four identifier tests, extended across
 * **all five** constant files at once. Splitting identifiers across modules is
 * what makes a cross-file collision possible, and only a test that imports every
 * module can see one.
 */
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
        exported as Record<string, unknown>,
      )) {
        // Filtered on shape rather than on key name: these constant modules also
        // export non-identifier maps (SELECT option values, request field
        // names), and folding those into the guard would make the UUID
        // assertion fail on data that is not an identifier at all.
        if (typeof value === 'string' && UUID_V4.test(value)) {
          collected.push({ path: `${moduleName}.${key}.${nested}`, value });
        }
      }
    }
  }

  return collected;
};

describe('ICP universal identifiers', () => {
  const icp = collect(icpIdentifiers, 'icp-identifiers');

  it('should have collected every declared ICP identifier', () => {
    // 1 logic function (the review route); 4 for the admin surface (front
    // component, command menu item, navigation menu item, page layout) plus 2
    // for that page layout's tab and widget; 2 new GreenlightConfig fields.
    expect(icp.length).toBe(9);
  });

  it('should only contain valid UUID v4 values', () => {
    expect(icp.filter(({ value }) => !UUID_V4.test(value))).toEqual([]);
  });

  it('should never reuse an identifier, across all five constant files', () => {
    const all = [
      ...collect(coreIdentifiers, 'universal-identifiers'),
      ...collect(gateIdentifiers, 'gate-queue-identifiers'),
      ...collect(logicFunctionIdentifiers, 'logic-function-identifiers'),
      ...collect(licenceIdentifiers, 'licence-identifiers'),
      ...collect(backfillIdentifiers, 'backfill-identifiers'),
      ...icp,
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
    expect(icpIdentifiers.ICP_CLIENT_PATH).toBe(
      `/s${icpIdentifiers.ICP_ROUTE_PATH}`,
    );
  });

  it('should not collide with an existing app route', () => {
    const paths = [
      icpIdentifiers.ICP_ROUTE_PATH,
      backfillIdentifiers.BACKFILL_ROUTE_PATH,
      gateIdentifiers.RELEASE_LEAD_ROUTE_PATH,
      gateIdentifiers.SUPPRESS_LEAD_ROUTE_PATH,
      gateIdentifiers.UNSUPPRESS_LEAD_ROUTE_PATH,
    ];

    expect(new Set(paths).size).toBe(paths.length);
  });

  it('should keep the review decision values distinct and upper case', () => {
    const values = Object.values(icpIdentifiers.ICP_REVIEW_DECISION_VALUES);

    expect(new Set(values).size).toBe(values.length);

    for (const value of values) {
      expect(value).toBe(value.toUpperCase());
    }
  });
});
