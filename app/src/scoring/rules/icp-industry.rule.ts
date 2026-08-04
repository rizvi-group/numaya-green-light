import { matchesList } from 'src/scoring/rules/helpers';
import type { ScoringRule } from 'src/scoring/types';

export const icpIndustryRule: ScoringRule = {
  id: 'icp.industry',
  name: 'Target industry',
  category: 'icp',
  question: 'Is this company in an industry you sell to?',
  why: 'Reps burn the most time on companies that were never going to buy. Industry is the cheapest, most reliable filter you have, and it is the one your team argues about most.',
  defaultEnabled: true,
  defaultSeverity: 'major',
  defaultWeight: 20,
  reads: ['industry', 'companyName'],

  evaluate: ({ config, read }) => {
    const targets = config.icp.industries;

    if (targets.length === 0) {
      return {
        outcome: 'not_applicable',
        explanation:
          'You have not listed any target industries, so every industry is accepted.',
        remedy:
          'Add your target industries to the Greenlight ICP settings to start filtering on industry.',
      };
    }

    const values = read.textList('industry');

    if (values.length === 0) {
      return {
        outcome: 'fail',
        explanation:
          'This lead has no industry recorded, so we cannot tell whether it is in a market you sell to.',
        remedy: 'Set the industry on the lead or its company record.',
        detail: { targetIndustries: targets.join(', ') },
      };
    }

    const matched = matchesList(values, targets);

    if (matched !== null) {
      return {
        outcome: 'pass',
        explanation: `${matched} is one of your target industries.`,
        detail: { industry: matched },
      };
    }

    return {
      outcome: 'fail',
      explanation: `${values.join(', ')} is not one of your target industries.`,
      remedy: `Add it to your target industries if you do sell there. Your current list is: ${targets.join(', ')}.`,
      detail: { industry: values.join(', '), targetIndustries: targets.join(', ') },
    };
  },
};
