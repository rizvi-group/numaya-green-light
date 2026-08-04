/**
 * Tolerant parsing of the licensing service's `validate` response.
 *
 * The response is JSON from a service we do not deploy in lockstep with this
 * app. It will change shape at some point — a field renamed, a number arriving
 * as a string, a proxy returning an HTML error page with a `200`. None of those
 * may throw inside a customer's workspace, because the caller is a nightly cron
 * job whose failure is silent and whose consequence is a licence that stops
 * being re-checked.
 *
 * So parsing is total and returns a discriminated result: either a fully
 * populated response with every field defaulted, or `malformed`. There is no
 * middle state and no `undefined` anywhere downstream.
 *
 * ## What counts as malformed
 *
 * Only one thing: `valid` is not a boolean. That field is the entire contract —
 * `LICENSING_INTEGRATION.md` is explicit that a failed validation is a normal
 * `200` and that the caller must branch on the boolean. A body without a usable
 * `valid` is not a licence answer, whatever else it contains.
 *
 * Everything else degrades. A missing `hasFeature` is `false` (fail closed on
 * the *paid feature*, which is the safe direction — the customer keeps rules
 * scoring either way). A missing `daysRemaining` is `null`, not `0`, because
 * `0` would read as "expires today" in the admin notice.
 *
 * ## The service's own spec over-promises, and this is why that costs nothing
 *
 * `ValidateLicenseResponse` in the published OpenAPI document marks nineteen
 * fields `required`, including `reason`, `gracePeriodDaysRemaining` and
 * `maintenanceExpiryAt`. A healthy live response on 2026-08-04 carried none of
 * those three: `reason` is simply absent when the licence is valid, and the two
 * grace/maintenance fields were absent from every response observed, valid and
 * invalid alike.
 *
 * A parser written to the spec — destructuring required fields, or validating
 * their presence — would therefore have rejected every real response the
 * service sends. Tolerant parsing was the right call for a reason better than
 * the one originally given: not "the schema will drift one day", but "the
 * schema is already wrong today".
 */

import { type LicenceValidationResponse } from 'src/licensing/types';

export type ParsedValidation =
  | { readonly kind: 'parsed'; readonly response: LicenceValidationResponse }
  | { readonly kind: 'malformed'; readonly detail: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const readString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/**
 * Accepts a numeric string too. Numbers crossing a JSON boundary from a .NET or
 * JVM service occasionally arrive quoted, and `daysRemaining: "14"` meaning
 * `null` would silently suppress every expiry warning.
 */
const readNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

const readStringArray = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];

export const parseValidationResponse = (payload: unknown): ParsedValidation => {
  if (!isRecord(payload)) {
    return {
      kind: 'malformed',
      detail: `expected a JSON object, received ${payload === null ? 'null' : typeof payload}`,
    };
  }

  const valid = payload['valid'];

  if (typeof valid !== 'boolean') {
    return {
      kind: 'malformed',
      detail: `response has no boolean "valid" field (received ${typeof valid})`,
    };
  }

  return {
    kind: 'parsed',
    response: {
      valid,
      reason: readString(payload['reason']),
      // Fail closed on the paid capability, open on the product: absent
      // hasFeature means "no enrichment", never "enrichment".
      hasFeature: readBoolean(payload['hasFeature'], false),
      features: readStringArray(payload['features']),
      tier: readString(payload['tier']),
      // The service calls this `type`; `type` is a reserved-ish name in this
      // codebase's field vocabulary, so it is widened to `licenceType` here and
      // nowhere else.
      licenceType: readString(payload['type']),
      status: readString(payload['status']),
      daysRemaining: readNumber(payload['daysRemaining']),
      expiryWarning: readBoolean(payload['expiryWarning'], false),
      expiryAt: readString(payload['expiryAt']),
      activatedCount: readNumber(payload['activatedCount']),
      maxActivations: readNumber(payload['maxActivations']),
      inGracePeriod: readBoolean(payload['inGracePeriod'], false),
      // Declared required by the spec, absent from every live response so far.
      // Read anyway: the day the service starts sending them, a maintenance
      // window that has already lapsed is something an admin should be able to
      // see in the audit row rather than something we silently dropped. Nothing
      // branches on either — `isEnrichmentEntitled` is still `valid && hasFeature`
      // and nothing else.
      gracePeriodDaysRemaining: readNumber(payload['gracePeriodDaysRemaining']),
      maintenanceExpired: readBoolean(payload['maintenanceExpired'], false),
      maintenanceExpiryAt: readString(payload['maintenanceExpiryAt']),
      // Undocumented and present on every live response — the mirror image of
      // the three fields above, which are documented and present on none.
      licenceId: readString(payload['licenseId']),
      // Passed through untouched, including `undefined`. Validating it here
      // would mean the licensing parser knowing what calibration is, and the
      // whole point of `unknown` is that it does not.
      customerMetadata: payload['customerMetadata'],
    },
  };
};
