import {
  assessBudget,
  currentBudgetState,
  describeBudgetAlert,
  monthKeyOf,
} from 'src/enrichment';
import { describe, expect, it } from 'vitest';

const AUGUST = new Date('2026-08-03T09:00:00.000Z');
const SEPTEMBER = new Date('2026-09-01T00:00:00.000Z');

describe('monthKeyOf', () => {
  it('should key on the UTC month', () => {
    expect(monthKeyOf(AUGUST)).toBe('2026-08');
    // 23:30 on 31 December in UTC+2 is still December in UTC, and the counter
    // must not roll over twice because a worker happened to run in Berlin.
    expect(monthKeyOf(new Date('2026-12-31T23:30:00.000Z'))).toBe('2026-12');
  });
});

describe('currentBudgetState', () => {
  it('should start a fresh month when nothing is stored', () => {
    expect(currentBudgetState(null, AUGUST)).toEqual({
      monthKey: '2026-08',
      used: 0,
      alertedAt: 0,
    });
  });

  it('should roll over when the stored month is not this one', () => {
    const stored = { monthKey: '2026-07', used: 999, alertedAt: 95 };

    expect(currentBudgetState(stored, AUGUST)).toEqual({
      monthKey: '2026-08',
      used: 0,
      alertedAt: 0,
    });
  });

  it('should repair a nonsensical counter rather than trust it', () => {
    const stored = { monthKey: '2026-08', used: Number.NaN, alertedAt: -3 };

    expect(currentBudgetState(stored, AUGUST)).toEqual({
      monthKey: '2026-08',
      used: 0,
      alertedAt: 0,
    });
  });
});

describe('assessBudget', () => {
  it('should allow a run and charge it when there is headroom', () => {
    const assessment = assessBudget({ monthKey: '2026-08', used: 10, alertedAt: 0 }, 100, AUGUST);

    expect(assessment.allowed).toBe(true);
    expect(assessment.remaining).toBe(90);
    expect(assessment.next.used).toBe(11);
  });

  it('should refuse once the cap is reached, and not charge', () => {
    const assessment = assessBudget(
      { monthKey: '2026-08', used: 100, alertedAt: 100 },
      100,
      AUGUST,
    );

    expect(assessment.allowed).toBe(false);
    expect(assessment.remaining).toBe(0);
    expect(assessment.next.used).toBe(100);
  });

  it('should treat a cap of zero as a refusal, not as unlimited', () => {
    const assessment = assessBudget(null, 0, AUGUST);

    expect(assessment.allowed).toBe(false);
    expect(assessment.next.used).toBe(0);
  });

  it('should allow again after the month rolls over', () => {
    const exhausted = { monthKey: '2026-08', used: 100, alertedAt: 100 };

    expect(assessBudget(exhausted, 100, SEPTEMBER).allowed).toBe(true);
    expect(assessBudget(exhausted, 100, SEPTEMBER).next.monthKey).toBe('2026-09');
  });

  it('should raise each alert threshold exactly once', () => {
    const at69 = assessBudget({ monthKey: '2026-08', used: 69, alertedAt: 0 }, 100, AUGUST);

    expect(at69.newAlert).toBe(70);

    // The next run is above 70% but the threshold has already been announced.
    const at70 = assessBudget(
      { monthKey: '2026-08', used: 70, alertedAt: 70 },
      100,
      AUGUST,
    );

    expect(at70.newAlert).toBeNull();
  });

  it('should announce the highest threshold when several are crossed at once', () => {
    // A cap of 2 jumps straight from 50% to 100%.
    const assessment = assessBudget({ monthKey: '2026-08', used: 1, alertedAt: 0 }, 2, AUGUST);

    expect(assessment.newAlert).toBe(100);
    expect(assessment.next.alertedAt).toBe(100);
  });

  it('should describe the alert in words an admin can act on', () => {
    const assessment = assessBudget({ monthKey: '2026-08', used: 1, alertedAt: 0 }, 2, AUGUST);
    const message = describeBudgetAlert(assessment);

    expect(message).toContain('full monthly allowance');
    expect(message).toContain('September 2026');
    expect(message).toContain('scoring continues');
  });

  it('should say nothing when no threshold was crossed', () => {
    const assessment = assessBudget({ monthKey: '2026-08', used: 1, alertedAt: 0 }, 100, AUGUST);

    expect(describeBudgetAlert(assessment)).toBeNull();
  });
});
