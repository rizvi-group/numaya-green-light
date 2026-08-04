/**
 * The pure licensing core.
 *
 * Nothing exported from here does I/O, reads a clock, imports the Twenty SDK, or
 * touches a raw licence key — the same discipline `src/scoring/` and `src/gate/`
 * hold, and for the same reason: every rule in here is a decision worth testing
 * at its boundaries, and boundaries are only testable when the inputs are
 * arguments.
 *
 * The impure half lives in `src/logic-functions/licence-*.ts`:
 *
 * | Concern                | Port                | Adapter                            |
 * |------------------------|---------------------|------------------------------------|
 * | Talking to Numaya      | `LicensingPort`     | `licence-http-client.ts`           |
 * | Cache + activation + published state | `LicenceStorePort` | `licence-cache-store.ts` |
 * | Workspace identity     | `WorkspaceIdentityPort` | `licence-workspace-identity.ts` |
 *
 * `licence-run.ts` is the composition root: it reads the environment, masks the
 * key, calls the ports, hands the results to `resolveLicenceState`, and writes
 * the outcome back out.
 */

export {
  buildLicenceAuditDetail,
  buildLicenceAuditRow,
  describeLicenceForAdmin,
  LICENCE_AUDIT_PREFIX,
  LICENSING_CLIENT_VERSION,
  type LicenceAuditDetail,
  type LicenceNotice,
} from 'src/licensing/audit';

export {
  cacheAgeMs,
  classifyCache,
  classifyCacheAge,
  LICENCE_CACHE_TTL_MS,
  LICENCE_OFFLINE_GRACE_LIMIT_MS,
  type CacheFreshness,
} from 'src/licensing/cache';

export {
  entitlementReason,
  isEnrichmentEntitled,
  normaliseInvalidReason,
  resolveEntitlement,
} from 'src/licensing/entitlement';

export {
  describeEnrichmentGate,
  enrichmentDisabledReason,
  isDeterministicScoringLicensed,
  isEnrichmentEnabled,
  type EnrichmentGate,
} from 'src/licensing/feature-gate';

export {
  maskLicenceKey,
  MISSING_LICENCE_MASK,
  redactLicenceKey,
} from 'src/licensing/mask';

export {
  parseValidationResponse,
  type ParsedValidation,
} from 'src/licensing/parse';

export {
  buildCacheEntry,
  EXPIRY_WARNING_DAYS,
  resolveLicenceState,
  type ResolvedLicence,
  type ResolveLicenceStateInput,
} from 'src/licensing/state';

export type {
  CachedLicenceValidation,
  LicenceActivateOutcome,
  LicenceActivationState,
  LicenceCallFailure,
  LicenceEnvironmentName,
  LicenceKeyPresence,
  LicenceMode,
  LicenceReason,
  LicenceSeverity,
  LicenceSource,
  LicenceState,
  LicenceStorePort,
  LicenceValidateOutcome,
  LicenceValidationResponse,
  LicensingPort,
} from 'src/licensing/types';
