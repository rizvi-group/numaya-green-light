/**
 * The licensing composition root: reads the environment, drives the ports, hands
 * everything to the pure core, writes the result back out.
 *
 * Kept out of the `define*` file for the same reason `scoring-run.ts` is — so
 * the whole run can be exercised against fakes, with an injected `now` and no
 * network. There is no `new Date()` and no `new CoreApiClient()` below.
 *
 * ===========================================================================
 * ## Two entry points
 *
 * `runLicenceInstall`  — called once from the post-install hook. Activates, then
 *                        validates.
 * `runLicenceRevalidation` — called nightly by the cron function. Validates only.
 *
 * `activate` is **not** called nightly. It is idempotent on the fingerprint and
 * would be harmless, but it is a slot-claim, not a health check, and calling it
 * every night would turn one write per install into one write per workspace per
 * day against a service that gains nothing from them.
 *
 * ## What is sent to Numaya, and what is not
 *
 * The licence key, the workspace id (as `deviceFingerprint`) and the workspace
 * display name (as `deviceName`). That is the entire payload, and the data-egress
 * table in `ARCHITECTURE.md` says so. No lead, contact, company or score data
 * leaves the workspace on this path — there is no field in the request body that
 * could carry any.
 *
 * ## Why an unresolvable workspace is not fatal
 *
 * `deviceFingerprint` is optional on `validate`. If the workspace identity
 * cannot be read — the metadata API is unavailable, or a future SDK moves
 * `currentWorkspace` — the run still validates, just without a fingerprint, and
 * skips activation because activation *requires* one. That is a strictly better
 * outcome than failing the check: the customer keeps their entitlement, and the
 * only thing lost is the readable device name in Numaya's admin view.
 * ===========================================================================
 */

import {
  DEFAULT_LICENCE_API_BASE_URL,
  DEFAULT_LICENCE_ENVIRONMENT,
  ENRICHMENT_FEATURE_NAME,
} from 'src/constants/licence-identifiers';
import {
  buildLicenceAuditDetail,
  buildLicenceAuditRow,
  describeLicenceForAdmin,
  maskLicenceKey,
  redactLicenceKey,
  resolveLicenceState,
  type LicenceNotice,
  type LicenceEnvironmentName,
  type LicenceState,
  type LicenceStorePort,
  type LicensingPort,
  type LicenceValidateOutcome,
} from 'src/licensing';
import {
  describeCalibration,
  refreshCalibration,
  type CalibrationStorePort,
  type RefreshCalibrationOutcome,
} from 'src/calibration';
import {
  describeError,
  logGreenlight,
  type GreenlightApiClient,
} from 'src/logic-functions/greenlight-api';
import { createLicenceKeySeal } from 'src/logic-functions/licence-cache-seal';

/* -------------------------------------------------------------------------- */
/* Ports                                                                       */
/* -------------------------------------------------------------------------- */

export interface WorkspaceIdentity {
  readonly workspaceId: string;
  readonly workspaceName: string | null;
}

/**
 * Resolving "which workspace am I" is I/O, so it is a port like everything else.
 * The real adapter is `licence-workspace-identity.ts`; `null` means "could not
 * tell", which every caller below treats as a degradation rather than a failure.
 */
export interface WorkspaceIdentityPort {
  read(): Promise<WorkspaceIdentity | null>;
}

/* -------------------------------------------------------------------------- */
/* Environment                                                                 */
/* -------------------------------------------------------------------------- */

export interface LicenceEnvironment {
  /** `null` when unset or blank — the supported, unlicensed configuration. */
  readonly licenceKey: string | null;
  readonly baseUrl: string;
  readonly environment: LicenceEnvironmentName;
}

/**
 * Application variables reach a logic function as environment variables.
 *
 * The `?? DEFAULT_LICENCE_API_BASE_URL` is belt-and-braces: the variable ships
 * with that value declared in `application-config.ts`, so it should always be
 * present. It would be absent on a workspace that installed a build predating
 * the variable and has not re-synced, and defaulting beats an empty base URL
 * only in that the failure is then identical to a normal outage.
 *
 * `LICENCE_ENVIRONMENT` is read the strict way round: **only** the exact string
 * `sandbox` selects sandbox, and everything else — unset, blank, misspelled,
 * `SANDBOX_`, a value from a future release — is production. Defaulting an
 * unrecognised value to sandbox would let a typo route a paying customer at the
 * test estate, where their licence does not exist and where this whole exercise
 * started. Casing and surrounding whitespace are forgiven because they are
 * transcription noise, not intent.
 */
export const readLicenceEnvironment = (
  env: Record<string, string | undefined> = process.env,
): LicenceEnvironment => {
  const rawKey = env['LICENCE_KEY'];
  const trimmed = typeof rawKey === 'string' ? rawKey.trim() : '';
  const rawBase = env['LICENCE_API_BASE_URL'];
  const rawEnvironment = env['LICENCE_ENVIRONMENT'];

  return {
    licenceKey: trimmed.length === 0 ? null : trimmed,
    baseUrl:
      typeof rawBase === 'string' && rawBase.trim().length > 0
        ? rawBase.trim()
        : DEFAULT_LICENCE_API_BASE_URL,
    environment:
      typeof rawEnvironment === 'string' &&
      rawEnvironment.trim().toLowerCase() === 'sandbox'
        ? 'sandbox'
        : DEFAULT_LICENCE_ENVIRONMENT,
  };
};

/* -------------------------------------------------------------------------- */
/* Runs                                                                        */
/* -------------------------------------------------------------------------- */

export interface LicenceRunDeps {
  readonly licensing: LicensingPort;
  readonly store: LicenceStorePort;
  /**
   * Where the verified calibration payload is cached and its state published.
   *
   * Optional, and its absence is a supported configuration rather than a
   * mistake: a run without it resolves the entitlement exactly as it always
   * did and simply does no calibration work. That is what makes this an
   * additive change to a path whose failure is silent and nightly.
   */
  readonly calibration?: CalibrationStorePort | null;
  readonly identity: WorkspaceIdentityPort;
  /** Optional: without it the run still resolves state, it just writes no row. */
  readonly client?: GreenlightApiClient | null;
  readonly licenceKey: string | null;
  /**
   * Which environment the `licensing` port was pointed at. Passed separately
   * rather than read back off the port because the port is an interface with no
   * way to ask, and because the resolved state has to record what we *asked
   * for* even when the call never left the building.
   */
  readonly environment: LicenceEnvironmentName;
  readonly now: Date;
}

export interface LicenceRunOutcome {
  readonly state: LicenceState;
  readonly notice: LicenceNotice;
  /** What the activation attempt did, for the install path's return value. */
  readonly activation: 'claimed' | 'limit_reached' | 'skipped' | 'failed' | 'not_attempted';
  /** Null when no calibration store was wired. */
  readonly calibration: RefreshCalibrationOutcome | null;
}

/**
 * Best-effort provenance row. Never fails the run — a licence check that
 * succeeded but could not be written to the audit log is still a licence check
 * that succeeded, and the resolved state has already been published to key-value
 * storage where the UI reads it.
 */
const writeLicenceAuditRow = async (
  client: GreenlightApiClient | null | undefined,
  state: LicenceState,
  calibration: RefreshCalibrationOutcome | null,
): Promise<boolean> => {
  if (client === null || client === undefined) {
    return false;
  }

  try {
    await client.mutation({
      createGreenlightAuditLog: {
        __args: {
          data: buildLicenceAuditRow(state, calibration?.state ?? null),
        },
        id: true,
      },
    });

    return true;
  } catch (error) {
    logGreenlight('licence_audit_write_failed', { error: describeError(error) });

    return false;
  }
};

/**
 * Resolve, persist, publish, audit, log. Shared by both entry points so the
 * install path and the nightly path cannot drift.
 */
const finishRun = async (
  deps: LicenceRunDeps,
  outcome: LicenceValidateOutcome | null,
  activation: LicenceRunOutcome['activation'],
): Promise<LicenceRunOutcome> => {
  const presence = {
    hasKey: deps.licenceKey !== null,
    maskedKey: maskLicenceKey(deps.licenceKey),
  };

  const [cached, activationState] = await Promise.all([
    deps.store.readCache(),
    deps.store.readActivation(),
  ]);

  const { state, cacheWrite } = resolveLicenceState({
    presence,
    outcome,
    cached,
    activation: activationState,
    environment: deps.environment,
    now: deps.now,
  });

  if (cacheWrite !== null) {
    await deps.store.writeCache(cacheWrite);
  }

  await deps.store.publishState(state);

  // Calibration runs strictly after the entitlement has been resolved and
  // published, and never before. See `src/calibration/refresh.ts`, "Ordering":
  // nothing about a word list may be able to delay, fail or precede the decision
  // that gates the paid feature and writes the admin notice.
  const calibration =
    deps.calibration === null || deps.calibration === undefined
      ? null
      : await refreshCalibration({
          store: deps.calibration,
          // Built here because this is one of the two modules that legitimately
          // holds the raw key. The seal itself never receives it — see
          // `licence-cache-seal.ts`.
          seal: createLicenceKeySeal(deps.licenceKey),
          metadata:
            outcome !== null && outcome.kind === 'validated'
              ? outcome.response.customerMetadata
              : undefined,
          live: outcome !== null && outcome.kind === 'validated',
          // The same entitlement that gates enrichment. Calibration is the other
          // half of what a licence buys, so it is bought on the same terms.
          entitled: state.mode === 'full',
          now: deps.now,
        });

  // Contains the mask, never the key — `buildLicenceAuditDetail` reads only
  // fields of `LicenceState`, and `LicenceState` has no field that could hold
  // a key. `describeCalibration` reads only counts and version numbers, never
  // payload content.
  logGreenlight('licence_resolved', {
    ...buildLicenceAuditDetail(state),
    activationAttempt: activation,
    ...(calibration === null ? {} : describeCalibration(calibration)),
  });

  await writeLicenceAuditRow(deps.client, state, calibration);

  return {
    state,
    notice: describeLicenceForAdmin(state),
    activation,
    calibration,
  };
};

const validateOnce = async (
  deps: LicenceRunDeps,
  workspace: WorkspaceIdentity | null,
): Promise<LicenceValidateOutcome | null> => {
  if (deps.licenceKey === null) {
    return null;
  }

  try {
    return await deps.licensing.validate({
      key: deps.licenceKey,
      deviceFingerprint: workspace?.workspaceId ?? null,
      feature: ENRICHMENT_FEATURE_NAME,
    });
  } catch (error) {
    // `LicensingPort` is documented as never throwing and the shipped adapter
    // honours it. This catch is here because "documented" is not "enforced by
    // the type system": a future adapter, or a test double, can throw, and the
    // consequence would be a cron run that dies before publishing state.
    // Downgrading it to the outcome the ladder already handles costs three
    // lines and removes the failure mode entirely.
    return {
      kind: 'transport_failure',
      detail: redactLicenceKey(describeError(error), deps.licenceKey),
    };
  }
};

const readWorkspace = async (
  identity: WorkspaceIdentityPort,
): Promise<WorkspaceIdentity | null> => {
  try {
    return await identity.read();
  } catch (error) {
    logGreenlight('licence_workspace_identity_failed', {
      error: describeError(error),
    });

    return null;
  }
};

/**
 * Install: claim the activation slot, then validate.
 *
 * ## Why it validates even after a `409`
 *
 * The integration note's sketch returns early on `409`. This does not, and the
 * difference matters: because `validate` does not consult activation slots for
 * `Trial` / `Subscription` licences (gotcha 2), a refused workspace still gets
 * `valid: true, hasFeature: true`. Returning early would hide that, and — worse
 * — the *nightly* run has no activation step at all, so it would quietly switch
 * enrichment on the following morning.
 *
 * Instead the `409` is persisted, and `resolveLicenceState` applies it as an
 * override on every subsequent resolution. Validating anyway is then free
 * information: the admin notice can say how many days are left on the licence
 * that another workspace is holding, which is exactly what they need to decide
 * whether to free a slot or buy a seat.
 *
 * ## Idempotency
 *
 * `activate` is idempotent on `deviceFingerprint` — a repeat call with the same
 * workspace id returns the existing activation and consumes no second slot.
 * Reinstalling is therefore safe, and a successful activate clears a previously
 * stored `limit_reached`, which is how an admin who freed a slot recovers.
 */
export const runLicenceInstall = async (
  deps: LicenceRunDeps,
): Promise<LicenceRunOutcome> => {
  if (deps.licenceKey === null) {
    logGreenlight('licence_install_skipped', { reason: 'no_licence_key' });

    return finishRun(deps, null, 'not_attempted');
  }

  const workspace = await readWorkspace(deps.identity);
  let activation: LicenceRunOutcome['activation'] = 'skipped';

  if (workspace === null) {
    logGreenlight('licence_activate_skipped', {
      reason: 'workspace_identity_unavailable',
    });
  } else {
    const result = await deps.licensing.activate({
      key: deps.licenceKey,
      deviceFingerprint: workspace.workspaceId,
      deviceName: workspace.workspaceName,
    });

    if (result.kind === 'activated') {
      activation = 'claimed';
      await deps.store.writeActivation({
        status: 'claimed',
        at: deps.now.toISOString(),
      });
    } else if (result.kind === 'activation_limit_reached') {
      activation = 'limit_reached';
      await deps.store.writeActivation({
        status: 'limit_reached',
        at: deps.now.toISOString(),
      });
    } else {
      // A transport failure tells us nothing about the slot, so the stored
      // activation state is left exactly as it was. Overwriting a known
      // `claimed` with `unknown` because the network blipped would be losing
      // information, not recording it.
      activation = 'failed';
      logGreenlight('licence_activate_failed', { failureKind: result.kind });
    }
  }

  const outcome = await validateOnce(deps, workspace);

  return finishRun(deps, outcome, activation);
};

/**
 * Nightly: validate, refresh the cache, republish the state, write the row.
 *
 * Never throws. The cron handler has nowhere to report a thrown error to, and a
 * run that dies before `finishRun` is a run that leaves yesterday's state
 * published — which is fine for a night and wrong for a month.
 */
export const runLicenceRevalidation = async (
  deps: LicenceRunDeps,
): Promise<LicenceRunOutcome> => {
  const workspace = deps.licenceKey === null ? null : await readWorkspace(deps.identity);
  const outcome = await validateOnce(deps, workspace);

  return finishRun(deps, outcome, 'not_attempted');
};
