import { isPlaceholder } from 'src/scoring/field-access';
import type { ScoringRule } from 'src/scoring/types';

export const contactNamedPersonRule: ScoringRule = {
  id: 'contact.named-person',
  name: 'Named contact',
  category: 'contact',
  question: 'Is there a real human being to call?',
  why: 'A rep cannot open a conversation with an organisation. Leads without a named person become "whoever picks up", which is the lowest-converting outreach there is.',
  defaultEnabled: true,
  defaultSeverity: 'minor',
  defaultWeight: 8,
  reads: ['contactName'],

  evaluate: ({ config, read }) => {
    const name = read.text('contactName');

    if (name === null) {
      return {
        outcome: 'fail',
        explanation: 'No contact name is recorded, so there is no one to address.',
        remedy: 'Add the first and last name of the person to contact.',
      };
    }

    if (isPlaceholder(name, config.placeholderValues) || !/[a-z]/i.test(name)) {
      return {
        outcome: 'fail',
        explanation: `"${name}" is a placeholder rather than a person's name.`,
        remedy: "Replace it with the contact's real name.",
        detail: { contactName: name },
      };
    }

    const parts = name
      .trim()
      .split(/\s+/)
      .filter((part) => /[a-z]/i.test(part));

    if (parts.length < 2) {
      return {
        outcome: 'partial',
        credit: 0.5,
        explanation: `Only a first name ("${name}") is recorded — enough to greet someone, not enough to find them.`,
        remedy: 'Add the surname so the rep can verify the person before reaching out.',
        detail: { contactName: name },
      };
    }

    return {
      outcome: 'pass',
      explanation: `${name} is a named contact.`,
      detail: { contactName: name },
    };
  },
};
