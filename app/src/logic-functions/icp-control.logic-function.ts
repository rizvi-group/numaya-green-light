import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';
import { Response, type RoutePayload } from 'twenty-sdk/logic-function';

import {
  ICP_REVIEW_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
  ICP_ROUTE_PATH,
} from 'src/constants/icp-identifiers';
import { parseIcpCommand } from 'src/icp/icp-command';
import { runIcpCommand } from 'src/logic-functions/icp-run';
import { kvBackfillStateStore } from 'src/logic-functions/backfill-state-store';

/**
 * The admin's handle on the ideal-customer profile: what it is costing to leave
 * it empty, what the workspace's own data suggests it should be, what applying
 * that would do, and — only then — applying it.
 *
 * ## Why one route with five actions
 *
 * Because they are five views of one question and the panel has to hold them
 * together. A `propose` that could not also return the impact would put the
 * suggestion and its consequence on two round trips, and a UI that renders a
 * profile before it can render what the profile does is a UI that will be used
 * that way. `status` is the free, side-effect-free default for the same reason
 * the backfill route makes it the default: the two actions that change something
 * both have to be asked for by name, and `apply` additionally has to be
 * confirmed in the body.
 *
 * ## Identity
 *
 * `userWorkspaceId` comes off the authenticated request, so it is server-derived
 * and cannot be asserted by the caller — the same limitation and the same
 * reasoning as the release, suppression and backfill actions. It is what lands in
 * the audit row, so "who narrowed the profile that started gating half the
 * pipeline" has an answer.
 *
 * ## Timeout
 *
 * Sixty seconds, against a documented worst case of 32 requests for a `propose`
 * (fourteen schema probes, ten pages of companies, five of people, two counts and
 * a config read). The other actions cost 1 to 8. Sixty is roughly four times the
 * expected wall-clock and still fails while somebody is looking at the panel,
 * which is the property that matters: a hung propose has to end in an error
 * message, not in a spinner nobody can interpret.
 */
const actorFor = (event: RoutePayload): string =>
  event.userWorkspaceId === null || event.userWorkspaceId === undefined
    ? 'Unidentified workspace member'
    : `Workspace member ${event.userWorkspaceId}`;

const handler = async (event: RoutePayload) => {
  const parsed = parseIcpCommand(event.body);

  if (!parsed.ok) {
    return new Response(
      {
        outcome: 'invalid_request',
        message: parsed.message,
        status: null,
        proposal: null,
        impact: null,
        selection: null,
        warnings: [],
        notes: [],
        rescore: null,
      },
      { status: 400 },
    );
  }

  const outcome = await runIcpCommand(parsed.command, {
    client: new CoreApiClient(),
    store: kvBackfillStateStore,
    now: new Date(),
    requestedBy: actorFor(event),
  });

  return new Response(outcome.body, { status: outcome.status });
};

export default defineLogicFunction({
  universalIdentifier: ICP_REVIEW_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
  name: 'greenlight-icp-review',
  description:
    'Reports how much of the Greenlight scoring model is idle for want of an ideal-customer profile, proposes one from the workspace’s own companies, previews what applying it would change, and applies it.',
  timeoutSeconds: 60,
  handler,
  httpRouteTriggerSettings: {
    path: ICP_ROUTE_PATH,
    httpMethod: 'POST',
    isAuthRequired: true,
  },
});
