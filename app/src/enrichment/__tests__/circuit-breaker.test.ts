import {
  BREAKER_MAX_COOLDOWN_MS,
  inspectBreaker,
  recordBreakerFailure,
  recordBreakerSuccess,
  toBreakerStates,
  type BreakerStates,
} from 'src/enrichment';
import { describe, expect, it } from 'vitest';

const NOW = new Date('2026-08-03T09:00:00.000Z');
const later = (ms: number): Date => new Date(NOW.getTime() + ms);

const failTimes = (
  count: number,
  kind: 'service_unavailable' | 'transport_failure' = 'service_unavailable',
): BreakerStates => {
  let states: BreakerStates = {};

  for (let index = 0; index < count; index += 1) {
    states = recordBreakerFailure(states, 'search:brave', { kind }, NOW);
  }

  return states;
};

describe('circuit breaker', () => {
  it('should stay closed for the first two failures', () => {
    expect(inspectBreaker(failTimes(1), 'search:brave', NOW).open).toBe(false);
    expect(inspectBreaker(failTimes(2), 'search:brave', NOW).open).toBe(false);
  });

  it('should open on the third consecutive failure', () => {
    const states = failTimes(3);

    expect(inspectBreaker(states, 'search:brave', NOW).open).toBe(true);
  });

  it('should open immediately on a rate limit', () => {
    const states = recordBreakerFailure(
      {},
      'search:brave',
      { kind: 'rate_limited', retryAfterSeconds: null },
      NOW,
    );

    expect(inspectBreaker(states, 'search:brave', NOW).open).toBe(true);
  });

  it('should honour a sane Retry-After', () => {
    const states = recordBreakerFailure(
      {},
      'search:brave',
      { kind: 'rate_limited', retryAfterSeconds: 120 },
      NOW,
    );

    expect(inspectBreaker(states, 'search:brave', later(119_000)).open).toBe(true);
    expect(inspectBreaker(states, 'search:brave', later(121_000)).open).toBe(false);
  });

  it('should ignore an absurd Retry-After', () => {
    const states = recordBreakerFailure(
      {},
      'search:brave',
      { kind: 'rate_limited', retryAfterSeconds: 60 * 60 * 24 * 90 },
      NOW,
    );

    // Capped at a day. A header we may have misread must not take a workspace's
    // enrichment offline for a quarter.
    expect(
      inspectBreaker(states, 'search:brave', later(25 * 60 * 60 * 1000)).open,
    ).toBe(false);
  });

  it('should let exactly one call through once the cooldown passes', () => {
    const states = failTimes(3);

    expect(inspectBreaker(states, 'search:brave', later(59_000)).open).toBe(true);
    expect(inspectBreaker(states, 'search:brave', later(61_000)).open).toBe(false);
  });

  it('should back off further on each re-open, capped', () => {
    const states = failTimes(12);
    const retryAt = Date.parse(states['search:brave']?.retryAt ?? '');

    expect(retryAt - NOW.getTime()).toBe(BREAKER_MAX_COOLDOWN_MS);
  });

  it('should close on success and reset the failure count', () => {
    const closed = recordBreakerSuccess(failTimes(3), 'search:brave');

    expect(inspectBreaker(closed, 'search:brave', NOW).open).toBe(false);
    expect(closed['search:brave']?.consecutiveFailures).toBe(0);
  });

  it('should return the same reference when a closed breaker succeeds again', () => {
    const states: BreakerStates = {};

    expect(recordBreakerSuccess(states, 'search:brave')).toBe(states);
  });

  it('should never trip on a configuration answer', () => {
    let states: BreakerStates = {};

    for (let index = 0; index < 5; index += 1) {
      states = recordBreakerFailure(
        states,
        'reasoning:twenty-ai',
        { kind: 'not_configured' },
        NOW,
      );
    }

    expect(states).toEqual({});
  });

  it('should keep providers independent', () => {
    const states = failTimes(3);

    expect(inspectBreaker(states, 'reasoning:twenty-ai', NOW).open).toBe(false);
  });

  it('should read a corrupt retryAt as closed rather than as forever', () => {
    const states = toBreakerStates({
      'search:brave': {
        consecutiveFailures: 9,
        openedAt: 'not a date',
        retryAt: 'also not a date',
        lastFailureKind: 'service_unavailable',
      },
    });

    expect(inspectBreaker(states, 'search:brave', NOW).open).toBe(false);
  });

  it('should tolerate any shape in storage', () => {
    expect(toBreakerStates(null)).toEqual({});
    expect(toBreakerStates('nonsense')).toEqual({});
    expect(toBreakerStates([1, 2, 3])).toEqual({});
    expect(toBreakerStates({ 'search:brave': 7 })).toEqual({});
  });
});
