import * as identifiers from 'src/constants/universal-identifiers';
import { describe, expect, it } from 'vitest';

// Universal identifiers are permanent: a duplicate or a malformed one is a data
// corruption bug in every workspace that installs the app, and it is invisible
// until sync fails. Cheap to guard here.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const collectIdentifiers = (): { path: string; value: string }[] => {
  const collected: { path: string; value: string }[] = [];

  for (const [key, exported] of Object.entries(identifiers)) {
    if (typeof exported === 'string') {
      if (key.endsWith('UNIVERSAL_IDENTIFIER')) {
        collected.push({ path: key, value: exported });
      }
      continue;
    }

    if (typeof exported === 'object' && exported !== null) {
      for (const [nested, value] of Object.entries(
        exported as Record<string, string>,
      )) {
        collected.push({ path: `${key}.${nested}`, value });
      }
    }
  }

  return collected;
};

describe('universal identifiers', () => {
  const all = collectIdentifiers();

  it('should have collected every declared identifier', () => {
    expect(all.length).toBeGreaterThan(40);
  });

  it('should only contain valid UUID v4 values', () => {
    const invalid = all.filter(({ value }) => !UUID_V4.test(value));

    expect(invalid).toEqual([]);
  });

  it('should never reuse an identifier across entities', () => {
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
