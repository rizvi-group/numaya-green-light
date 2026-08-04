import { emailLocalRoot, parseEmail } from 'src/scoring/rules/helpers';
import type { ScoringRule } from 'src/scoring/types';

export const contactSharedInboxRule: ScoringRule = {
  id: 'contact.shared-inbox',
  name: 'Personal mailbox',
  category: 'contact',
  question: 'Does the email address belong to a person, or to a shared inbox?',
  why: 'A shared inbox — info@, sales@, enquiries@ — has no owner and no accountability, so replies are nobody\'s job. These addresses look like a contactable lead in a report and behave like a dead end in practice.',
  defaultEnabled: true,
  defaultSeverity: 'minor',
  defaultWeight: 7,
  reads: ['email'],

  evaluate: ({ config, read }) => {
    const candidates = read.textList('email');
    const parsed = candidates
      .map((candidate) => parseEmail(candidate))
      .find((candidate) => candidate !== null);

    if (parsed === undefined || parsed === null) {
      return {
        outcome: 'not_applicable',
        explanation:
          'There is no usable email address to judge, so this check was skipped — the email rule already covers it.',
      };
    }

    const root = emailLocalRoot(parsed.localPart);

    if (config.roleInboxLocalParts.includes(root)) {
      return {
        outcome: 'fail',
        explanation: `${parsed.address} is a shared "${root}@" inbox, so no particular person owns a reply.`,
        remedy:
          'Find a named person at this company and use their direct address. Keep the shared inbox as a fallback only.',
        detail: { email: parsed.address, mailbox: root },
      };
    }

    return {
      outcome: 'pass',
      explanation: `${parsed.address} looks like a personal mailbox, so a named person will see it.`,
      detail: { email: parsed.address, mailbox: root },
    };
  },
};
