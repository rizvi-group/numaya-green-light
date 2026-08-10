/**
 * Identifiers, endpoint shape and storage keys for the Numaya licensing client.
 *
 * Same permanence rule as `src/constants/universal-identifiers.ts`: every UUID
 * here is written into the customer's workspace at install time, so changing one
 * orphans the old entity rather than renaming it. Adding is safe.
 *
 * These live in their own file rather than in `universal-identifiers.ts` for the
 * same reason the gate-queue constants do — so the licensing surface can be
 * built without touching the data-model constants the scoring engine depends on.
 *
 * ---------------------------------------------------------------------------
 * ## What is verified here, and how
 *
 * Everything below is now confirmed against the **REST API of the running
 * service**, not inferred. The service publishes an OpenAPI document at
 * `https://licensing.rizvigoc.com/openapi.json` (title: *Numaya Licensing -
 * Customer API*), and each request shape below was additionally exercised over
 * real HTTP on 2026-08-04.
 *
 * The spec is authoritative over `LICENSING_INTEGRATION.md`, which was written
 * from the service's **MCP** interface and predates the published spec. Where
 * the two disagree, the spec — and the live response — wins.
 *
 * The base URL stays an **application variable** (`LICENCE_API_BASE_URL`) even
 * though it is now confirmed, because a customer running a private Numaya
 * deployment still needs to point it somewhere else, and because a wrong
 * default must remain a settings change rather than a release.
 *
 * Nothing here is load-bearing for safety: every request this client makes
 * either succeeds, or fails in a way that degrades to rules-only scoring. A
 * wrong base URL costs the customer enrichment, never a lead. See
 * `src/licensing/state.ts`.
 * ---------------------------------------------------------------------------
 */

/* -------------------------------------------------------------------------- */
/* Universal identifiers                                                       */
/* -------------------------------------------------------------------------- */

export const LICENCE_API_BASE_URL_APP_VARIABLE_UNIVERSAL_IDENTIFIER =
  '0dbad279-c07c-4ae0-91e5-68cb0e87c944';

/**
 * `LICENCE_ENVIRONMENT`. See `LICENCE_ENVIRONMENTS` below for why an endpoint
 * that a customer will never change is still a Layer 1 variable.
 */
export const LICENCE_ENVIRONMENT_APP_VARIABLE_UNIVERSAL_IDENTIFIER =
  'e39571dd-0053-4c17-a11f-c0988985d312';

export const LICENCE_REVALIDATE_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER =
  'fc2534ad-a3a1-4b05-bdf0-f2e7a1cef729';

export const LICENCE_STATUS_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER =
  '42eaa3bc-75b6-49be-863c-a3b3c539e3a2';

export const LICENCE_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER =
  '42089a05-139e-4061-aaaa-1d53e851ac90';

export const LICENCE_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER =
  'b0316c8e-e4ad-492c-9197-f26c553c0151';

/* -------------------------------------------------------------------------- */
/* The licence panel                                                           */
/* -------------------------------------------------------------------------- */

export const LICENCE_ROUTE_PATH = '/greenlight/licence';

export const LICENCE_CLIENT_PATH = `/s${LICENCE_ROUTE_PATH}`;

/**
 * Where "Get a licence" sends an admin.
 *
 * A constant rather than a literal in the component because it is the one part
 * of this feature guaranteed to move: today numaya.ai has no Greenlight
 * checkout, so the honest destination is the contact route, which reaches a
 * human who can issue a key. When a real purchase page exists this is the only
 * line that changes.
 *
 * The `source` parameter is not decoration. Without it there is no way to tell
 * an enquiry that came from inside a customer's own CRM — someone who has
 * already installed the app and hit the rules-only ceiling — from a cold
 * website visitor, and those two deserve different replies.
 */
export const LICENCE_PURCHASE_URL =
  'https://numaya.ai/contact?source=greenlight-app';

/* -------------------------------------------------------------------------- */
/* Endpoint shape — confirmed against the published spec and live HTTP         */
/* -------------------------------------------------------------------------- */

/**
 * Default value of the `LICENCE_API_BASE_URL` application variable.
 *
 * `https://licensing.rizvigoc.com` is the licensing service's real public
 * hostname, confirmed on 2026-08-04 by fetching its OpenAPI document and by
 * driving `validate` and `activate` against it over HTTPS.
 *
 * The earlier default, `license.numaya.ai`, never existed: it was a placeholder
 * that entered this project's own documentation and was then cited by it. It
 * did not resolve in public DNS, so every install shipped with it fell straight
 * through the cache → grace → rules-only ladder. That ladder worked, which is
 * precisely why the wrong hostname survived as long as it did.
 */
export const DEFAULT_LICENCE_API_BASE_URL = 'https://licensing.rizvigoc.com';

/**
 * Confirmed. Both paths appear verbatim in the service's published OpenAPI
 * document and both were exercised live. The `/v1` prefix and the US spelling
 * `licenses` are the service's, not ours.
 */
export const LICENCE_VALIDATE_PATH = '/v1/licenses/validate';
export const LICENCE_ACTIVATE_PATH = '/v1/licenses/activate';

/* -------------------------------------------------------------------------- */
/* Environment routing                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The header that selects which side of the licensing service answers.
 *
 * One host serves both environments. Sandbox licences are **only** visible to a
 * request carrying `X-Numaya-Environment: sandbox`; without it the same key
 * comes back `200 valid:false reason:"license_not_found"`. The service's own
 * spec says so in one sentence — "Use `X-Numaya-Environment: sandbox` header or
 * `nml_test_` API keys to access the sandbox" — and the live behaviour matches.
 *
 * The header value is matched case-insensitively by the service (`sandbox`,
 * `Sandbox` and `SANDBOX` all worked); we send the lower-case form.
 */
export const LICENCE_ENVIRONMENT_HEADER = 'X-Numaya-Environment';

/**
 * The two environments, and why this is an application variable at all.
 *
 * It is **not** derivable from the base URL — the same host serves both — so it
 * cannot be folded into `LICENCE_API_BASE_URL`. It cannot be a code constant
 * either: our own CI workspace and every throwaway dev container is licensed
 * out of sandbox, and making that a constant would mean a code change and a
 * republish to test a licensing change. And it cannot live in Layer 2, the
 * CRM-editable `GreenlightConfig` record, because the post-install hook
 * validates the licence before any Layer 2 record is guaranteed to exist.
 *
 * That leaves Layer 1. A customer never touches it — the default is
 * `production` and the description says as much — but it has to be *settable*
 * without a rebuild, which is the identical argument that already put
 * `LICENCE_API_BASE_URL` in Layer 1.
 */
export const LICENCE_ENVIRONMENTS = ['production', 'sandbox'] as const;

export const DEFAULT_LICENCE_ENVIRONMENT = 'production';

/**
 * The service's `reason` when a key authenticated but resolved to no licence in
 * the environment the request was routed to. US spelling, the service's own.
 *
 * This is the misrouted-environment signal. See `src/licensing/entitlement.ts`
 * for why it cannot mean "the key has a typo".
 */
export const LICENCE_NOT_FOUND_REASON = 'license_not_found';

/**
 * Request body field names.
 *
 * These are *not* guesses: they are the parameter names the licensing service's
 * own MCP tool schema declares for `numaya_validate_license` and
 * `numaya_activate_license`, which are generated from the service's parameter
 * model. The REST layer using different names is possible but unlikely.
 */
export const LICENCE_REQUEST_FIELDS = {
  key: 'key',
  deviceFingerprint: 'deviceFingerprint',
  feature: 'feature',
  deviceName: 'deviceName',
} as const;

/**
 * The feature name the paid capability is licensed under. `rules` — the
 * deterministic gate — is on every policy and is never checked, because rules
 * scoring is the free floor and must run with no licence at all.
 */
export const ENRICHMENT_FEATURE_NAME = 'enrichment';

/* -------------------------------------------------------------------------- */
/* App key-value storage                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Where the cached entitlement and the published admin-facing state live.
 *
 * `scope: 'WORKSPACE'` throughout — the licence is per workspace, and the
 * activation slot is claimed with the workspace id as its fingerprint. A read
 * under a different scope silently finds nothing, which is the failure mode
 * `release-marker-store.ts` documents.
 */
export const LICENCE_CACHE_KV_KEY = 'greenlight.licence.cache';

/**
 * Sticky record of what happened the last time we tried to claim an activation
 * slot. Separate from the validation cache on purpose: a `409` is durable
 * customer state (the licence is bound to a different workspace) and must
 * survive every nightly re-validation, whereas the validation cache is replaced
 * nightly. See `src/licensing/state.ts` for why this matters.
 */
export const LICENCE_ACTIVATION_KV_KEY = 'greenlight.licence.activation';

/**
 * The resolved licence state, published for the admin UI to read. Written on
 * every validation; never contains the licence key.
 */
export const LICENCE_STATE_KV_KEY = 'greenlight.licence.state';

/**
 * The verified calibration payload, cached beside the entitlement.
 *
 * Separate from `LICENCE_CACHE_KV_KEY` on purpose. The two are written by the
 * same nightly run but answer different questions and age on different clocks —
 * the entitlement tightens at 24h because a stale one risks serving a paid
 * feature to a revoked licence, while calibration survives to 72h because it is
 * a word list and dropping it early would move a customer's scores for a reason
 * that has nothing to do with their data. See `src/calibration/state.ts`.
 *
 * It holds no key, no entitlement and nothing secret: the payload is the same
 * vocabulary every licensed workspace receives.
 */
export const CALIBRATION_CACHE_KV_KEY = 'greenlight.calibration.cache';

/**
 * The resolved calibration state, published for the admin panel: shipped
 * defaults or calibration vNN, from where, and when it last refreshed.
 */
export const CALIBRATION_STATE_KV_KEY = 'greenlight.calibration.state';

/* -------------------------------------------------------------------------- */
/* Schedule                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Nightly re-validation, 03:17 UTC.
 *
 * Standard five-field CRON. The odd minute is deliberate: every Greenlight
 * install would otherwise phone home on the same second, and the licensing
 * service is a single small container. Daily is the right frequency because the
 * cache TTL is 24h — validating more often buys nothing, validating less often
 * would let the cache go stale before the next run.
 */
export const LICENCE_REVALIDATE_CRON_PATTERN = '17 3 * * *';
