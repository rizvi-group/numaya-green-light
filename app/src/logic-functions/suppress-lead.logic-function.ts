import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';
import { Response, type RoutePayload } from 'twenty-sdk/logic-function';

import {
  SUPPRESS_LEAD_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
  SUPPRESS_LEAD_ROUTE_PATH,
} from 'src/constants/gate-queue-identifiers';
import { resolveActorDisplayName } from 'src/logic-functions/actor-identity';
import { runSuppressLead } from 'src/logic-functions/suppression-run';

/**
 * "Do not contact" — add a person to Greenlight's block list, with a reason.
 *
 * A shell, exactly like `release-lead.logic-function.ts`: the decision rules are
 * in `src/gate/suppression-decision.ts` and the I/O is in `suppression-run.ts`,
 * both of which are drivable without a live workspace. This file exists to hand
 * over a real client, a real clock and a server-derived actor.
 *
 * ## Why an action at all, when the field is editable
 *
 * The field is editable so a rep can act in ten seconds. The action exists for
 * everything the field cannot do: force a reason from the closed list, stamp the
 * date, and put a row in `GreenlightAuditLog` naming who did it and why. Both
 * routes are legitimate and they trade different things — the honest position is
 * to ship both rather than to pretend a compliance register is only ever
 * maintained deliberately.
 *
 * ## Identity
 *
 * `userWorkspaceId` comes off the authenticated request, so it is server-derived
 * and cannot be asserted by the caller, and `resolveActorDisplayName` turns it
 * into that person's name without ever reading the body. Same guarantee and same
 * reasoning as the release override — and the same correction: the row used to
 * carry the bare id, which told a later reader of the block list nothing about
 * who added somebody to it.
 */
const handler = async (event: RoutePayload) => {
  const result = await runSuppressLead({
    client: new CoreApiClient(),
    body: event.body,
    now: new Date(),
    actorDisplayName: await resolveActorDisplayName(event),
  });

  return new Response(result.body, { status: result.status });
};

export default defineLogicFunction({
  universalIdentifier: SUPPRESS_LEAD_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
  name: 'greenlight-suppress-lead',
  description:
    'Adds a person to the Greenlight do-not-contact list with a recorded reason, and appends the block to the audit log.',
  timeoutSeconds: 15,
  handler,
  httpRouteTriggerSettings: {
    path: SUPPRESS_LEAD_ROUTE_PATH,
    httpMethod: 'POST',
    isAuthRequired: true,
  },
});
