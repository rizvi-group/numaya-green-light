/**
 * The vocabulary of the licensing client.
 *
 * Everything in `src/licensing/` except this file's consumers is pure: no
 * network, no `new Date()`, no SDK import. The two ports declared here —
 * `LicensingPort` and `LicenceStorePort` — are the only seams through which
 * anything impure reaches the core, and both are implemented in
 * `src/logic-functions/licence-*.ts`, exactly as `scoring-run.ts` takes its API
 * client and its `ReleaseMarkerStore`.
 *
 * ## The raw licence key is not in this file
 *
 * Deliberately. No type here has a `key` field, and no function in
 * `src/licensing/` ever receives one — the run module masks the key once, at the
 * edge, and passes `LicenceKeyPresence` inwards. That is a structural guarantee
 * rather than a discipline: there is no variable in the core that *could* leak.
 * The one place the raw key exists is the argument to `LicensingPort.validate` /
 * `.activate`, which is the HTTP adapter's request body and nothing else.
 */

/* -------------------------------------------------------------------------- */
/* Environment                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Which side of the licensing service a request was routed to.
 *
 * Carried all the way through to `LicenceState` — and therefore into the audit
 * row and the admin notice — because "which environment did we ask?" is the
 * question that turns an inexplicable `license_not_found` into a one-line fix.
 * See `LICENCE_ENVIRONMENT_HEADER` in `src/constants/licence-identifiers.ts`.
 */
export type LicenceEnvironmentName = 'production' | 'sandbox';

/* -------------------------------------------------------------------------- */
/* The service's validate response                                             */
/* -------------------------------------------------------------------------- */

/**
 * The subset of the `validate` response Greenlight reads, after tolerant
 * parsing. Every field is total — parsing never throws and never produces
 * `undefined`, because a schema change on Numaya's side must degrade the
 * product, not crash a workspace's nightly job.
 *
 * `valid` and `hasFeature` are separate booleans and are **independent**; see
 * `entitlement.ts`. Do not be tempted to collapse them here.
 */
export interface LicenceValidationResponse {
  readonly valid: boolean;
  readonly reason: string | null;
  readonly hasFeature: boolean;
  readonly features: readonly string[];
  readonly tier: string | null;
  readonly licenceType: string | null;
  readonly status: string | null;
  readonly daysRemaining: number | null;
  readonly expiryWarning: boolean;
  readonly expiryAt: string | null;
  readonly activatedCount: number | null;
  readonly maxActivations: number | null;
  readonly inGracePeriod: boolean;
  /**
   * The three fields below are part of the service's documented contract but
   * were absent from every live response observed. They are carried so a future
   * response that includes them is not silently discarded; no decision in this
   * codebase reads them. See `parse.ts`.
   */
  readonly gracePeriodDaysRemaining: number | null;
  readonly maintenanceExpired: boolean;
  readonly maintenanceExpiryAt: string | null;
  /**
   * The licence's id, as the service reports it. Present on every live
   * `validate` response measured, and absent from the published schema — the
   * reverse of the over-promising described above.
   *
   * Carried for the audit row and for support: "which licence answered" is the
   * first question asked when a workspace's entitlement looks wrong, and it is
   * not derivable from the mask.
   */
  readonly licenceId: string | null;
  /**
   * The licence's org-authored metadata bag, exactly as received.
   *
   * This is the delivery channel for licence-gated calibration — see
   * `src/calibration/types.ts` for why it is this and not the config endpoint.
   * Deliberately typed `unknown`: it is free-form JSON authored outside this
   * repository's release cycle, and the licensing core has no business knowing
   * its shape. `src/calibration/parse.ts` is the only thing that reads into it.
   *
   * It never contains, and must never contain, anything secret. It is returned
   * to any holder of the licence key, which is the customer.
   */
  readonly customerMetadata: unknown;
}

/* -------------------------------------------------------------------------- */
/* Call outcomes                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Everything that can go wrong on the wire, as data rather than as an exception.
 *
 * The adapter never throws: a thrown error crossing this boundary would have to
 * be caught identically at every call site, and one missed `catch` in a cron
 * handler is a workspace that silently stops re-validating. Making failure a
 * return value means the compiler enumerates the cases.
 *
 * `activation_limit_reached` is matched on `statusCode === 409` and nothing
 * else. The REST layer does send an RFC 7807 body with
 * `title: "max_activations_reached"`, but the status code is the stable half of
 * that contract and the only half worth branching on.
 *
 * ## The two *definitive* failures
 *
 * `key_rejected` (401/403) and `licence_not_found` (404) are answers, not
 * outages, and `state.ts` treats them as such: they do not walk the cached
 * entitlement ladder, because there is nothing to wait out. Everything else on
 * this list means "we did not get an answer", and those do walk the ladder.
 */
export type LicenceCallFailure =
  | { readonly kind: 'rate_limited'; readonly retryAfterSeconds: number | null }
  | { readonly kind: 'service_unavailable'; readonly statusCode: number }
  | { readonly kind: 'key_rejected'; readonly statusCode: number }
  | { readonly kind: 'licence_not_found'; readonly statusCode: number }
  | { readonly kind: 'unexpected_status'; readonly statusCode: number }
  | { readonly kind: 'malformed_response'; readonly detail: string }
  | { readonly kind: 'transport_failure'; readonly detail: string };

export type LicenceValidateOutcome =
  | { readonly kind: 'validated'; readonly response: LicenceValidationResponse }
  | LicenceCallFailure;

export type LicenceActivateOutcome =
  | { readonly kind: 'activated'; readonly activationId: string | null }
  | { readonly kind: 'activation_limit_reached' }
  | LicenceCallFailure;

/**
 * The port the core is written against. Implemented by
 * `src/logic-functions/licence-http-client.ts`; faked in every unit test.
 *
 * Note what is absent: no `create`, `suspend`, `revoke`, `reactivate` or
 * `renew`. Those are org-scoped management operations that need a credential
 * Greenlight must never carry. `validate` and `activate` need only the
 * customer's own key, which is precisely what makes shipping this client safe.
 */
export interface LicensingPort {
  validate(input: {
    readonly key: string;
    readonly deviceFingerprint?: string | null;
    readonly feature?: string | null;
  }): Promise<LicenceValidateOutcome>;

  activate(input: {
    readonly key: string;
    readonly deviceFingerprint: string;
    readonly deviceName?: string | null;
  }): Promise<LicenceActivateOutcome>;
}

/* -------------------------------------------------------------------------- */
/* Cached entitlement                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What survives between runs. Note there is no `key` field: the cache records
 * *which* licence it describes as a mask, so a dump of app key-value storage
 * cannot be replayed against the licensing service.
 */
export interface CachedLicenceValidation {
  readonly cachedAt: string;
  readonly maskedKey: string;
  readonly valid: boolean;
  readonly hasFeature: boolean;
  readonly reason: string | null;
  readonly features: readonly string[];
  readonly tier: string | null;
  readonly daysRemaining: number | null;
  readonly expiryWarning: boolean;
  readonly expiryAt: string | null;
}

/**
 * Sticky outcome of the install-time activation attempt.
 *
 * `limit_reached` is the one piece of licence state that must outlive the
 * validation cache — see `state.ts`, "Why activation state is sticky".
 */
export type LicenceActivationState =
  | { readonly status: 'claimed'; readonly at: string }
  | { readonly status: 'limit_reached'; readonly at: string }
  | { readonly status: 'unknown' };

/**
 * App key-value storage, narrowed to the three things licensing keeps there.
 * Implemented over `kv` in `src/logic-functions/licence-cache-store.ts`.
 */
export interface LicenceStorePort {
  readCache(): Promise<CachedLicenceValidation | null>;
  writeCache(entry: CachedLicenceValidation): Promise<void>;
  readActivation(): Promise<LicenceActivationState>;
  writeActivation(state: LicenceActivationState): Promise<void>;
  publishState(state: LicenceState): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/* Resolved state                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Every reason Greenlight can be in a given mode, as a closed vocabulary.
 *
 * Closed rather than `string` because these values end up in audit rows that
 * outlive the code that wrote them, and in an admin-facing notice. A typo'd
 * free-text reason is a support ticket nobody can grep for.
 *
 * `feature_not_licensed` is on this list even though the service **never sends
 * it** — a rules-only licence asked about `enrichment` answers
 * `valid: true, hasFeature: false` with `reason: null`. We derive it. See
 * `entitlement.ts`.
 */
export type LicenceReason =
  | 'licensed'
  | 'no_licence_key'
  | 'feature_not_licensed'
  | 'licence_not_found_in_environment'
  | 'expired'
  | 'revoked'
  | 'suspended'
  | 'quota_exceeded'
  | 'device_not_activated'
  | 'max_activations_reached'
  | 'invalid_licence'
  | 'licence_service_rate_limited'
  | 'licence_response_malformed'
  | 'licence_service_unreachable'
  | 'licence_service_unreachable_grace_expired';

/** Where the entitlement decision came from. */
export type LicenceSource = 'live' | 'cache' | 'grace' | 'none';

/**
 * `full` means enrichment may run. `rules-only` means it may not — and means
 * nothing else. Deterministic scoring is not addressed by this type because it
 * is never gated; see `feature-gate.ts`.
 */
export type LicenceMode = 'full' | 'rules-only';

/** How loudly the admin should hear about this. Drives the audit event type. */
export type LicenceSeverity = 'ok' | 'notice' | 'warning' | 'problem';

export interface LicenceState {
  readonly mode: LicenceMode;
  readonly reason: LicenceReason;
  readonly source: LicenceSource;
  readonly severity: LicenceSeverity;
  readonly maskedKey: string;
  /**
   * Which environment the check was routed to. Recorded on every state, not
   * only the failing ones: a state published from a run that asked the wrong
   * side is indistinguishable from one that asked the right side unless the
   * environment travels with it.
   *
   * States published by a build predating this field read back as `undefined`
   * at runtime. Nothing branches on it, so that is a cosmetic gap in one
   * night's audit row, cleared by the next run.
   */
  readonly environment: LicenceEnvironmentName;
  readonly checkedAt: string;
  /** Age of the entitlement the decision was taken on, or null when live. */
  readonly cacheAgeMs: number | null;
  /** Raw transport-failure kind, kept for the audit row. Null on a live call. */
  readonly failureKind: LicenceCallFailure['kind'] | null;
  /**
   * The two booleans the decision was actually taken on, carried through so the
   * audit row can record them separately.
   *
   * They are kept apart rather than collapsed into `mode` precisely because
   * their independence is the thing most likely to be misread later: an audit
   * row showing `valid: true, hasFeature: false, mode: rules-only` tells a
   * support engineer at a glance that this is an unsold feature, not a broken
   * licence. `null` when no entitlement was ever observed (no key, or a failure
   * with no cache to fall back on).
   */
  readonly observedValid: boolean | null;
  readonly observedHasFeature: boolean | null;
  readonly tier: string | null;
  readonly daysRemaining: number | null;
  readonly expiryWarning: boolean;
  readonly expiryAt: string | null;
  readonly features: readonly string[];
}

/**
 * What the core is told about the key: whether there is one, and what it looks
 * like once masked. The key itself stops at the edge.
 */
export interface LicenceKeyPresence {
  readonly hasKey: boolean;
  readonly maskedKey: string;
}
