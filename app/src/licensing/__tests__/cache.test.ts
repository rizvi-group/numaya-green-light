import {
  cacheAgeMs,
  classifyCache,
  classifyCacheAge,
  LICENCE_CACHE_TTL_MS,
  LICENCE_OFFLINE_GRACE_LIMIT_MS,
} from 'src/licensing/cache';
import { hoursBefore, NOW } from 'src/licensing/__tests__/fixtures';
import { describe, expect, it } from 'vitest';

describe('cache windows', () => {
  it('should use the windows the integration note specifies', () => {
    expect(LICENCE_CACHE_TTL_MS).toBe(24 * 3_600_000);
    expect(LICENCE_OFFLINE_GRACE_LIMIT_MS).toBe(72 * 3_600_000);
  });

  it('should classify a cache younger than 24h as fresh', () => {
    expect(classifyCacheAge(0)).toBe('fresh');
    expect(classifyCacheAge(23 * 3_600_000)).toBe('fresh');
  });

  it('should classify 24h exactly as already in grace', () => {
    // The boundary belongs to the stricter band so that "fresh means strictly
    // under a day old" is true as stated rather than approximately true.
    expect(classifyCacheAge(LICENCE_CACHE_TTL_MS)).toBe('grace');
  });

  it('should classify the 24-72h band as grace', () => {
    expect(classifyCacheAge(48 * 3_600_000)).toBe('grace');
    expect(classifyCacheAge(LICENCE_OFFLINE_GRACE_LIMIT_MS - 1)).toBe('grace');
  });

  it('should classify 72h exactly, and beyond, as expired', () => {
    expect(classifyCacheAge(LICENCE_OFFLINE_GRACE_LIMIT_MS)).toBe('expired');
    expect(classifyCacheAge(1000 * 3_600_000)).toBe('expired');
  });
});

describe('cache age', () => {
  it('should measure age from cachedAt against the injected clock', () => {
    expect(cacheAgeMs(hoursBefore(5).toISOString(), NOW)).toBe(5 * 3_600_000);
  });

  it('should return null for a missing or unparseable cachedAt', () => {
    expect(cacheAgeMs(null, NOW)).toBeNull();
    expect(cacheAgeMs(undefined, NOW)).toBeNull();
    expect(cacheAgeMs('', NOW)).toBeNull();
    expect(cacheAgeMs('last tuesday', NOW)).toBeNull();
  });

  it('should clamp a future cachedAt to zero rather than rejecting it', () => {
    // A licensing service whose clock is a few seconds ahead must not make a
    // workspace look like it has never validated.
    const future = new Date(NOW.getTime() + 30_000).toISOString();

    expect(cacheAgeMs(future, NOW)).toBe(0);
    expect(classifyCache(future, NOW).freshness).toBe('fresh');
  });
});

describe('classifyCache', () => {
  it('should distinguish "no cache at all" from "expired cache"', () => {
    expect(classifyCache(null, NOW)).toEqual({ freshness: null, ageMs: null });
    expect(classifyCache(hoursBefore(100).toISOString(), NOW).freshness).toBe(
      'expired',
    );
  });
});
