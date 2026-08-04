/**
 * The per-workspace spend cap, and the alert ladder on the way up to it.
 *
 * Pure: the month is derived from the `now` handed in, never from the clock, so
 * the rollover boundary is a value a test can sit either side of.
 *
 * ## Why a counter and not a ledger
 *
 * PRODUCT_SPEC asks for a "hard per-tenant spend cap + alerts (70/85/95% →
 * 100%)". What is counted here is **runs that reached a provider**, not tokens
 * and not currency. Three reasons, in order of how much they matter:
 *
 *  1. Greenlight never sees a price. The LLM and the search key are the
 *     customer's; the bill goes to them, in their currency, on their contract.
 *     A cap denominated in money would be a number this app invented.
 *  2. `MONTHLY_ENRICHMENT_CAP` is already declared as a run count in
 *     `application-config.ts`, and ARCHITECTURE.md's Path 2 step 8 says
 *     "increment per-workspace enrichment counter". Matching the shipped
 *     variable beats inventing a second unit next to it.
 *  3. A run count is the unit an admin can reason about — "a thousand leads a
 *     month" — without knowing what a token is.
 *
 * A run is charged **once**, when it first reaches a provider, and the search
 * call is what marks it. Charging per LLM call would make the cap depend on
 * whether the verification tier happened to be reachable, which would mean the
 * same thousand leads cost a different amount of budget on a bad day.
 */

import type { EnrichmentBudgetState } from 'src/enrichment/types';

/** The thresholds PRODUCT_SPEC names, as percentages of the cap. */
export const BUDGET_ALERT_THRESHOLDS: readonly number[] = [70, 85, 95, 100];

/** `YYYY-MM` in UTC. UTC, not local: a logic function has no user's timezone. */
export const monthKeyOf = (now: Date): string => {
  const year = now.getUTCFullYear().toString().padStart(4, '0');
  const month = (now.getUTCMonth() + 1).toString().padStart(2, '0');

  return `${year}-${month}`;
};

export interface BudgetAssessment {
  readonly monthKey: string;
  readonly cap: number;
  readonly used: number;
  readonly remaining: number;
  /** False when the cap is exhausted, or the cap is zero. */
  readonly allowed: boolean;
  /** Percentage of cap used, rounded down. `0` when the cap is unlimited-by-zero. */
  readonly percentUsed: number;
  /** The highest threshold newly crossed by this assessment, or null. */
  readonly newAlert: number | null;
  /** The state to persist if this run is charged. */
  readonly next: EnrichmentBudgetState;
}

const emptyState = (monthKey: string): EnrichmentBudgetState => ({
  monthKey,
  used: 0,
  alertedAt: 0,
});

/**
 * Read a stored counter, rolling it over when the month has changed.
 *
 * An unreadable or absent state is a fresh month at zero. That is the generous
 * direction, and it is the right one: the alternative — treating an unreadable
 * counter as "cap reached" — would turn one bad key-value read into a workspace
 * that silently stopped enriching until someone noticed. The cap exists to bound
 * a bill, not to be a kill switch that trips on storage noise.
 */
export const currentBudgetState = (
  stored: EnrichmentBudgetState | null,
  now: Date,
): EnrichmentBudgetState => {
  const monthKey = monthKeyOf(now);

  if (stored === null || stored.monthKey !== monthKey) {
    return emptyState(monthKey);
  }

  const used = Number.isFinite(stored.used) && stored.used > 0 ? Math.floor(stored.used) : 0;
  const alertedAt =
    Number.isFinite(stored.alertedAt) && stored.alertedAt > 0
      ? Math.floor(stored.alertedAt)
      : 0;

  return { monthKey, used, alertedAt };
};

/**
 * Would one more run be allowed, and does charging it cross an alert line?
 *
 * `cap === 0` means "enrichment off this month" and is honoured as a refusal,
 * not read as unlimited. That reading is deliberate and is the same failure
 * direction as everywhere else on this path: a zero an admin typed should stop
 * spending, and a zero nobody typed cannot occur because
 * `readEnrichmentEnvironment` never produces one from an unparseable value.
 */
export const assessBudget = (
  stored: EnrichmentBudgetState | null,
  cap: number,
  now: Date,
): BudgetAssessment => {
  const state = currentBudgetState(stored, now);
  const safeCap = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0;
  const used = state.used;
  const remaining = Math.max(0, safeCap - used);
  const allowed = safeCap > 0 && used < safeCap;

  const chargedUsed = allowed ? used + 1 : used;
  const percentUsed =
    safeCap === 0 ? 0 : Math.min(100, Math.floor((chargedUsed / safeCap) * 100));

  const crossed = BUDGET_ALERT_THRESHOLDS.filter(
    (threshold) => percentUsed >= threshold && threshold > state.alertedAt,
  );
  const newAlert = crossed.length === 0 ? null : Math.max(...crossed);

  return {
    monthKey: state.monthKey,
    cap: safeCap,
    used,
    remaining,
    allowed,
    percentUsed,
    newAlert,
    next: {
      monthKey: state.monthKey,
      used: chargedUsed,
      alertedAt: newAlert ?? state.alertedAt,
    },
  };
};

/** One sentence for the CRM, for whichever threshold was crossed. */
export const describeBudgetAlert = (
  assessment: BudgetAssessment,
): string | null => {
  if (assessment.newAlert === null) {
    return null;
  }

  if (assessment.newAlert >= 100) {
    return `Greenlight enrichment has used its full monthly allowance of ${assessment.cap} runs. Enrichment is paused until ${nextMonthLabel(assessment.monthKey)}; scoring continues as normal.`;
  }

  return `Greenlight enrichment has used ${assessment.newAlert}% of its monthly allowance (${assessment.next.used} of ${assessment.cap} runs).`;
};

const nextMonthLabel = (monthKey: string): string => {
  const [yearPart, monthPart] = monthKey.split('-');
  const year = Number(yearPart);
  const month = Number(monthPart);

  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    return 'next month';
  }

  return month === 12 ? `January ${year + 1}` : `${MONTH_NAMES[month + 1]} ${year}`;
};

const MONTH_NAMES: readonly string[] = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
