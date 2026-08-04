/**
 * Reading values out of a lead record.
 *
 * Two problems are solved here, both of them schema-flexibility problems:
 *
 * 1. Customers name fields differently, so every read goes through the
 *    configured mapping (a list of candidate dotted paths, tried in order).
 * 2. CRM fields are often composite objects (`{ primaryEmail, additionalEmails }`,
 *    `{ firstName, lastName }`). Values are flattened generically by walking
 *    string leaves in key order — no field name is hard-coded anywhere.
 */

import { PLACEHOLDER_VALUES } from 'src/scoring/defaults';
import type {
  FieldMapping,
  FieldObservation,
  FieldReader,
  LeadFieldKey,
  LeadRecord,
} from 'src/scoring/types';

const MAX_LEAF_DEPTH = 4;

/** Fail-open coercion of anything the caller has into a `LeadRecord`. */
export const toLeadRecord = (record: unknown): LeadRecord => {
  if (!isPlainObject(record)) {
    return { id: null, fields: {} };
  }

  const id = typeof record['id'] === 'string' ? record['id'] : null;

  return { id, fields: record };
};

export const isPlainObject = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date);

/**
 * Resolve a dotted path against an object. Exact key match first, then a
 * case-insensitive match, so `address.addresscountry` still finds
 * `address.addressCountry`.
 */
export const getByPath = (source: unknown, path: string): unknown => {
  const segments = path.split('.').filter((segment) => segment.length > 0);

  let cursor: unknown = source;

  for (const segment of segments) {
    if (cursor === null || cursor === undefined) {
      return undefined;
    }

    if (Array.isArray(cursor)) {
      const index = Number(segment);
      cursor = Number.isInteger(index) ? cursor[index] : undefined;
      continue;
    }

    if (!isPlainObject(cursor)) {
      return undefined;
    }

    if (segment in cursor) {
      cursor = cursor[segment];
      continue;
    }

    const lowered = segment.toLowerCase();
    const matchedKey = Object.keys(cursor).find(
      (key) => key.toLowerCase() === lowered,
    );

    cursor = matchedKey === undefined ? undefined : cursor[matchedKey];
  }

  return cursor;
};

/** Every non-empty string leaf under a value, in key order. */
export const stringLeaves = (value: unknown, depth = 0): string[] => {
  if (depth > MAX_LEAF_DEPTH) {
    return [];
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return [String(value)];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => stringLeaves(entry, depth + 1));
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? [] : [value.toISOString()];
  }

  if (isPlainObject(value)) {
    return Object.keys(value).flatMap((key) =>
      stringLeaves(value[key], depth + 1),
    );
  }

  return [];
};

const isEmptyValue = (value: unknown): boolean =>
  value === null ||
  value === undefined ||
  (typeof value === 'string' && value.trim().length === 0) ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === 'number' && Number.isNaN(value)) ||
  (isPlainObject(value) && stringLeaves(value).length === 0);

/**
 * Whether a value is one of the strings that mean "somebody typed something
 * rather than nothing" — `n/a`, `tbd`, `xxx`, `keine angabe`.
 *
 * `known` defaults to the shipped list so every existing caller keeps its exact
 * behaviour. A rule that has a resolved config passes `config.placeholderValues`
 * instead, which is how a licence-delivered lexicon reaches this check without
 * the rule learning anything about licensing: the list is data, resolved by
 * `resolveConfig`, exactly like `decisionMakerTitles` already was.
 */
export const isPlaceholder = (
  value: string,
  known: readonly string[] = PLACEHOLDER_VALUES,
): boolean => known.includes(value.trim().toLowerCase());

export const toNumberValue = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'boolean') {
    return null;
  }

  const leaves = stringLeaves(value);

  for (const leaf of leaves) {
    // Tolerate "1,200", "1 200", "250+", "50-200" (takes the lower bound).
    const cleaned = leaf.replace(/[,\s]/g, '');
    const match = /-?\d+(\.\d+)?/.exec(cleaned);

    if (match !== null) {
      const parsed = Number(match[0]);

      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return null;
};

export const toDateValue = (value: unknown): Date | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const fromEpoch = new Date(value);
    return Number.isNaN(fromEpoch.getTime()) ? null : fromEpoch;
  }

  const leaves = stringLeaves(value);

  for (const leaf of leaves) {
    const parsed = new Date(leaf);

    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  return null;
};

const TRUTHY_TOKENS = new Set([
  'true',
  'yes',
  'y',
  '1',
  'opted_out',
  'opted-out',
  'optedout',
  'unsubscribed',
  'do_not_contact',
  'do-not-contact',
  'donotcontact',
  'dnc',
  'blocked',
]);

const FALSY_TOKENS = new Set([
  'false',
  'no',
  'n',
  '0',
  'subscribed',
  'opted_in',
  'opted-in',
  'optedin',
]);

export const toBooleanValue = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value !== 0;
  }

  const leaves = stringLeaves(value);

  for (const leaf of leaves) {
    const token = leaf.toLowerCase();

    if (TRUTHY_TOKENS.has(token)) {
      return true;
    }

    if (FALSY_TOKENS.has(token)) {
      return false;
    }
  }

  return null;
};

const renderDisplay = (value: unknown): string => {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  const leaves = stringLeaves(value);

  if (leaves.length === 0) {
    return '(not set)';
  }

  return leaves.slice(0, 3).join(', ');
};

interface Resolution {
  readonly mappedTo: string | null;
  readonly candidates: readonly string[];
  readonly value: unknown;
  readonly present: boolean;
}

/**
 * Builds the reader handed to rules. Every lookup is recorded, so a trace entry
 * can tell a salesperson exactly which field was consulted and what was in it.
 */
export const createFieldReader = (
  lead: LeadRecord,
  mapping: FieldMapping,
): FieldReader => {
  const seen = new Map<LeadFieldKey, FieldObservation>();

  const candidatesFor = (key: LeadFieldKey): readonly string[] => {
    const configured = mapping[key];
    return Array.isArray(configured) ? configured : [];
  };

  const resolveAll = (key: LeadFieldKey): Resolution[] => {
    const candidates = candidatesFor(key);

    return candidates.map((path) => {
      const value = getByPath(lead.fields, path);

      return {
        mappedTo: path,
        candidates,
        value,
        present: !isEmptyValue(value),
      };
    });
  };

  const resolve = (key: LeadFieldKey): Resolution => {
    const candidates = candidatesFor(key);
    const found = resolveAll(key).find((entry) => entry.present);

    if (found !== undefined) {
      return found;
    }

    return { mappedTo: null, candidates, value: undefined, present: false };
  };

  const record = (key: LeadFieldKey, resolution: Resolution): void => {
    seen.set(key, {
      key,
      mappedTo: resolution.mappedTo,
      candidates: resolution.candidates,
      present: resolution.present,
      display: resolution.present ? renderDisplay(resolution.value) : '(not set)',
    });
  };

  const readResolved = (key: LeadFieldKey): Resolution => {
    const resolution = resolve(key);
    record(key, resolution);
    return resolution;
  };

  return {
    text: (key) => {
      const leaves = stringLeaves(readResolved(key).value);
      return leaves.length > 0 ? leaves.join(' ') : null;
    },
    textList: (key) => stringLeaves(readResolved(key).value),
    number: (key) => toNumberValue(readResolved(key).value),
    date: (key) => toDateValue(readResolved(key).value),
    booleanAny: (key) => {
      const all = resolveAll(key);
      const present = all.filter((entry) => entry.present);
      const truthy = present.find((entry) => toBooleanValue(entry.value) === true);

      if (truthy !== undefined) {
        record(key, truthy);
        return true;
      }

      const first = present[0];

      if (first !== undefined) {
        record(key, first);
        return toBooleanValue(first.value) === true ? true : false;
      }

      record(key, {
        mappedTo: null,
        candidates: candidatesFor(key),
        value: undefined,
        present: false,
      });

      return null;
    },
    observations: () => Array.from(seen.values()),
  };
};
