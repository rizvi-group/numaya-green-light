import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';

import { SCORE_PERSON_CREATED_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER } from 'src/constants/logic-function-identifiers';
import { createLicenceKeySeal } from 'src/logic-functions/licence-cache-seal';
import { kvCalibrationReader } from 'src/logic-functions/licence-cache-store';
import { readLicenceEnvironment } from 'src/logic-functions/licence-run';
import { kvReleaseMarkerStore } from 'src/logic-functions/release-marker-store';
import { runPersonScoring } from 'src/logic-functions/scoring-run';

/**
 * Score a Person the moment it is created.
 *
 * ## Why two registrations instead of one
 *
 * `DatabaseEventTriggerSettings.eventName` is a single string, and the
 * `updatedFields` allow-list only has meaning for update events. `person.*`
 * would collapse the two into one registration, but it would also pull in
 * `person.deleted`, `person.destroyed`, `person.restored` and `person.upserted`,
 * whose payloads carry `before` rather than `after` — and, worse, it would leave
 * no place to hang the `updatedFields` filter that stops our own write-back
 * retriggering us. Two narrow registrations are longer to read and impossible to
 * get subtly wrong.
 *
 * Creates need no `updatedFields` filter: a create is never something Greenlight
 * did, because Greenlight only ever updates.
 *
 * The marker store is passed here too, even though a brand-new record cannot
 * have been released yet: a re-created record can reuse an id, and the run has
 * one code path. A store that is never consulted costs nothing.
 */
const handler = async (event: unknown) =>
  runPersonScoring({
    client: new CoreApiClient(),
    event,
    now: new Date(),
    markers: kvReleaseMarkerStore,
    // Read-only. Absent, expired or unlicensed calibration all resolve to the
    // shipped defaults, so this cannot change whether a lead gets scored — only
    // which vocabulary the rules match against.
    calibration: kvCalibrationReader,
    calibrationSeal: createLicenceKeySeal(readLicenceEnvironment().licenceKey),
  });

export default defineLogicFunction({
  universalIdentifier: SCORE_PERSON_CREATED_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
  name: 'greenlight-score-person-created',
  description:
    'Scores a new Person against the Greenlight rules, writes score/decision/trace back to the record and appends an audit row.',
  // Three API round trips (config read, audit create, person update) plus a
  // sub-millisecond pure-CPU scoring pass. Ten seconds is roughly 3s of headroom
  // per call — generous for a healthy instance, and short enough that a hung API
  // call fails fast instead of pinning a worker for minutes. It is deliberately
  // not the 300s install-hook default: a scoring run that takes five minutes is
  // broken, not slow, and the next event will re-score the lead anyway.
  timeoutSeconds: 10,
  handler,
  databaseEventTriggerSettings: {
    eventName: 'person.created',
  },
});
