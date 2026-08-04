import { matchesList } from 'src/scoring/rules/helpers';
import type { ScoringRule } from 'src/scoring/types';

export const icpRegionRule: ScoringRule = {
  id: 'icp.region',
  name: 'Target region',
  category: 'icp',
  question: 'Is this company somewhere you can actually sell and deliver?',
  why: 'A perfect-fit company in a territory you do not cover is a perfect-fit company for someone else. Region also drives who the lead should be routed to.',
  defaultEnabled: true,
  defaultSeverity: 'major',
  defaultWeight: 10,
  reads: ['region'],

  evaluate: ({ config, read }) => {
    const targets = config.icp.regions;

    if (targets.length === 0) {
      return {
        outcome: 'not_applicable',
        explanation:
          'You have not listed any target regions, so every region is accepted.',
        remedy:
          'Add the regions you sell into to the Greenlight ICP settings to start filtering on region.',
      };
    }

    const values = read.textList('region');

    if (values.length === 0) {
      return {
        outcome: 'fail',
        explanation:
          'This lead has no country or region recorded, so we cannot tell whether you cover it.',
        remedy: 'Set the country or region on the lead.',
        detail: { targetRegions: targets.join(', ') },
      };
    }

    const matched = matchesList(values, targets);

    if (matched !== null) {
      return {
        outcome: 'pass',
        explanation: `${matched} is a region you sell into.`,
        detail: { region: matched },
      };
    }

    return {
      outcome: 'fail',
      explanation: `${values.join(', ')} is outside the regions you sell into.`,
      remedy: `Add it to your target regions if you do cover it. Your current list is: ${targets.join(', ')}.`,
      detail: { region: values.join(', '), targetRegions: targets.join(', ') },
    };
  },
};
