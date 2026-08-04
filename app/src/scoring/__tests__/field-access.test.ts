import { DEFAULT_FIELD_MAPPING } from 'src/scoring/defaults';
import {
  createFieldReader,
  getByPath,
  isPlaceholder,
  stringLeaves,
  toBooleanValue,
  toDateValue,
  toLeadRecord,
  toNumberValue,
} from 'src/scoring/field-access';
import { describe, expect, it } from 'vitest';
import type { FieldMapping } from 'src/scoring/types';

describe('toLeadRecord', () => {
  it('lifts a CRM record straight into a lead', () => {
    const lead = toLeadRecord({ id: 'abc', companyName: 'Northwind' });

    expect(lead.id).toBe('abc');
    expect(lead.fields['companyName']).toBe('Northwind');
  });

  it.each([[null], [undefined], ['nope'], [42], [[1, 2]]])(
    'returns an empty lead rather than throwing for %s',
    (input) => {
      const lead = toLeadRecord(input);

      expect(lead.id).toBeNull();
      expect(Object.keys(lead.fields)).toHaveLength(0);
    },
  );
});

describe('getByPath', () => {
  it('walks nested objects and array indexes', () => {
    const source = { a: { b: [{ c: 'found' }] } };

    expect(getByPath(source, 'a.b.0.c')).toBe('found');
  });

  it('falls back to a case-insensitive key match', () => {
    expect(getByPath({ address: { addressCountry: 'UK' } }, 'address.addresscountry')).toBe(
      'UK',
    );
  });

  it('returns undefined for a path that does not exist', () => {
    expect(getByPath({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(getByPath(null, 'a')).toBeUndefined();
  });
});

describe('value coercion', () => {
  it('flattens composite fields into their string leaves in key order', () => {
    expect(stringLeaves({ firstName: 'Ada', lastName: 'Lovelace' })).toEqual([
      'Ada',
      'Lovelace',
    ]);
    expect(
      stringLeaves({ primaryEmail: 'a@b.co', additionalEmails: ['c@d.co'] }),
    ).toEqual(['a@b.co', 'c@d.co']);
  });

  it.each([
    ['1,200', 1200],
    ['250+', 250],
    ['50-200', 50],
    [42, 42],
    [{ value: '  7 ' }, 7],
  ])('reads %s as the number %s', (input, expected) => {
    expect(toNumberValue(input)).toBe(expected);
  });

  it('returns null for numbers that are not there', () => {
    expect(toNumberValue('no idea')).toBeNull();
    expect(toNumberValue(Number.NaN)).toBeNull();
    expect(toNumberValue(undefined)).toBeNull();
  });

  it('reads dates from strings, epochs and Date objects', () => {
    expect(toDateValue('2026-01-15')?.toISOString()).toBe('2026-01-15T00:00:00.000Z');
    expect(toDateValue(new Date('2026-01-15'))?.toISOString()).toBe(
      '2026-01-15T00:00:00.000Z',
    );
    expect(toDateValue('never')).toBeNull();
    expect(toDateValue(new Date('never'))).toBeNull();
  });

  it.each([
    [true, true],
    ['yes', true],
    ['UNSUBSCRIBED', true],
    [1, true],
    [false, false],
    ['no', false],
    [0, false],
    ['maybe', null],
  ])('reads %s as the boolean %s', (input, expected) => {
    expect(toBooleanValue(input)).toBe(expected);
  });

  it('recognises placeholder text', () => {
    expect(isPlaceholder('N/A')).toBe(true);
    expect(isPlaceholder(' unknown ')).toBe(true);
    expect(isPlaceholder('Northwind')).toBe(false);
  });
});

describe('createFieldReader', () => {
  const mapping: FieldMapping = {
    ...DEFAULT_FIELD_MAPPING,
    companyName: ['org.title', 'companyName'],
  };

  it('tries mapped candidates in order and records which one won', () => {
    const reader = createFieldReader(
      { id: null, fields: { companyName: 'Fallback Ltd' } },
      mapping,
    );

    expect(reader.text('companyName')).toBe('Fallback Ltd');
    expect(reader.observations()[0]?.mappedTo).toBe('companyName');
  });

  it('prefers the first candidate that has a value', () => {
    const reader = createFieldReader(
      { id: null, fields: { org: { title: 'Primary Ltd' }, companyName: 'Fallback Ltd' } },
      mapping,
    );

    expect(reader.text('companyName')).toBe('Primary Ltd');
    expect(reader.observations()[0]?.mappedTo).toBe('org.title');
  });

  it('records a miss with the candidates it tried', () => {
    const reader = createFieldReader({ id: null, fields: {} }, mapping);

    expect(reader.text('companyName')).toBeNull();

    const observation = reader.observations()[0];

    expect(observation?.present).toBe(false);
    expect(observation?.display).toBe('(not set)');
    expect(observation?.candidates).toEqual(['org.title', 'companyName']);
  });

  it('treats an empty string, empty array and empty object as absent', () => {
    const reader = createFieldReader(
      { id: null, fields: { companyName: '   ', emails: [], phones: {} } },
      DEFAULT_FIELD_MAPPING,
    );

    expect(reader.text('companyName')).toBeNull();
    expect(reader.textList('email')).toHaveLength(0);
    expect(reader.text('phone')).toBeNull();
  });

  it('returns true from booleanAny when any mapped field is set', () => {
    const reader = createFieldReader(
      { id: null, fields: { optedOut: false, unsubscribed: true } },
      DEFAULT_FIELD_MAPPING,
    );

    expect(reader.booleanAny('optedOut')).toBe(true);
    expect(reader.observations()[0]?.mappedTo).toBe('unsubscribed');
  });

  it('returns null from booleanAny when nothing is recorded', () => {
    const reader = createFieldReader({ id: null, fields: {} }, DEFAULT_FIELD_MAPPING);

    expect(reader.booleanAny('optedOut')).toBeNull();
  });

  it('survives a mapping entry that is not a list', () => {
    const broken = { ...DEFAULT_FIELD_MAPPING, companyName: 'org.title' } as unknown as FieldMapping;
    const reader = createFieldReader({ id: null, fields: { org: { title: 'X' } } }, broken);

    expect(reader.text('companyName')).toBeNull();
    expect(reader.observations()[0]?.present).toBe(false);
  });
});
