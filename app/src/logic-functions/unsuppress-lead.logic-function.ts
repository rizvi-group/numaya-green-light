import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';
import { Response, type RoutePayload } from 'twenty-sdk/logic-function';

import {
  UNSUPPRESS_LEAD_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
  UNSUPPRESS_LEAD_ROUTE_PATH,
} from 'src/constants/gate-queue-identifiers';
import { runUnsuppressLead } from 'src/logic-functions/suppression-run';

/**
 * "Allow contact again" — lift a suppression.
 *
 * The more sensitive of the two block-list actions, because it re-enables
 * contact with somebody who is on record asking us to stop. Three things make it
 * heavier than its counterpart, and all three are enforced server-side in
 * `parseUnsuppressRequest` rather than in the panel, because a client-side guard
 * on a compliance action is decoration:
 *
 *   1. A reason from a **separate** closed list, every entry of which is a claim
 *      that the suppression itself was wrong or has been superseded.
 *   2. A **mandatory** free-text note. This is the opposite of the release
 *      override's policy and the asymmetry is the point: a daily action collects
 *      the word "ok" in a required text box, a rare and consequential one
 *      collects the actual reason.
 *   3. An explicit acknowledgement that contact is being re-enabled.
 *
 * The audit row records the reason the person was suppressed *under*, not only
 * the reason given for lifting it — "which legal-request blocks has this
 * workspace lifted, and who lifted them" is the question the trail exists to
 * answer, and it is unanswerable from the removal reason alone.
 *
 * Note what this action is **not**: it is not a route around the compliance gate.
 * A blocked lead still cannot be released by hand (`ALLOW_COMPLIANCE_OVERRIDE`
 * in `src/gate/release-decision.ts`). This clears the underlying *data*, and the
 * lead then re-scores and clears itself through evidence — which is exactly the
 * escape hatch that file describes as the only legitimate one.
 */
const actorDisplayNameFor = (event: RoutePayload): string =>
  event.userWorkspaceId === null || event.userWorkspaceId === undefined
    ? 'Unidentified workspace member'
    : `Workspace member ${event.userWorkspaceId}`;

const handler = async (event: RoutePayload) => {
  const result = await runUnsuppressLead({
    client: new CoreApiClient(),
    body: event.body,
    now: new Date(),
    actorDisplayName: actorDisplayNameFor(event),
  });

  return new Response(result.body, { status: result.status });
};

export default defineLogicFunction({
  universalIdentifier: UNSUPPRESS_LEAD_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
  name: 'greenlight-unsuppress-lead',
  description:
    'Removes a person from the Greenlight do-not-contact list. Requires a reason, a written note and an explicit acknowledgement, and appends the removal to the audit log.',
  timeoutSeconds: 15,
  handler,
  httpRouteTriggerSettings: {
    path: UNSUPPRESS_LEAD_ROUTE_PATH,
    httpMethod: 'POST',
    isAuthRequired: true,
  },
});
