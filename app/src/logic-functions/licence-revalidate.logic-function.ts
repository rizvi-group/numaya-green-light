import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';

import {
  LICENCE_REVALIDATE_CRON_PATTERN,
  LICENCE_REVALIDATE_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
} from 'src/constants/licence-identifiers';
import {
  kvCalibrationStore,
  kvLicenceStore,
} from 'src/logic-functions/licence-cache-store';
import { createHttpLicensingClient } from 'src/logic-functions/licence-http-client';
import {
  readLicenceEnvironment,
  runLicenceRevalidation,
} from 'src/logic-functions/licence-run';
import { metadataWorkspaceIdentity } from 'src/logic-functions/licence-workspace-identity';

/**
 * Nightly licence re-validation.
 *
 * ## Why nightly, and why this is the only scheduled call
 *
 * The cached entitlement is trusted for 24 hours, so validating once a day is
 * the lowest frequency that never lets the cache go stale between runs and the
 * highest that buys anything. Validating per lead event, or per app launch,
 * would put a customer's scoring path behind a network call to us — which is
 * precisely the coupling the fail-open rule exists to prevent.
 *
 * Revocation therefore takes up to 24 hours to bite. That is a deliberate
 * trade: the alternative is Numaya pushing `license.revoked` webhooks into
 * customer instances, which means every workspace exposing an inbound endpoint
 * to us. Not worth it for a day of latency on an event that happens rarely and
 * costs us a single workspace's enrichment.
 *
 * ## What this run can and cannot do
 *
 * It **cannot** stop leads being scored — there is no code path from here to the
 * scoring engine, and `LicenceMode` has no "off". The worst outcome of every
 * branch is that `enrichmentEnabled` becomes false and an audit row explains
 * why. See `src/licensing/state.ts` for the full decision table.
 *
 * It also does not call `activate`: the slot is claimed once at install, and
 * re-claiming it nightly would be a write per workspace per day to a service
 * that learns nothing from it.
 *
 * ## Calibration
 *
 * This run is also where licence-delivered scoring calibration arrives. It costs
 * no extra request: the `validate` response already carries the licence's
 * `customerMetadata`, and that is the only channel through which the licensing
 * service will hand org-authored data to a bare licence-key holder — its two
 * config-download endpoints refuse licence keys by design. The payload's Ed25519
 * signature is verified against a public key embedded in this build before
 * anything is cached. See `src/calibration/`.
 *
 * Calibration is strictly downstream of the entitlement here, and nothing about
 * it can affect the licence decision, the audit row or the admin notice. If it
 * fails — absent, malformed, unsigned, wrongly signed, or a runtime with no
 * Ed25519 — the workspace scores on the shipped defaults, which is exactly what
 * an unlicensed install has always done.
 *
 * ## Timeout
 *
 * 30s. The HTTP client's own budget is 8s, leaving room for the metadata query,
 * five key-value writes, one signature verification and the audit mutation.
 * Failing fast is right here: a hung licence check must not pin a worker, and if
 * it fails there is a cached entitlement and another run tomorrow.
 */
const handler = async () => {
  // Read once: the environment is the only impure input this file contributes,
  // and reading it twice invites the two values drifting apart in a future edit.
  const environment = readLicenceEnvironment();

  return runLicenceRevalidation({
    licensing: createHttpLicensingClient({
      baseUrl: environment.baseUrl,
      environment: environment.environment,
    }),
    store: kvLicenceStore,
    // The same run that refreshes the entitlement also refreshes the calibration
    // it delivers — see the "Calibration" section below.
    calibration: kvCalibrationStore,
    identity: metadataWorkspaceIdentity,
    client: new CoreApiClient(),
    licenceKey: environment.licenceKey,
    environment: environment.environment,
    now: new Date(),
  });
};

export default defineLogicFunction({
  universalIdentifier: LICENCE_REVALIDATE_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
  name: 'greenlight-licence-revalidate',
  description:
    'Re-validates the Numaya AI licence nightly, refreshes the cached entitlement and records the resulting mode in the Greenlight audit log. Never blocks scoring.',
  timeoutSeconds: 30,
  handler,
  cronTriggerSettings: {
    pattern: LICENCE_REVALIDATE_CRON_PATTERN,
  },
});
