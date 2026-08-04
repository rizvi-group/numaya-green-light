import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';
import { Response, type RoutePayload } from 'twenty-sdk/logic-function';

import {
  BACKFILL_CONTROL_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
  BACKFILL_ROUTE_PATH,
} from 'src/constants/backfill-identifiers';
import { parseBackfillCommand } from 'src/backfill/backfill-command';
import {
  readBackfillStatus,
  startBackfill,
  stopBackfill,
} from 'src/logic-functions/backfill-run';
import { kvBackfillStateStore } from 'src/logic-functions/backfill-state-store';

/**
 * The admin's handle on the backfill: how far it has got, start one, stop one.
 *
 * ## Why a route and a panel rather than a config field
 *
 * A `BackfillEnabled` checkbox on `GreenlightConfig` would have been less code.
 * It also answers none of the four questions an admin actually has — how many
 * records are unscored, is something running now, how far has it got, when did it
 * last finish — and a checkbox that silently means "at some point in the next
 * five hours your whole workspace will be re-scored" is worse than no control at
 * all. Those four answers need a live read of both the workspace and the run's
 * durable state, and that is a request/response, not a stored field.
 *
 * It is also why *status* is a POST to the same route rather than a separate GET:
 * every render of the panel takes one authenticated round trip and gets the whole
 * picture, so the panel can never show a stale count next to a fresh progress bar.
 *
 * ## Identity
 *
 * `userWorkspaceId` comes off the authenticated request, so it is server-derived
 * and cannot be asserted by the caller — the same limitation and the same
 * reasoning as the release and suppression actions. It is what lands in the run's
 * `requestedBy` and in the audit row, so "who started the re-score that changed
 * four hundred decisions" has an answer.
 *
 * ## Nothing here is trusted
 *
 * The body is parsed by a pure function against a closed list of actions and a
 * closed list of modes (`src/backfill/backfill-command.ts`). An unrecognised
 * action is a `400` rather than a silent status read, because a client asking for
 * something this server does not implement should be told, not quietly given
 * something else.
 */
const actorFor = (event: RoutePayload): string =>
  event.userWorkspaceId === null || event.userWorkspaceId === undefined
    ? 'Unidentified workspace member'
    : `Workspace member ${event.userWorkspaceId}`;

const handler = async (event: RoutePayload) => {
  const parsed = parseBackfillCommand(event.body);

  if (!parsed.ok) {
    return new Response(
      {
        outcome: 'invalid_request',
        message: parsed.message,
        run: null,
        neverScoredCount: null,
      },
      { status: 400 },
    );
  }

  const deps = {
    client: new CoreApiClient(),
    store: kvBackfillStateStore,
    now: new Date(),
  };

  const result =
    parsed.command.action === 'start'
      ? await startBackfill({
          ...deps,
          mode: parsed.command.mode,
          requestedBy: actorFor(event),
        })
      : parsed.command.action === 'stop'
        ? await stopBackfill({ ...deps, requestedBy: actorFor(event) })
        : await readBackfillStatus(deps);

  return new Response(result.body, { status: result.status });
};

export default defineLogicFunction({
  universalIdentifier: BACKFILL_CONTROL_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
  name: 'greenlight-backfill-control',
  description:
    'Reports how many leads have never been scored, and starts or stops the Greenlight backfill.',
  // Two counting queries and at most one key-value write. Fifteen seconds is the
  // same budget the other human-triggered actions get: long enough for a slow
  // instance, short enough that a hung call fails while somebody is still
  // looking at the panel.
  timeoutSeconds: 15,
  handler,
  httpRouteTriggerSettings: {
    path: BACKFILL_ROUTE_PATH,
    httpMethod: 'POST',
    isAuthRequired: true,
  },
});
