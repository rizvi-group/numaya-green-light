/**
 * A circuit breaker per provider — PRODUCT_SPEC's production checklist item,
 * expressed as pure state transitions with `now` handed in.
 *
 * ## What it is protecting
 *
 * Not the provider. Us. Enrichment is triggered by a database event, so a
 * provider that has started returning `503` is not asked once — it is asked once
 * per lead, on a workspace that may be mid-import. Every one of those calls costs
 * latency in a worker, a line in the log, and on a metered search plan, money for
 * an error page. The breaker turns "n leads, n failures" into "n leads, one
 * failure and n-1 cheap refusals".
 *
 * ## Why the trip threshold is 3 and not 1
 *
 * A single failure is indistinguishable from a slow DNS answer. Three
 * consecutive ones is a pattern. The exception is `rate_limited`, which is the
 * provider explicitly telling us to stop: that opens the breaker immediately and
 * honours `Retry-After` when one is given, because guessing a cooldown against a
 * quota that has already been stated is how a 429 becomes a ban.
 *
 * `not_configured` never trips anything. It is a configuration answer, not a
 * fault, it costs no external call, and counting it would open a breaker that
 * then has to time out before an admin's fix takes effect.
 *
 * ## Half-open, informally
 *
 * There is no half-open state and no probe scheduler, because there is nothing
 * to schedule: the next lead event is the probe. Once `retryAt` passes, exactly
 * one call is allowed through; it either succeeds and closes the breaker, or
 * fails and re-opens it with a longer backoff. That is a half-open breaker with
 * the platform's own event stream as its trigger, which is one fewer moving part
 * than a timer this app would have to own.
 */

import type {
  BreakerState,
  BreakerStates,
  ProviderFailureKind,
} from 'src/enrichment/types';

/** Consecutive failures before a non-429 breaker opens. */
export const BREAKER_FAILURE_THRESHOLD = 3;

/** First cooldown, doubling per re-open, capped. Matches ARCHITECTURE.md's "capped at 5 min". */
export const BREAKER_BASE_COOLDOWN_MS = 60_000;
export const BREAKER_MAX_COOLDOWN_MS = 300_000;

export const CLOSED_BREAKER: BreakerState = {
  consecutiveFailures: 0,
  openedAt: null,
  retryAt: null,
  lastFailureKind: null,
};

const readBreaker = (states: BreakerStates, provider: string): BreakerState =>
  states[provider] ?? CLOSED_BREAKER;

/**
 * Backoff for the nth consecutive failure: 60s, 120s, 240s, then capped at 300s.
 * Exponential and capped, exactly as the idempotency section requires.
 */
const cooldownFor = (consecutiveFailures: number): number => {
  const exponent = Math.max(0, consecutiveFailures - BREAKER_FAILURE_THRESHOLD);

  return Math.min(
    BREAKER_MAX_COOLDOWN_MS,
    BREAKER_BASE_COOLDOWN_MS * 2 ** exponent,
  );
};

export interface BreakerVerdict {
  readonly open: boolean;
  /** ISO-8601 of when it may next be tried. Null when closed. */
  readonly retryAt: string | null;
  readonly lastFailureKind: ProviderFailureKind | null;
}

/**
 * May this provider be called right now?
 *
 * A malformed or unparseable `retryAt` reads as **closed**. That is the
 * fail-open direction and it is the correct one here: the worst case of wrongly
 * allowing a call is one wasted request, and the worst case of wrongly refusing
 * one is a workspace whose enrichment never recovers because a corrupt timestamp
 * can never expire.
 */
export const inspectBreaker = (
  states: BreakerStates,
  provider: string,
  now: Date,
): BreakerVerdict => {
  const state = readBreaker(states, provider);

  if (state.openedAt === null || state.retryAt === null) {
    return { open: false, retryAt: null, lastFailureKind: state.lastFailureKind };
  }

  const retryAt = Date.parse(state.retryAt);

  if (!Number.isFinite(retryAt)) {
    return { open: false, retryAt: null, lastFailureKind: state.lastFailureKind };
  }

  return {
    open: now.getTime() < retryAt,
    retryAt: state.retryAt,
    lastFailureKind: state.lastFailureKind,
  };
};

/**
 * Record a failure. Returns the whole map so the caller writes once.
 *
 * `retryAfterSeconds` is honoured when the provider supplied one and it is
 * sane. "Sane" is a day: a `Retry-After` measured in weeks is either a
 * misconfigured proxy or a header we have misread, and obeying it would take a
 * workspace's enrichment offline on the strength of a string.
 */
export const recordBreakerFailure = (
  states: BreakerStates,
  provider: string,
  failure: { kind: ProviderFailureKind; retryAfterSeconds?: number | null },
  now: Date,
): BreakerStates => {
  if (failure.kind === 'not_configured') {
    return states;
  }

  const previous = readBreaker(states, provider);
  const consecutiveFailures = previous.consecutiveFailures + 1;

  const immediate = failure.kind === 'rate_limited';
  const shouldOpen = immediate || consecutiveFailures >= BREAKER_FAILURE_THRESHOLD;

  if (!shouldOpen) {
    return {
      ...states,
      [provider]: {
        consecutiveFailures,
        openedAt: null,
        retryAt: null,
        lastFailureKind: failure.kind,
      },
    };
  }

  const advised = normaliseRetryAfter(failure.retryAfterSeconds);
  const cooldownMs = advised ?? cooldownFor(consecutiveFailures);

  return {
    ...states,
    [provider]: {
      consecutiveFailures,
      openedAt: now.toISOString(),
      retryAt: new Date(now.getTime() + cooldownMs).toISOString(),
      lastFailureKind: failure.kind,
    },
  };
};

const MAX_ADVISED_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const normaliseRetryAfter = (seconds: number | null | undefined): number | null => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  return Math.min(MAX_ADVISED_COOLDOWN_MS, Math.floor(seconds) * 1000);
};

/** Record a success: the breaker closes and the failure count resets. */
export const recordBreakerSuccess = (
  states: BreakerStates,
  provider: string,
): BreakerStates => {
  const previous = readBreaker(states, provider);

  if (
    previous.consecutiveFailures === 0 &&
    previous.openedAt === null &&
    previous.retryAt === null
  ) {
    // Already closed and clean. Returning the same reference lets the caller
    // skip a key-value write on the overwhelmingly common path.
    return states;
  }

  return { ...states, [provider]: CLOSED_BREAKER };
};

/** Tolerant read of whatever was in storage. Anything unrecognisable is "closed". */
export const toBreakerStates = (value: unknown): BreakerStates => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }

  const states: Record<string, BreakerState> = {};

  for (const [provider, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      continue;
    }

    const entry = raw as Record<string, unknown>;
    const consecutiveFailures = entry['consecutiveFailures'];

    states[provider] = {
      consecutiveFailures:
        typeof consecutiveFailures === 'number' && Number.isFinite(consecutiveFailures)
          ? Math.max(0, Math.floor(consecutiveFailures))
          : 0,
      openedAt: typeof entry['openedAt'] === 'string' ? entry['openedAt'] : null,
      retryAt: typeof entry['retryAt'] === 'string' ? entry['retryAt'] : null,
      lastFailureKind: isFailureKind(entry['lastFailureKind'])
        ? entry['lastFailureKind']
        : null,
    };
  }

  return states;
};

const FAILURE_KINDS: readonly ProviderFailureKind[] = [
  'not_configured',
  'rate_limited',
  'service_unavailable',
  'unexpected_status',
  'malformed_response',
  'transport_failure',
];

const isFailureKind = (value: unknown): value is ProviderFailureKind =>
  typeof value === 'string' &&
  (FAILURE_KINDS as readonly string[]).includes(value);
