/**
 * How licence state reaches a human — the audit row and the admin notice.
 *
 * ===========================================================================
 * ## Why this is a problem worth solving rather than a log line
 *
 * The whole point of failing open is that a licence problem is *quiet*: the
 * product keeps working, leads keep scoring, nobody's day breaks. That is
 * exactly what makes it dangerous. An expired licence that silently downgrades
 * the product produces a support ticket six weeks later reading "enrichment
 * stopped working at some point, we don't know when" — and by then the audit
 * trail is the only way to answer it.
 *
 * So every validation is recorded, including the boring ones. One row a night
 * is 365 rows a year against an object built for one row per scored lead; the
 * cost is nil and the alternative — only recording changes — means the row you
 * want is the one that was suppressed because "nothing changed".
 *
 * ## Where it surfaces
 *
 * Three places, in descending order of how likely an admin is to see them:
 *
 *  1. **`GreenlightAuditLog`** — the object already has a view and a sidebar
 *     item, is sorted newest-first, and is the place admins are already told to
 *     look when they ask "why did this happen". Licence rows land there next to
 *     scoring decisions, which is right: from the customer's point of view they
 *     are the same story.
 *  2. **App key-value storage** (`LICENCE_STATE_KV_KEY`) — the resolved state,
 *     republished on every run, for the Greenlight main page to render as a
 *     banner. Cheap to read, always current, no query.
 *  3. **Structured logs** — `logGreenlight('licence_resolved', …)`, for support
 *     with server access.
 *
 * ## The event type is `LICENCE`, for every severity
 *
 * These rows used to file under `CONFIG_CHANGED` when healthy and `ERROR` when
 * not, because `GreenlightAuditLog.eventType` had no option of its own. It has
 * one now, and both halves of that compromise are gone rather than one:
 *
 *   - `CONFIG_CHANGED` was never true. Nobody changed any configuration; a
 *     scheduled check ran and reported what the licence server already thought.
 *   - `ERROR` is worse. `eventType` says *what happened*, and what happened is a
 *     licence check — in exactly the way `scoring-run.ts` files a held lead as
 *     `GATED` and leaves the `decision` column to say which kind of hold it was.
 *     Reserving `ERROR` for "Greenlight itself failed" is what keeps a red row
 *     meaning something: an expired licence is a customer's commercial state,
 *     not a fault in this app, and filing it as a fault is how an admin learns
 *     to ignore red.
 *
 * The severity survives the move and is not inferred from the event type: it is
 * carried explicitly in `ruleTrace.severity`, and the row's summary leads with
 * the admin-facing headline. `LICENCE` is yellow in the SELECT, which is the
 * colour for "look at this" without the claim that something broke.
 *
 * Every row's summary still starts with a `LICENCE` prefix, so the text search
 * that isolated these rows before the option existed keeps working.
 *
 * ## Nothing here may contain the licence key
 *
 * `LicenceState` has no field that could hold one — it carries `maskedKey`, and
 * `maskLicenceKey` emits no characters of the secret. This module never sees the
 * raw key, so there is no code path from the key to a row. That is asserted in
 * `__tests__/audit.test.ts` by scanning the serialised row for the sandbox keys.
 * ===========================================================================
 */

import {
  type LicenceEnvironmentName,
  type LicenceSeverity,
  type LicenceState,
} from 'src/licensing/types';

export const LICENSING_CLIENT_VERSION = '0.1.0';

/** Prefix on every licence audit summary, so the rows are greppable today. */
export const LICENCE_AUDIT_PREFIX = 'LICENCE';

/* -------------------------------------------------------------------------- */
/* Admin-facing description                                                    */
/* -------------------------------------------------------------------------- */

export interface LicenceNotice {
  readonly severity: LicenceSeverity;
  /** One line, suitable as a banner title or an audit row summary. */
  readonly headline: string;
  /** One or two sentences telling the admin what to actually do. */
  readonly detail: string;
}

const daysPhrase = (daysRemaining: number | null): string =>
  daysRemaining === null
    ? 'soon'
    : daysRemaining <= 0
      ? 'today'
      : daysRemaining === 1
        ? 'in 1 day'
        : `in ${daysRemaining} days`;

const hoursSince = (cacheAgeMs: number | null): string =>
  cacheAgeMs === null ? 'never' : `${Math.floor(cacheAgeMs / 3_600_000)}h ago`;

/**
 * States published before `environment` existed read back as `undefined`. The
 * fallback keeps a stale row readable rather than rendering "the undefined
 * environment" at the admin; the next nightly run replaces it with the truth.
 */
const environmentLabel = (environment: LicenceEnvironmentName): string =>
  environment === 'sandbox' ? 'sandbox' : 'production';

/** The setting to try, named rather than implied. */
const otherEnvironmentLabel = (environment: LicenceEnvironmentName): string =>
  environment === 'sandbox' ? 'production' : 'sandbox';

/**
 * Turn a resolved state into something an admin can act on.
 *
 * Every `detail` names the next action. A notice that says "your licence is
 * invalid" and stops is a notice that generates a support ticket; one that says
 * which lever to pull does not.
 */
export const describeLicenceForAdmin = (state: LicenceState): LicenceNotice => {
  const expiring =
    state.expiryWarning ||
    (state.daysRemaining !== null && state.daysRemaining <= 7);

  switch (state.reason) {
    case 'licensed':
      return expiring
        ? {
            severity: state.severity,
            headline: `Greenlight licence expires ${daysPhrase(state.daysRemaining)}`,
            detail:
              'Enrichment is running normally. Renew before the expiry date to avoid dropping to rules-only scoring. Deterministic scoring and the gate continue either way.',
          }
        : {
            severity: state.severity,
            headline: 'Greenlight licence active',
            detail: `Enrichment is enabled${state.tier === null ? '' : ` on the ${state.tier} tier`}.`,
          };

    case 'no_licence_key':
      return {
        severity: state.severity,
        headline: 'Greenlight is running in rules-only mode',
        detail:
          'No licence key is configured, so AI and search enrichment are off. Deterministic scoring, the gate and the queue all work without one. Add a key in the app settings to enable enrichment.',
      };

    case 'feature_not_licensed':
      return {
        severity: state.severity,
        headline: 'Enrichment is not included in this licence',
        detail:
          'The licence is valid and in good standing, but does not include the enrichment capability. Rules-only scoring is unaffected. Upgrade the licence to turn enrichment on.',
      };

    // The one notice in this file that names a Greenlight setting as the likely
    // culprit, because it is the one failure the service reports with a message
    // that reads like a customer problem when it is almost always ours. It says
    // which environment was asked, what to change, and — explicitly — that the
    // key is not the thing to go and re-check. See gotcha 4 in `entitlement.ts`.
    case 'licence_not_found_in_environment':
      return {
        severity: state.severity,
        headline: `Licence key was accepted but no licence exists in the ${environmentLabel(state.environment)} environment`,
        detail:
          `This is almost certainly a misconfiguration, not a bad key: the licensing service accepted the key as valid credentials, then found no licence attached to it in the ${environmentLabel(state.environment)} environment. Set LICENCE_ENVIRONMENT to ${otherEnvironmentLabel(state.environment)} in the app settings if this workspace is licensed there, and re-run the licence check. Do not re-enter the key — a wrong or mistyped key is rejected outright and reports "licence was rejected" instead. If the environment is already correct, the licence has been deleted and Numaya AI support can restore it. Scoring, the gate and the queue are unaffected throughout.`,
      };

    case 'expired':
      return {
        severity: state.severity,
        headline: 'Greenlight licence has expired',
        detail:
          'Enrichment is off. Scoring, the gate and the queue continue to work. Renew the licence to restore enrichment.',
      };

    case 'suspended':
      return {
        severity: state.severity,
        headline: 'Greenlight licence is suspended',
        detail:
          'Enrichment is off. This is usually a billing issue and is reversible — contact Numaya AI support. Scoring is unaffected.',
      };

    case 'revoked':
      return {
        severity: state.severity,
        headline: 'Greenlight licence has been revoked',
        detail:
          'Enrichment is off and this cannot be reversed on the existing key. Contact Numaya AI support for a replacement. Scoring is unaffected.',
      };

    case 'quota_exceeded':
      return {
        severity: state.severity,
        headline: 'Greenlight enrichment quota reached',
        detail:
          'Enrichment is paused until the quota period resets. Scoring is unaffected.',
      };

    case 'device_not_activated':
      return {
        severity: state.severity,
        headline: 'This workspace is not activated against the licence',
        detail:
          'Reinstall the app, or contact Numaya AI support, to claim an activation slot. Scoring is unaffected.',
      };

    case 'max_activations_reached':
      return {
        severity: state.severity,
        headline: 'Licence is already in use by another workspace',
        detail:
          'Every activation slot on this licence is taken, so this workspace runs rules-only. Free a slot on the other workspace or add a seat, then reinstall Greenlight here.',
      };

    case 'invalid_licence':
      return {
        severity: state.severity,
        headline: 'Greenlight licence was rejected',
        detail:
          'The licensing service refused this key outright — it does not recognise it in any environment. Check the key in the app settings for a typo or a truncated paste, then contact Numaya AI support. Scoring is unaffected.',
      };

    case 'licence_service_rate_limited':
      return {
        severity: state.severity,
        headline: 'Licence check was rate-limited',
        detail:
          'Numaya returned HTTP 429, so this workspace could not re-check its licence. Enrichment is paused until the next nightly check succeeds; scoring, the gate and the queue are unaffected. Nothing needs doing unless this persists for several days.',
      };

    case 'licence_response_malformed':
      return {
        severity: state.severity,
        headline: 'Licence service returned an unreadable response',
        detail:
          'The licensing service answered, but not in a shape this version understands — usually a proxy or an upgrade in progress. Enrichment is paused; scoring is unaffected. Report it to Numaya AI support if it persists.',
      };

    case 'licence_service_unreachable':
      return {
        severity: state.severity,
        headline: 'Cannot reach the Numaya AI licensing service',
        detail: `Enrichment is paused while the cached entitlement ages out (last successful check ${hoursSince(state.cacheAgeMs)}). Check outbound network access to the licensing service. Scoring is unaffected.`,
      };

    case 'licence_service_unreachable_grace_expired':
      return {
        severity: state.severity,
        headline:
          state.cacheAgeMs === null
            ? 'Greenlight has never successfully checked its licence'
            : 'Licence has not been verified for over 72 hours',
        detail: `Enrichment is off until a licence check succeeds (last successful check ${hoursSince(state.cacheAgeMs)}). Confirm LICENCE_API_BASE_URL and outbound network access. Scoring, the gate and the queue are unaffected and will keep running indefinitely.`,
      };
  }
};

/* -------------------------------------------------------------------------- */
/* Audit row                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The structured payload written to `ruleTrace`. This is the row that answers
 * "what did Numaya say, and what did we do about it, at 03:17 on the 14th".
 *
 * Carries `valid` and `hasFeature` as separate fields on purpose — collapsing
 * them into the resulting mode would erase precisely the distinction that the
 * independence gotcha makes load-bearing.
 */
export interface LicenceAuditDetail {
  readonly checkedAt: string;
  readonly maskedKey: string;
  /**
   * Recorded on every row, healthy ones included. A row that says
   * `reason: license_not_found` without saying which environment was asked is a
   * support ticket; with it, it is a two-minute fix.
   */
  readonly environment: string;
  readonly valid: boolean | null;
  readonly hasFeature: boolean | null;
  readonly reason: string;
  readonly source: 'live' | 'cache' | 'grace' | 'none';
  readonly cached: boolean;
  readonly cacheAgeHours: number | null;
  readonly mode: string;
  readonly severity: LicenceSeverity;
  readonly failureKind: string | null;
  readonly tier: string | null;
  readonly daysRemaining: number | null;
  readonly expiryWarning: boolean;
  readonly expiryAt: string | null;
}

export const buildLicenceAuditDetail = (
  state: LicenceState,
): LicenceAuditDetail => ({
  checkedAt: state.checkedAt,
  maskedKey: state.maskedKey,
  environment: environmentLabel(state.environment),
  valid: state.observedValid,
  hasFeature: state.observedHasFeature,
  reason: state.reason,
  source: state.source,
  // Spelled out as a boolean as well as a source, because "cached vs live" is
  // the question support asks and `source: 'grace'` does not obviously answer
  // it.
  cached: state.source !== 'live',
  cacheAgeHours:
    state.cacheAgeMs === null
      ? null
      : Math.round((state.cacheAgeMs / 3_600_000) * 10) / 10,
  mode: state.mode,
  severity: state.severity,
  failureKind: state.failureKind,
  tier: state.tier,
  daysRemaining: state.daysRemaining,
  expiryWarning: state.expiryWarning,
  expiryAt: state.expiryAt,
});

/**
 * The `data` argument for `createGreenlightAuditLog`.
 *
 * Shaped to match the rows `install-run.ts` writes: the lead-pointer fields are
 * empty strings rather than omitted, because the object's `SELECT` fields have
 * literal defaults and a partially-populated row reads worse in the view than a
 * deliberately blank one. `band` and `decision` are `UNSCORED` for the same
 * reason — this row describes no lead, and `UNSCORED` is the vocabulary's word
 * for "not applicable".
 */
export const buildLicenceAuditRow = (
  state: LicenceState,
  /**
   * The calibration outcome of the same run, if there was one.
   *
   * Passed in as a loose record rather than typed against
   * `src/calibration/types.ts` for the same reason `LicenceValidationResponse`
   * types `customerMetadata` as `unknown`: the licensing core must not acquire
   * a dependency on what calibration is. It reads three fields for display and
   * copies the rest verbatim into the trace.
   *
   * It is on the row rather than only in the panel because an audit row outlives
   * the panel's "now". "Which vocabulary was this workspace scoring on last
   * March" is a question asked months later, and the only place that can answer
   * it is the append-only trail.
   */
  calibration?: {
    readonly status?: unknown;
    readonly reason?: unknown;
    readonly calibrationVersion?: unknown;
    readonly refreshedAt?: unknown;
  } | null,
): Record<string, unknown> => {
  const notice = describeLicenceForAdmin(state);

  // "calibration v1" or "shipped defaults" — the whole answer to "am I running
  // the calibrated lists?", short enough to sit in a row name in a list view.
  const calibrationLabel =
    calibration === null || calibration === undefined
      ? null
      : calibration.status === 'calibrated' &&
          typeof calibration.calibrationVersion === 'number'
        ? `calibration v${calibration.calibrationVersion}`
        : 'shipped defaults';

  return {
    name:
      calibrationLabel === null
        ? `${LICENCE_AUDIT_PREFIX} · ${notice.headline} · ${state.mode}`
        : `${LICENCE_AUDIT_PREFIX} · ${notice.headline} · ${state.mode} · ${calibrationLabel}`,
    // One value for every severity. See the module comment: the severity lives
    // in `ruleTrace.severity` and in the headline above, not in a borrowed
    // event type.
    eventType: 'LICENCE',
    occurredAt: state.checkedAt,
    leadObjectNameSingular: '',
    leadDisplayName: '',
    actorType: 'SYSTEM',
    actorDisplayName: `Greenlight licensing ${LICENSING_CLIENT_VERSION}`,
    ruleTrace: {
      ...buildLicenceAuditDetail(state),
      adminDetail: notice.detail,
      ...(calibration === null || calibration === undefined
        ? {}
        : { calibration }),
    },
    score: null,
    band: 'UNSCORED',
    decision: 'UNSCORED',
    overrideReason: '',
    traceId: '',
  };
};
