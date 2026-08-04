/**
 * Licence-delivered scoring calibration.
 *
 * The barrel exists so the rest of the app imports one module path rather than
 * six, and so the boundary is visible in a dependency graph: everything below
 * is pure except `verify.ts`, which touches `crypto.subtle` and nothing else.
 * No file in this directory imports the Twenty SDK, opens a socket, or reads a
 * clock — `now` is passed in, exactly as it is in `src/scoring/` and
 * `src/licensing/`.
 *
 * The dependency direction is one-way and load-bearing: `src/calibration/` may
 * import from `src/scoring/`, and `src/scoring/` may never import from here.
 * Calibration reaches the engine as *data*, through `resolveConfig`'s baseline
 * argument, which is what keeps the rules pure and keeps an unlicensed install
 * byte-for-byte identical to the build that predates this feature.
 */

export {
  canonicalBytes,
  canonicalise,
} from 'src/calibration/canonical';

export {
  CALIBRATION_PUBLIC_KEYS,
  CALIBRATION_SIGNATURE_ALGORITHM,
  CALIBRATION_SIGNING_KEY_ID,
} from 'src/calibration/keys';

export {
  CALIBRATION_METADATA_KEY,
  readCalibrationEnvelope,
  type EnvelopeRead,
} from 'src/calibration/parse';

export { verifyCalibrationEnvelope } from 'src/calibration/verify';

export {
  describeCalibration,
  refreshCalibration,
  sealedCalibrationBody,
  type RefreshCalibrationInput,
  type RefreshCalibrationOutcome,
} from 'src/calibration/refresh';

export { NO_SEAL, type CalibrationSealPort } from 'src/calibration/seal';

export {
  expandIndustries,
  isUntouchedShippedList,
  toScoringBaseline,
  type ScoringBaseline,
} from 'src/calibration/apply';

export {
  CALIBRATION_MAX_AGE_MS,
  calibratedState,
  countCalibration,
  resolveCalibration,
  shippedDefaultsState,
  type ResolveCalibrationInput,
  type ResolvedCalibration,
} from 'src/calibration/state';

export {
  CALIBRATION_SCHEMA_VERSION,
  type CachedCalibration,
  type Calibration,
  type CalibrationCounts,
  type CalibrationReaderPort,
  type CalibrationReason,
  type CalibrationStorePort,
  type CalibrationSource,
  type CalibrationState,
  type CalibrationVerification,
  type SealedCalibrationBody,
  type SignedCalibrationEnvelope,
} from 'src/calibration/types';
