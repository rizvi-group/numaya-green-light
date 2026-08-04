/**
 * Cache freshness and offline-grace arithmetic.
 *
 * Pure: `now` is passed in, never read. The scoring engine holds the same line
 * for the same reason — a clock read inside a decision function makes the
 * decision untestable at its boundaries, and every interesting case here *is* a
 * boundary.
 *
 * ---------------------------------------------------------------------------
 * ## The windows, and why they are these windows
 *
 * From the error-state table in `LICENSING_INTEGRATION.md`:
 *
 * | Cache age        | Behaviour                                     |
 * |------------------|-----------------------------------------------|
 * | `< 24h`          | Cached entitlement used as-is                 |
 * | `24h – 72h`      | Rules-only, "grace period"                    |
 * | `> 72h`          | Rules-only + visible warning                  |
 *
 * Note that grace **ends at 72h from `cachedAt`**, not at 24h + 72h. The prose
 * elsewhere reads "24h cache, then a 72h offline grace window", which would put
 * the cliff at 96h; the table is the specific claim and the table is what is
 * implemented. The difference is 24 hours of degraded-but-warned operation and
 * it changes nothing about safety, because **nothing is ever blocked at any
 * point on this ladder** — past 72h the product is still scoring leads, it is
 * just scoring them without enrichment and saying so loudly.
 *
 * ## Why grace disables enrichment rather than extending it
 *
 * Because the two failure modes are not symmetric. Trusting a stale entitlement
 * for three days means potentially serving a paid feature to a revoked licence,
 * and revocation is the one lever that has to work. Turning enrichment off means
 * the customer loses an optional enhancement during a Numaya outage. The second
 * is recoverable in seconds when the service returns; the first is not
 * recoverable at all.
 *
 * The 24h band is the exception, and it is bounded precisely so that "Numaya
 * restarted a container" never costs a customer anything.
 * ---------------------------------------------------------------------------
 */

const HOUR_MS = 60 * 60 * 1000;

/** Entitlements younger than this are used exactly as if they were live. */
export const LICENCE_CACHE_TTL_MS = 24 * HOUR_MS;

/**
 * Age at which the offline grace window closes, measured from `cachedAt`.
 * Past this the product warns visibly — it does not stop.
 */
export const LICENCE_OFFLINE_GRACE_LIMIT_MS = 72 * HOUR_MS;

export type CacheFreshness = 'fresh' | 'grace' | 'expired';

/**
 * Age of a cached entitlement in milliseconds, or `null` when `cachedAt` is
 * missing or unparseable.
 *
 * A negative age — a cache written by a machine whose clock is ahead — is
 * clamped to `0` rather than rejected. The alternative is that a small clock
 * skew on the licensing service makes a workspace look like it has never
 * validated, which is a worse outcome than briefly treating a slightly-future
 * entitlement as fresh.
 */
export const cacheAgeMs = (
  cachedAt: string | null | undefined,
  now: Date,
): number | null => {
  if (typeof cachedAt !== 'string' || cachedAt.length === 0) {
    return null;
  }

  const cachedMs = Date.parse(cachedAt);

  if (Number.isNaN(cachedMs)) {
    return null;
  }

  return Math.max(0, now.getTime() - cachedMs);
};

/**
 * Boundaries are inclusive at the *lower* edge of the worse band: an entitlement
 * exactly 24h old is already in grace, and one exactly 72h old is already
 * expired. Erring towards the stricter band on the boundary keeps the rule
 * "fresh means strictly under a day old" true as stated.
 */
export const classifyCacheAge = (ageMs: number): CacheFreshness => {
  if (ageMs < LICENCE_CACHE_TTL_MS) {
    return 'fresh';
  }

  if (ageMs < LICENCE_OFFLINE_GRACE_LIMIT_MS) {
    return 'grace';
  }

  return 'expired';
};

/**
 * `null` when there is no usable cache at all — which is not the same as an
 * expired one, and the admin notice says so differently.
 */
export const classifyCache = (
  cachedAt: string | null | undefined,
  now: Date,
): { readonly freshness: CacheFreshness | null; readonly ageMs: number | null } => {
  const ageMs = cacheAgeMs(cachedAt, now);

  return {
    freshness: ageMs === null ? null : classifyCacheAge(ageMs),
    ageMs,
  };
};
