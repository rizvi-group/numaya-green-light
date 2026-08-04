import type { ScoringRule } from 'src/scoring/types';

export const icpCompanySizeRule: ScoringRule = {
  id: 'icp.company-size',
  name: 'Target company size',
  category: 'icp',
  question: 'Is this company the size you sell to?',
  why: 'Company size decides whether your pricing, contract and onboarding fit at all. Too small and the deal will not clear your floor; too large and the sales motion is a different product.',
  defaultEnabled: true,
  defaultSeverity: 'minor',
  defaultWeight: 10,
  reads: ['employeeCount'],

  evaluate: ({ config, read }) => {
    const bands = config.icp.sizeBands;

    if (bands.length === 0) {
      return {
        outcome: 'not_applicable',
        explanation:
          'You have not defined any target company-size bands, so every company size is accepted.',
        remedy:
          'Define your target size bands in the Greenlight ICP settings to start filtering on headcount.',
      };
    }

    const employees = read.number('employeeCount');

    if (employees === null) {
      return {
        outcome: 'fail',
        explanation:
          'This lead has no company size recorded, so we cannot tell whether the company is the size you sell to.',
        remedy: 'Set the employee count on the lead or its company record.',
      };
    }

    const matched = bands.find(
      (band) =>
        employees >= band.minEmployees &&
        (band.maxEmployees === null || employees <= band.maxEmployees),
    );

    if (matched !== undefined) {
      return {
        outcome: 'pass',
        explanation: `${employees} employees puts this company in your "${matched.label}" target band.`,
        detail: { employees, band: matched.label },
      };
    }

    return {
      outcome: 'fail',
      explanation: `${employees} employees falls outside every target size band you defined.`,
      remedy: `Widen a size band if you do sell to companies this size. Your bands are: ${bands
        .map((band) => band.label)
        .join(', ')}.`,
      detail: { employees },
    };
  },
};
