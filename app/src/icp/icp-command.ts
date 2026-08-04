/**
 * Parsing what the ICP panel asked for.
 *
 * Pure and separate from the route, for the same reason
 * `src/backfill/backfill-command.ts` is: what the server accepts is a contract,
 * and a contract asserted by unit tests is a contract. It is also the only place
 * a request body is trusted with anything, and the thing being trusted here is
 * larger than a mode string — it is the profile that will be written into the
 * record every future score is computed against.
 *
 * Three rules govern the whole file:
 *
 *   1. **The action list is closed.** An unrecognised action is refused, not
 *      defaulted to `status`: a client asking for something that does not exist
 *      has a bug, and answering it with a plausible success is how that bug
 *      reaches production.
 *   2. **`apply` requires `confirm: true` from the server's point of view.** The
 *      panel's checkbox is a courtesy; this is the guard. A one-click apply that
 *      re-gates a sales team's pipeline is exactly what this product exists to
 *      prevent, so "I meant it" is part of the request, not part of the UI.
 *   3. **Malformed entries are dropped *and reported*.** Silently discarding
 *      half a profile would write a config the admin did not choose and cannot
 *      see; refusing the whole request over one bad row would make a long
 *      hand-edited list impossible to submit. Dropping with a warning is the
 *      only option that leaves the human able to tell what happened.
 */

import { normalise } from 'src/scoring/rules/helpers';
import type { IcpSizeBand } from 'src/scoring';

import type { IcpSelection } from 'src/icp/icp-proposal';

export const ICP_ACTIONS = [
  'status',
  'propose',
  'preview',
  'apply',
  'leave-open',
] as const;

export type IcpAction = (typeof ICP_ACTIONS)[number];

/**
 * Caps, so a malformed or hostile body cannot turn into a config record that
 * costs a second on every scored lead. Both are far above any real profile: a
 * workspace naming two hundred target industries has not described a profile.
 */
export const MAX_ICP_VALUES = 200;
export const MAX_ICP_BANDS = 20;

export type IcpCommand =
  | { readonly action: 'status' }
  | { readonly action: 'propose' }
  | {
      readonly action: 'preview';
      readonly selection: IcpSelection;
      readonly warnings: readonly string[];
    }
  | {
      readonly action: 'apply';
      readonly selection: IcpSelection;
      readonly warnings: readonly string[];
      /** Re-score existing leads afterwards, via the existing backfill. */
      readonly rescore: boolean;
    }
  | { readonly action: 'leave-open' };

export type IcpCommandParseResult =
  | { readonly ok: true; readonly command: IcpCommand }
  | { readonly ok: false; readonly message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface ParsedSelection {
  readonly selection: IcpSelection;
  readonly warnings: readonly string[];
}

const parseValueList = (
  raw: unknown,
  label: string,
  warnings: string[],
): string[] => {
  if (raw === undefined || raw === null) {
    return [];
  }

  if (!Array.isArray(raw)) {
    warnings.push(`The ${label} list was not a list, so it was ignored.`);
    return [];
  }

  const seen = new Set<string>();
  const values: string[] = [];
  let dropped = 0;

  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      dropped += 1;
      continue;
    }

    // De-duplicated by the engine's own `normalise`, because that is what
    // `matchesList` compares with — two entries that normalise the same are one
    // target, and storing both would only make the record harder to read.
    const key = normalise(entry);

    if (key.length === 0 || seen.has(key)) {
      continue;
    }

    if (values.length >= MAX_ICP_VALUES) {
      dropped += 1;
      continue;
    }

    seen.add(key);
    values.push(entry.trim());
  }

  if (dropped > 0) {
    warnings.push(
      `${dropped} ${label} ${dropped === 1 ? 'entry was' : 'entries were'} empty, not text, or beyond the ${MAX_ICP_VALUES}-entry limit, and ${
        dropped === 1 ? 'was' : 'were'
      } left out.`,
    );
  }

  return values;
};

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const parseBands = (raw: unknown, warnings: string[]): IcpSizeBand[] => {
  if (raw === undefined || raw === null) {
    return [];
  }

  if (!Array.isArray(raw)) {
    warnings.push('The size bands were not a list, so they were ignored.');
    return [];
  }

  const bands: IcpSizeBand[] = [];
  let dropped = 0;

  for (const entry of raw) {
    if (!isRecord(entry) || bands.length >= MAX_ICP_BANDS) {
      dropped += 1;
      continue;
    }

    const min = entry['minEmployees'];
    const rawMax = entry['maxEmployees'];

    // Exactly the validation `resolveIcp` applies, applied here as well so that
    // a band this parser accepts is a band the engine will keep. A band that
    // survives the write and is then silently dropped at scoring time is worse
    // than a rejected one: the record would show a profile the engine is not
    // using.
    if (!isFiniteNumber(min) || min < 0) {
      dropped += 1;
      continue;
    }

    const max = isFiniteNumber(rawMax) ? rawMax : null;

    if (max !== null && max < min) {
      dropped += 1;
      continue;
    }

    const label =
      typeof entry['label'] === 'string' && entry['label'].trim().length > 0
        ? entry['label'].trim()
        : `${Math.round(min)}–${max === null ? '∞' : Math.round(max)} employees`;

    bands.push({
      label,
      minEmployees: Math.round(min),
      maxEmployees: max === null ? null : Math.round(max),
    });
  }

  if (dropped > 0) {
    warnings.push(
      `${dropped} size ${dropped === 1 ? 'band was' : 'bands were'} missing a usable employee range and ${
        dropped === 1 ? 'was' : 'were'
      } left out. A band needs a minimum, and a maximum that is either a number or empty for "no upper limit".`,
    );
  }

  return bands;
};

const parseSelection = (raw: unknown): ParsedSelection | null => {
  if (!isRecord(raw)) {
    return null;
  }

  const warnings: string[] = [];

  return {
    selection: {
      industries: parseValueList(raw['industries'], 'industry', warnings),
      regions: parseValueList(raw['regions'], 'region', warnings),
      sizeBands: parseBands(raw['sizeBands'], warnings),
    },
    warnings,
  };
};

const isEmpty = (selection: IcpSelection): boolean =>
  selection.industries.length === 0 &&
  selection.regions.length === 0 &&
  selection.sizeBands.length === 0;

export const parseIcpCommand = (body: unknown): IcpCommandParseResult => {
  // An empty body is a status read: the safe, read-only, side-effect-free action
  // is the one you get for free, and every action that changes something has to
  // be asked for by name. Same reasoning as the backfill route.
  if (body === undefined || body === null) {
    return { ok: true, command: { action: 'status' } };
  }

  if (!isRecord(body)) {
    return { ok: false, message: 'ICP request body must be an object.' };
  }

  const rawAction = body['action'];
  const action =
    rawAction === undefined || rawAction === null
      ? 'status'
      : typeof rawAction === 'string'
        ? rawAction.trim().toLowerCase()
        : '';

  if (!(ICP_ACTIONS as readonly string[]).includes(action)) {
    return {
      ok: false,
      message: `Unknown ICP action. Expected one of ${ICP_ACTIONS.join(', ')}.`,
    };
  }

  if (action === 'status' || action === 'propose' || action === 'leave-open') {
    return { ok: true, command: { action } as IcpCommand };
  }

  const parsed = parseSelection(body['selection']);

  if (parsed === null) {
    return {
      ok: false,
      message:
        'That request carried no profile to work with. Send a "selection" object with industries, regions and sizeBands.',
    };
  }

  if (action === 'preview') {
    return {
      ok: true,
      command: {
        action: 'preview',
        selection: parsed.selection,
        warnings: parsed.warnings,
      },
    };
  }

  if (isEmpty(parsed.selection)) {
    return {
      ok: false,
      message:
        'That profile is empty, which is what the workspace already has. If you mean to leave the profile open on purpose, use "Leave it open" instead — that records the decision rather than pretending one was made.',
    };
  }

  if (body['confirm'] !== true) {
    return {
      ok: false,
      message:
        'Applying a profile changes the decision on every lead scored from now on. Confirm the preview before applying.',
    };
  }

  return {
    ok: true,
    command: {
      action: 'apply',
      selection: parsed.selection,
      warnings: parsed.warnings,
      rescore: body['rescore'] === true,
    },
  };
};
