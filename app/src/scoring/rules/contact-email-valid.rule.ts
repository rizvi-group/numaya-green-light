import { parseEmail } from 'src/scoring/rules/helpers';
import type { ScoringRule } from 'src/scoring/types';

export const contactEmailValidRule: ScoringRule = {
  id: 'contact.email-valid',
  name: 'Usable email address',
  category: 'contact',
  question: 'Is there an email address that will actually deliver?',
  why: 'Email is how most first contact happens. A missing or malformed address means the outreach silently fails and the rep never learns why — the lead just looks unresponsive.',
  defaultEnabled: true,
  defaultSeverity: 'critical',
  defaultWeight: 15,
  reads: ['email'],

  evaluate: ({ read }) => {
    const candidates = read.textList('email');

    if (candidates.length === 0) {
      return {
        outcome: 'fail',
        explanation: 'No email address is recorded, so this lead cannot be emailed.',
        remedy: "Add the contact's email address.",
      };
    }

    const parsed = candidates
      .map((candidate) => parseEmail(candidate))
      .find((candidate) => candidate !== null);

    if (parsed === undefined || parsed === null) {
      return {
        outcome: 'fail',
        explanation: `"${candidates[0] ?? ''}" is not a valid email address, so anything sent to it will bounce.`,
        remedy: 'Correct the email address.',
        detail: { email: candidates[0] ?? null },
      };
    }

    return {
      outcome: 'pass',
      explanation: `${parsed.address} is a well-formed email address.`,
      detail: { email: parsed.address, domain: parsed.domain },
    };
  },
};
