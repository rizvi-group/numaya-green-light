import type { ScoringRule } from 'src/scoring/types';

const MIN_DIGITS = 7;
const MAX_DIGITS = 15;

export const contactPhoneValidRule: ScoringRule = {
  id: 'contact.phone-valid',
  name: 'Dialable phone number',
  category: 'contact',
  question: 'Is there a phone number a rep could actually dial?',
  why: 'Phone is the fastest path to a real conversation and the fallback when email goes unanswered. A number with too few digits or a note typed into the field looks like coverage and gives none.',
  defaultEnabled: true,
  defaultSeverity: 'minor',
  defaultWeight: 5,
  reads: ['phone'],

  evaluate: ({ read }) => {
    const candidates = read.textList('phone');

    if (candidates.length === 0) {
      return {
        outcome: 'fail',
        explanation: 'No phone number is recorded, so this lead can only be reached by email.',
        remedy: "Add the contact's phone number.",
      };
    }

    const usable = candidates.find((candidate) => {
      const stripped = candidate.replace(/[\s().\-/]/g, '').replace(/^\+/, '');

      if (!/^\d+$/.test(stripped)) {
        return false;
      }

      return stripped.length >= MIN_DIGITS && stripped.length <= MAX_DIGITS;
    });

    if (usable === undefined) {
      return {
        outcome: 'fail',
        explanation: `"${candidates[0] ?? ''}" is not a number a rep could dial.`,
        remedy: `Correct the phone number — it needs between ${MIN_DIGITS} and ${MAX_DIGITS} digits, optionally with a country code.`,
        detail: { phone: candidates[0] ?? null },
      };
    }

    return {
      outcome: 'pass',
      explanation: `${usable} is a dialable phone number.`,
      detail: { phone: usable },
    };
  },
};
