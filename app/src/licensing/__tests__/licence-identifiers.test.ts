import * as gateIdentifiers from 'src/constants/gate-queue-identifiers';
import * as licenceIdentifiers from 'src/constants/licence-identifiers';
import * as logicFunctionIdentifiers from 'src/constants/logic-function-identifiers';
import * as coreIdentifiers from 'src/constants/universal-identifiers';
import { describe, expect, it } from 'vitest';

/**
 * The same permanence guard as `src/__tests__/universal-identifiers.test.ts` and
 * `src/gate/__tests__/gate-queue-identifiers.test.ts`, extended to the licensing
 * constants — and, while we are here, across **all four** constant files at
 * once. Splitting identifiers across modules is what makes a cross-file
 * collision possible in the first place, and no existing test spans more than
 * two of them.
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
        if (typeof value === 'string' && UUID_V4.test(value)) {
          collected.push({ path: `${moduleName}.${key}.${nested}`, value });
        }
      }
    }
  }

  return collected;
};

describe('licence universal identifiers', () => {
  const licence = collect(licenceIdentifiers, 'licence-identifiers');

  it('should have collected every declared licence identifier', () => {
    // The base-URL application variable, the environment application variable,
    // the nightly re-validation cron function, and the three entities behind the
    // licence panel: its status route, its front component and its command menu
    // item. Update this number when a licensing entity is added.
    expect(licence.length).toBe(6);
  });

  it('should only contain valid UUID v4 values', () => {
    expect(licence.filter(({ value }) => !UUID_V4.test(value))).toEqual([]);
  });

  it('should never reuse an identifier across any of the four constant files', () => {
    const all = [
      ...collect(coreIdentifiers, 'universal-identifiers'),
      ...collect(gateIdentifiers, 'gate-queue-identifiers'),
      ...collect(logicFunctionIdentifiers, 'logic-function-identifiers'),
      ...licence,
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
});

describe('licence endpoint constants', () => {
  it('should carry the confirmed /v1 prefix and US spelling', () => {
    // The one REST path that leaked — POST /v1/orgs/current/licenses/{id}/renew
    // — is the only evidence for either. Both paths below are otherwise
    // unconfirmed; see the note at the top of licence-identifiers.ts.
    expect(licenceIdentifiers.LICENCE_VALIDATE_PATH.startsWith('/v1/licenses/')).toBe(
      true,
    );
    expect(licenceIdentifiers.LICENCE_ACTIVATE_PATH.startsWith('/v1/licenses/')).toBe(
      true,
    );
  });

  it('should default to a base URL with no trailing slash', () => {
    expect(licenceIdentifiers.DEFAULT_LICENCE_API_BASE_URL).not.toMatch(/\/$/);
    expect(licenceIdentifiers.DEFAULT_LICENCE_API_BASE_URL).toMatch(/^https:\/\//);
  });

  it('should use the parameter names the service\'s own tool schema declares', () => {
    expect(licenceIdentifiers.LICENCE_REQUEST_FIELDS).toEqual({
      key: 'key',
      deviceFingerprint: 'deviceFingerprint',
      feature: 'feature',
      deviceName: 'deviceName',
    });
  });

  it('should scope every key-value entry under one namespace', () => {
    for (const key of [
      licenceIdentifiers.LICENCE_CACHE_KV_KEY,
      licenceIdentifiers.LICENCE_ACTIVATION_KV_KEY,
      licenceIdentifiers.LICENCE_STATE_KV_KEY,
    ]) {
      expect(key.startsWith('greenlight.licence.')).toBe(true);
    }

    expect(
      new Set([
        licenceIdentifiers.LICENCE_CACHE_KV_KEY,
        licenceIdentifiers.LICENCE_ACTIVATION_KV_KEY,
        licenceIdentifiers.LICENCE_STATE_KV_KEY,
      ]).size,
    ).toBe(3);
  });

  it('should schedule the nightly run on a five-field cron pattern', () => {
    expect(licenceIdentifiers.LICENCE_REVALIDATE_CRON_PATTERN.split(' ')).toHaveLength(
      5,
    );
  });
});
