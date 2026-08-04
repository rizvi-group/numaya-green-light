import { firstKeywordMatch } from 'src/scoring/rules/helpers';
import type { ScoringRule } from 'src/scoring/types';

export const contactDecisionMakerRule: ScoringRule = {
  id: 'contact.decision-maker',
  name: 'Decision-maker',
  category: 'contact',
  question: 'Can this person say yes, or at least get you in front of the person who can?',
  why: 'The single biggest predictor of a deal is talking to someone with budget authority. A perfect-fit company represented by someone with no say costs a rep the same hours as a real opportunity and closes none of them.',
  defaultEnabled: true,
  defaultSeverity: 'major',
  defaultWeight: 20,
  reads: ['seniority', 'jobTitle'],

  evaluate: ({ config, read }) => {
    const seniority = read.text('seniority');
    const jobTitle = read.text('jobTitle');
    const subject = seniority ?? jobTitle;

    if (subject === null) {
      return {
        outcome: 'fail',
        explanation:
          'No job title is recorded, so we cannot tell whether this person can authorise a purchase.',
        remedy: "Add the contact's job title.",
      };
    }

    const decisionMaker = firstKeywordMatch(subject, config.decisionMakerTitles);

    if (decisionMaker !== null) {
      return {
        outcome: 'pass',
        explanation: `"${subject}" indicates buying authority.`,
        detail: { title: subject, matchedKeyword: decisionMaker },
      };
    }

    const influencer = firstKeywordMatch(subject, config.influencerTitles);

    if (influencer !== null) {
      return {
        outcome: 'partial',
        credit: 0.5,
        explanation: `"${subject}" is likely an influencer rather than the person who signs.`,
        remedy:
          'Work this contact as a route in, and find the budget holder above them before forecasting the deal.',
        detail: { title: subject, matchedKeyword: influencer },
      };
    }

    return {
      outcome: 'fail',
      explanation: `"${subject}" does not look like someone who can authorise a purchase.`,
      remedy:
        'Find a contact with budget authority at this company, or add their title keyword to your decision-maker list if it belongs there.',
      detail: { title: subject },
    };
  },
};
