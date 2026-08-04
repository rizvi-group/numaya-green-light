/**
 * Parsing what the admin panel asked for.
 *
 * Pure, and separate from the route for the same reason
 * `src/gate/release-decision.ts` is separate from its logic function: what the
 * server accepts is a contract, and a contract asserted by unit tests is a
 * contract. It is also the only place a request body is trusted with anything, so
 * it is worth being able to read it in one screen.
 *
 * Both lists are closed. An unrecognised action is refused rather than defaulted
 * to `status`, because a client asking for something that does not exist has a
 * bug, and answering it with a plausible-looking success is how that bug survives
 * to production. An unrecognised *mode* is refused for a much sharper reason:
 * defaulting a mis-spelled mode to `all` would re-score an entire workspace,
 * overwriting decisions reps are working from, in response to a typo.
 */

import { BACKFILL_MODES, isBackfillMode, type BackfillMode } from 'src/backfill/backfill-state';

export const BACKFILL_ACTIONS = ['status', 'start', 'stop'] as const;

export type BackfillAction = (typeof BACKFILL_ACTIONS)[number];

export type BackfillCommand =
  | { readonly action: 'status' }
  | { readonly action: 'stop' }
  | { readonly action: 'start'; readonly mode: BackfillMode };

export type BackfillCommandParseResult =
  | { readonly ok: true; readonly command: BackfillCommand }
  | { readonly ok: false; readonly message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseBackfillCommand = (
  body: unknown,
): BackfillCommandParseResult => {
  // An empty body is a status read. The panel polls with `{}` on every render,
  // and making the safe, read-only, side-effect-free action the one you get for
  // free is the right way round — the two actions that change something both
  // have to be asked for by name.
  if (body === undefined || body === null) {
    return { ok: true, command: { action: 'status' } };
  }

  if (!isRecord(body)) {
    return { ok: false, message: 'Backfill request body must be an object.' };
  }

  const rawAction = body['action'];
  const action =
    rawAction === undefined || rawAction === null
      ? 'status'
      : typeof rawAction === 'string'
        ? rawAction.trim().toLowerCase()
        : '';

  if (!(BACKFILL_ACTIONS as readonly string[]).includes(action)) {
    return {
      ok: false,
      message: `Unknown backfill action. Expected one of ${BACKFILL_ACTIONS.join(', ')}.`,
    };
  }

  if (action === 'status') {
    return { ok: true, command: { action: 'status' } };
  }

  if (action === 'stop') {
    return { ok: true, command: { action: 'stop' } };
  }

  const rawMode = body['mode'];
  const mode =
    rawMode === undefined || rawMode === null
      ? 'unscored'
      : typeof rawMode === 'string'
        ? rawMode.trim().toLowerCase()
        : '';

  if (!isBackfillMode(mode)) {
    return {
      ok: false,
      message: `Unknown backfill mode. Expected one of ${BACKFILL_MODES.join(', ')}.`,
    };
  }

  return { ok: true, command: { action: 'start', mode } };
};

/** Panel copy, kept beside the closed list so the two cannot drift apart. */
export const BACKFILL_MODE_LABELS: Readonly<
  Record<BackfillMode, { label: string; hint: string }>
> = {
  unscored: {
    label: 'Leads that have never been scored',
    hint: 'Everyone who was already in the CRM when Greenlight was installed. Nothing already scored is touched.',
  },
  all: {
    label: 'Re-score every lead',
    hint: 'Use after changing rules, weights or the gate threshold. Decisions your team is already working from will change.',
  },
};
