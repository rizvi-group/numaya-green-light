import { defineLogicFunction } from 'twenty-sdk/define';
import { Response } from 'twenty-sdk/logic-function';

import {
  LICENCE_PURCHASE_URL,
  LICENCE_ROUTE_PATH,
  LICENCE_STATUS_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
} from 'src/constants/licence-identifiers';
import { buildLicencePanelView } from 'src/licensing/panel';
import { readPublishedLicenceState } from 'src/logic-functions/licence-cache-store';
import { readLicenceEnvironment } from 'src/logic-functions/licence-run';

/**
 * What licence is this workspace running, and how does an admin change it.
 *
 * ## Why this reads and never validates
 *
 * The obvious design is a route that calls the licensing service and reports
 * what it says. It is the wrong one twice over. It would put a network call to
 * Numaya on a path a human triggers, so the panel would hang or lie whenever we
 * are slow — and the nightly run already resolves exactly this state, applies
 * the cache and grace ladder to it, and publishes the result. A second resolver
 * reachable from a button is a second answer that can disagree with the first,
 * and the one on the screen would win the argument in the customer's mind.
 *
 * So this returns the published state and says when it was taken. "Checked 6
 * hours ago" is a fact an admin can act on. A number that might be fresh and
 * might be a timeout is not.
 *
 * ## Why no write, and no key in the response
 *
 * The panel cannot set the key. `LICENCE_KEY` is an application variable and
 * Twenty already owns that surface, including keeping secrets out of the UI and
 * the logs — reimplementing it here would mean this route accepting a raw key
 * over HTTP and storing it somewhere, which is a worse version of a solved
 * problem. The response carries the *masked* key only, which is what the
 * published state already holds.
 */
const handler = async () => {
  const { licenceKey } = readLicenceEnvironment();

  const view = buildLicencePanelView({
    state: await readPublishedLicenceState(),
    // The presence of a key, never its value. A route that reads the variable
    // to decide what to show must not be a route that can leak it.
    hasKeyConfigured: licenceKey !== null,
    purchaseUrl: LICENCE_PURCHASE_URL,
  });

  return new Response(view, { status: 200 });
};

export default defineLogicFunction({
  universalIdentifier: LICENCE_STATUS_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
  name: 'greenlight-licence-status',
  description:
    "Reports Greenlight's current licence mode, what enrichment it does or does not include, and where to obtain a licence.",
  // One key-value read and no network call, so this is the cheapest route in the
  // app. Ten seconds is well past what it needs and still short enough that a
  // wedged read fails while the panel is open.
  timeoutSeconds: 10,
  handler,
  httpRouteTriggerSettings: {
    path: LICENCE_ROUTE_PATH,
    httpMethod: 'POST',
    isAuthRequired: true,
  },
});
