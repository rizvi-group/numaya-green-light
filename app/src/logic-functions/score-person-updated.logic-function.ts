import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';

import { SCORE_PERSON_UPDATED_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER } from 'src/constants/logic-function-identifiers';
import { createLicenceKeySeal } from 'src/logic-functions/licence-cache-seal';
import { kvCalibrationReader } from 'src/logic-functions/licence-cache-store';
import { readLicenceEnvironment } from 'src/logic-functions/licence-run';
import { kvReleaseMarkerStore } from 'src/logic-functions/release-marker-store';
import {
  runPersonScoring,
  SCORING_TRIGGER_PERSON_FIELDS,
} from 'src/logic-functions/scoring-run';

/**
 * Re-score a Person when something that can move the score changes.
 *
 * ## The retrigger guard
 *
 * This is the registration that could loop. Writing `greenlightScore` back emits
 * `person.updated`, which is this very trigger.
 *
 * `updatedFields` is the fix, and it is the platform that enforces it: per
 * https://docs.twenty.com/developers/extend/apps/logic/logic-functions.md,
 * "when the event operation is `updated`, specific fields to listen to can be
 * specified in the `updatedFields` array. If left undefined or empty, any update
 * will trigger the function." The list below is an allow-list of *scoring
 * inputs*; `greenlightScore`, `greenlightDecision` and `greenlightTrace` are
 * absent from it, so an update that only touches those three is never dispatched
 * here. Leaving the array off — which is the tempting default — is precisely the
 * bug: it would make every write-back a new event.
 *
 * `runPersonScoring` carries two further guards behind this one (an
 * authored-write check on `event.properties.updatedFields`, and an
 * outcome-fingerprint comparison that makes a redundant run write nothing). See
 * the module comment in `scoring-run.ts` for why three layers rather than one.
 *
 * ## The override contract
 *
 * This is also the registration that can undo a human release: a rep releases a
 * gated lead, then edits `jobTitle`, and the re-score re-gates it. The marker
 * store below is how the run sees the release — see `pinReleasedDecision` in
 * `scoring-run.ts`.
 */
const handler = async (event: unknown) =>
  runPersonScoring({
    client: new CoreApiClient(),
    event,
    now: new Date(),
    markers: kvReleaseMarkerStore,
    calibration: kvCalibrationReader,
    calibrationSeal: createLicenceKeySeal(readLicenceEnvironment().licenceKey),
  });

export default defineLogicFunction({
  universalIdentifier: SCORE_PERSON_UPDATED_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
  name: 'greenlight-score-person-updated',
  description:
    'Re-scores a Person when a scoring input changes. Never fires on Greenlight’s own write-back.',
  // Same budget and same reasoning as the create registration.
  timeoutSeconds: 10,
  handler,
  databaseEventTriggerSettings: {
    eventName: 'person.updated',
    updatedFields: [...SCORING_TRIGGER_PERSON_FIELDS],
  },
});
