import { CoreApiClient } from 'twenty-client-sdk/core';
import {
  definePostInstallLogicFunction,
  type InstallPayload,
} from 'twenty-sdk/define';

import { POST_INSTALL_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER } from 'src/constants/logic-function-identifiers';
import { requestInstallBackfill } from 'src/logic-functions/backfill-run';
import { kvBackfillStateStore } from 'src/logic-functions/backfill-state-store';
import { runPostInstall } from 'src/logic-functions/install-run';
import {
  kvCalibrationStore,
  kvLicenceStore,
} from 'src/logic-functions/licence-cache-store';
import { createHttpLicensingClient } from 'src/logic-functions/licence-http-client';
import {
  readLicenceEnvironment,
  runLicenceInstall,
} from 'src/logic-functions/licence-run';
import { metadataWorkspaceIdentity } from 'src/logic-functions/licence-workspace-identity';

/**
 * Seed (fresh install) or merge (upgrade) the workspace's `GreenlightConfig`.
 *
 * ## Where the values come from
 *
 * `buildDefaultConfig()` in the scoring engine, via
 * `buildGreenlightConfigSeed()`. Nothing here invents a threshold. The seed is
 * written **explicitly** rather than left to the field manifests'
 * `defaultValue`s: the manifests currently carry bands 80/60/40 with gate 40
 * while the engine scores against 85/70/50 with gate 50, and a config record
 * that disagrees with the code that reads it is worse than no record at all.
 * The manifest defaults remain a safety net for records created by hand; the
 * engine is the source of truth for records this app creates. Full reasoning in
 * `greenlight-config-record.ts`.
 *
 * ## Execution model
 *
 * `shouldRunSynchronously: false` (the default). Seeding is one query and one
 * mutation, so speed is not the argument — retries are. Async post-install is
 * enqueued with `retryLimit: 3`, and a transient API failure during install
 * should be retried rather than surfaced as `POST_INSTALL_ERROR` to whoever
 * clicked Install. The cost is that the install response returns before the
 * record exists; that costs nothing here, because `scoreLead` treats a missing
 * config as "use the built-in defaults" and reports it as a degradation, which
 * is the same configuration the seed would have written.
 *
 * `shouldRunOnVersionUpgrade: true` is what makes the `previousVersion` branch
 * reachable at all — without it the hook only ever runs on fresh installs and
 * the merge path is dead code.
 *
 * ## Idempotency
 *
 * Creation happens only when the workspace has zero config records; every other
 * path either patches missing keys or does nothing. Re-running creates nothing
 * new. See `runPostInstall` for the duplicate-tolerance argument.
 */
/**
 * ## Ordering, and why nothing here is wrapped in a try
 *
 * Three steps, in this order, and the order is load-bearing:
 *
 *   1. `runPostInstall` seeds or merges the config record. Deliberately **not**
 *      caught: its thrown error is what buys the three platform retries. Wrap it
 *      and a transient API blip becomes a workspace permanently running on
 *      engine defaults.
 *   2. `requestInstallBackfill` must come *after* the seed, or the first cron
 *      tick scores a chunk against defaults instead of the customer's config.
 *   3. Licence validation runs last and is best-effort. Config seeding is the
 *      critical path and must not wait on a network call to Numaya.
 *
 * Steps 2 and 3 never throw — every failure they have degrades to something
 * visible (an unstarted backfill, rules-only scoring) rather than failing the
 * install. That is why they need no try/catch and must not be given one.
 */
const handler = async (payload: InstallPayload) => {
  const client = new CoreApiClient();

  const config = await runPostInstall({ client, payload });

  const backfill = await requestInstallBackfill({
    client,
    store: kvBackfillStateStore,
    now: new Date(),
  });

  const environment = readLicenceEnvironment();
  const licence = await runLicenceInstall({
    licensing: createHttpLicensingClient({
      baseUrl: environment.baseUrl,
      environment: environment.environment,
    }),
    store: kvLicenceStore,
    // Fetched at install too, so a licensed workspace is calibrated from its
    // very first scored lead rather than from the first night after install.
    calibration: kvCalibrationStore,
    identity: metadataWorkspaceIdentity,
    client,
    licenceKey: environment.licenceKey,
    environment: environment.environment,
    now: new Date(),
  });

  return {
    ...config,
    backfill,
    licence: { mode: licence.state.mode, reason: licence.state.reason },
  };
};

export default definePostInstallLogicFunction({
  universalIdentifier: POST_INSTALL_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
  name: 'greenlight-post-install',
  description:
    'Seeds the Greenlight configuration record on install and merges newly-shipped configuration keys on upgrade.',
  // The platform default is 300s, sized for bulk data seeding. This hook issues
  // one query and at most two mutations against a single-row object, so 60s is
  // already an order of magnitude of headroom. Failing fast matters more than
  // hanging on: the run is retried three times, and every retry is cheap.
  timeoutSeconds: 60,
  shouldRunOnVersionUpgrade: true,
  shouldRunSynchronously: false,
  handler,
});
