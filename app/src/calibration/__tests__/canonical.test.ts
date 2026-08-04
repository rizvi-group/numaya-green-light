/**
 * The signing agreement, asserted as behaviour rather than as prose.
 *
 * Every rule in `canonical.ts` exists because a signature is only worth
 * something when the signer and the verifier produce the same bytes, so each
 * one is exercised here in the direction that would break a signature if it
 * were violated.
 */

import { canonicalBytes, canonicalise } from 'src/calibration/canonical';
import { describe, expect, it } from 'vitest';

describe('canonicalise', () => {
  it('sorts object keys by code unit', () => {
    expect(canonicalise({ b: 1, a: 2, C: 3 })).toBe('{"C":3,"a":2,"b":1}');
  });

  it('sorts keys recursively, not just at the top level', () => {
    expect(canonicalise({ outer: { z: 1, a: { y: 2, b: 3 } } })).toBe(
      '{"outer":{"a":{"b":3,"y":2},"z":1}}',
    );
  });

  it('preserves array order', () => {
    // Order is meaning: `decisionMakerTitles` is scanned in sequence and the
    // first match wins, so a reordered list is a genuinely different payload.
    expect(canonicalise({ list: ['c', 'a', 'b'] })).toBe('{"list":["c","a","b"]}');
  });

  it('sorts keys inside objects nested in arrays', () => {
    expect(canonicalise([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it('drops undefined properties', () => {
    expect(canonicalise({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('canonicalises an absent key and an explicitly undefined key identically', () => {
    // They mean the same thing to every reader downstream, and only one of them
    // survives a JSON round trip — so they have to sign the same.
    expect(canonicalise({ notes: undefined, calibrationVersion: 3 })).toBe(
      canonicalise({ calibrationVersion: 3 }),
    );
  });

  it('preserves null', () => {
    expect(canonicalise({ notes: null })).toBe('{"notes":null}');
  });

  it('produces identical output for objects differing only in key insertion order', () => {
    const first: Record<string, unknown> = {};
    first['schemaVersion'] = 1;
    first['calibrationVersion'] = 7;
    first['industrySynonyms'] = { construction: ['bau'], software: ['saas'] };

    const second: Record<string, unknown> = {};
    second['industrySynonyms'] = { software: ['saas'], construction: ['bau'] };
    second['calibrationVersion'] = 7;
    second['schemaVersion'] = 1;

    expect(canonicalise(first)).toBe(canonicalise(second));
  });

  it('emits no insignificant whitespace', () => {
    expect(canonicalise({ a: [1, 2], b: { c: 3 } })).toBe('{"a":[1,2],"b":{"c":3}}');
  });

  it('returns null rather than throwing on a circular reference', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;

    expect(canonicalise(circular)).toBeNull();
  });

  it('returns null for a value JSON cannot represent at all', () => {
    expect(canonicalise(undefined)).toBeNull();
    expect(canonicalise(() => 'nope')).toBeNull();
  });
});

describe('canonicalBytes', () => {
  it('returns the UTF-8 bytes of canonicalise', () => {
    const value = { b: 'Geschäftsführer', a: ['sócio', 'bâtiment'] };
    const bytes = canonicalBytes(value);

    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe(canonicalise(value));
  });

  it('encodes multi-byte characters as more bytes than characters', () => {
    // Guards against a latin-1 style encoder sneaking in: the canonical form is
    // UTF-8 and the signature is over bytes, not over code units.
    const bytes = canonicalBytes({ a: 'ä' });

    expect(bytes).not.toBeNull();
    expect((bytes as Uint8Array).length).toBeGreaterThan(
      (canonicalise({ a: 'ä' }) as string).length,
    );
  });

  it('returns null when the value cannot be canonicalised', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    expect(canonicalBytes(circular)).toBeNull();
  });
});
