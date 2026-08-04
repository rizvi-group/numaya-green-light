import { clamp01, daysBetween, roundTo } from 'src/scoring/rules/helpers';
import type { ScoringRule } from 'src/scoring/types';

/** Tolerance for clock skew between systems, in days. */
const FUTURE_TOLERANCE_DAYS = 1;

export const dataFreshnessRule: ScoringRule = {
  id: 'data.freshness',
  name: 'Data still in date',
  category: 'data-quality',
  question: 'Was this lead verified recently enough to trust?',
  why: 'People change jobs, companies move, numbers get reassigned. A contact captured two years ago is not a lead, it is a historical record — and a rep who works it wastes the call and looks unprepared.',
  defaultEnabled: true,
  defaultSeverity: 'minor',
  defaultWeight: 10,
  reads: ['lastVerifiedAt'],

  evaluate: ({ config, now, read }) => {
    if (now === null) {
      return {
        outcome: 'not_applicable',
        explanation:
          'The current date was not available for this run, so the age of this lead could not be checked.',
      };
    }

    const shelfLifeDays =
      config.fieldShelfLifeDays.lastVerifiedAt ?? config.defaultShelfLifeDays;

    const verifiedAt = read.date('lastVerifiedAt');

    if (verifiedAt === null) {
      return {
        outcome: 'fail',
        explanation:
          'Nothing on this lead records when its details were last checked, so we have to assume they are stale.',
        remedy: `Set a last-verified date, or map Greenlight's "last verified" field to a date your workspace already maintains. Your shelf life is ${shelfLifeDays} days.`,
        detail: { shelfLifeDays },
      };
    }

    const ageDays = daysBetween(verifiedAt, now);

    if (ageDays < -FUTURE_TOLERANCE_DAYS) {
      return {
        outcome: 'fail',
        explanation: `This lead says it was verified on ${verifiedAt.toISOString().slice(0, 10)}, which is in the future — the date is wrong.`,
        remedy: 'Correct the last-verified date.',
        detail: { verifiedAt: verifiedAt.toISOString(), shelfLifeDays },
      };
    }

    const age = Math.max(0, ageDays);

    if (age <= shelfLifeDays) {
      return {
        outcome: 'pass',
        explanation: `Last verified ${roundTo(age, 1)} days ago, inside your ${shelfLifeDays}-day shelf life.`,
        detail: { ageDays: roundTo(age, 1), shelfLifeDays },
      };
    }

    if (age < shelfLifeDays * 2) {
      const credit = clamp01(1 - (age - shelfLifeDays) / shelfLifeDays);

      return {
        outcome: 'partial',
        credit,
        explanation: `Last verified ${roundTo(age, 1)} days ago, past your ${shelfLifeDays}-day shelf life but not yet twice over.`,
        remedy: 'Re-check the contact details before a rep spends time on this lead.',
        detail: { ageDays: roundTo(age, 1), shelfLifeDays },
      };
    }

    return {
      outcome: 'fail',
      explanation: `Last verified ${roundTo(age, 1)} days ago — more than twice your ${shelfLifeDays}-day shelf life.`,
      remedy: 'Re-verify the contact and company details, or retire the lead.',
      detail: { ageDays: roundTo(age, 1), shelfLifeDays },
    };
  },
};
