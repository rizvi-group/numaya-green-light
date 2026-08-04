import { isPlaceholder } from 'src/scoring/field-access';
import type { ScoringRule } from 'src/scoring/types';

export const companyIdentifiedRule: ScoringRule = {
  id: 'company.identified',
  name: 'Company named',
  category: 'contact',
  question: 'Do we know which company this lead works for?',
  why: 'Every other qualification question — industry, size, region, territory, existing customer — depends on knowing the company. A lead with no company is a name floating in space, and a rep has nothing to research before they call.',
  defaultEnabled: true,
  defaultSeverity: 'major',
  defaultWeight: 10,
  reads: ['companyName'],

  evaluate: ({ config, read }) => {
    const name = read.text('companyName');

    if (name === null) {
      return {
        outcome: 'fail',
        explanation: 'No company is recorded on this lead.',
        remedy: 'Add the company name, or link the lead to a company record.',
      };
    }

    if (isPlaceholder(name, config.placeholderValues) || name.trim().length < 2) {
      return {
        outcome: 'fail',
        explanation: `"${name}" is a placeholder rather than a real company name.`,
        remedy: 'Replace it with the real company name.',
        detail: { companyName: name },
      };
    }

    return {
      outcome: 'pass',
      explanation: `The lead is attributed to ${name}.`,
      detail: { companyName: name },
    };
  },
};
