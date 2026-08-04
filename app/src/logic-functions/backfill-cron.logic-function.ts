import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';
import type { CronPayload } from 'twenty-sdk/logic-function';

import { BACKFILL_CRON_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER } from 'src/constants/backfill-identifiers';
import { runBackfillChunk } from 'src/logic-functions/backfill-run';
import { kvBackfillStateStore } from 'src/logic-functions/backfill-state-store';
import { createLicenceKeySeal } from 'src/logic-functions/licence-cache-seal';
import { kvCalibrationReader } from 'src/logic-functions/licence-cache-store';
import { readLicenceEnvironment } from 'src/logic-functions/licence-run';
import { kvReleaseMarkerStore } from 'src/logic-functions/release-marker-store';

/**
 * Drain one chunk of the backfill queue, once a minute.
 *
 * A shell, like every other `define*` file here: the decision about what to read
 * is in `src/backfill/backfill-plan.ts`, the position is in
 * `backfill-state.ts`, and the I/O is in `backfill-run.ts`. This file exists to
 * hand over a real client, a real clock and the two real key-value stores.
 *
 * ## The schedule
 *
 * `* * * * *` — every minute. The rate limit is per minute, so the tick and the
 * budget are the same unit; anything coarser would mean either idling most of the
 * allowance or bursting past it inside one invocation. `BACKFILL_CHUNK_SIZE`
 * carries the arithmetic.
 *
 * A tick on a workspace with no backfill running is one key-value read that
 * returns `null`, and then nothing. That is the standing cost of the design, and
 * it buys the property the whole feature turns on: liveness comes from the
 * platform's scheduler rather than from the job itself, so a run that crashed
 * mid-chunk is picked up by something that was going to ask anyway.
 *
 * ## The marker store, and why it is here
 *
 * `kvReleaseMarkerStore` is the same instance the two event registrations pass.
 * That is not tidiness — it is the guarantee that bulk scoring cannot re-gate a
 * lead a human deliberately released. `runPersonScoring` consults it through
 * `pinReleasedDecision` on every run, event-driven or not, and there is no bulk
 * code path that writes a decision without going through it. Passing a different
 * store, or none, is the one change to this file that would silently undo
 * hundreds of human overrides at once.
 *
 * ## Errors
 *
 * `runBackfillChunk` never throws, so neither does this. A cron function that
 * threw would be retried by the platform against a run that is already holding —
 * or has just released — a lease, which is exactly the overlap the lease exists
 * to avoid. Failures are recorded in the run's own state and shown in the panel.
 */
const handler = async (_payload: CronPayload) =>
  runBackfillChunk({
    client: new CoreApiClient(),
    store: kvBackfillStateStore,
    markers: kvReleaseMarkerStore,
    calibration: kvCalibrationReader,
    calibrationSeal: createLicenceKeySeal(readLicenceEnvironment().licenceKey),
    now: new Date(),
  });

export default defineLogicFunction({
  universalIdentifier: BACKFILL_CRON_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
  name: 'greenlight-backfill-cron',
  description:
    'Scores existing Person records in bounded, resumable chunks so leads that predate the app are not left silently unscored.',
  // Under the sixty seconds between ticks, so a slow chunk cannot stack up
  // behind the next one. `BACKFILL_TICK_BUDGET_MS` (40s) stops the tick starting
  // new records well before this fires, leaving fifteen seconds to finish the
  // record in flight and commit the position. Being killed here is survivable —
  // the cursor simply does not move — but it wastes a chunk, so the budget is
  // sized to make it rare rather than to make it harmless.
  timeoutSeconds: 55,
  handler,
  cronTriggerSettings: {
    pattern: '* * * * *',
  },
});
