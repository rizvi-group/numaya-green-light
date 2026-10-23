import { matchesList } from 'src/scoring/rules/helpers';
import type { ScoringRule } from 'src/scoring/types';

/**
 * The industry value that means "never work with this company", as a hard stop.
 *
 * ## What it reads, and what it deliberately does not
 *
 * Workspaces that keep an exclusion policy — markets the company has decided
 * never to sell into — can tag the offending Company records with the
 * `EXCLUDED` industry value. This rule turns that tag into a `blocked` gate
 * decision: the lead is stopped whatever it scores, exactly like a compliance
 * stop, because "we do not work with this market" is not a statement about lead
 * quality that a better score can outrank.
 *
 * The rule matches **only** the literal `EXCLUDED` value, through the same
 * `matchesList` normalisation every other list rule uses. It is deliberately
 * not a configurable list of excluded industries: anything a workspace wants to
 * express as "not a fit but not forbidden" already has a home — leave the
 * industry off the ICP target list and `icp.industry` scores it as a miss. A
 * second, softer exclusion list would give two settings that mean nearly the
 * same thing and disagree at the edges.
 *
 * `GOVERNMENT_EDUCATION` — or any other industry — can never trip this rule,
 * because the only string it blocks is `EXCLUDED`. Public-sector work is a
 * market this pattern exists to chase through the front door, not hold at it.
 *
 * ## Empty industry must not block
 *
 * No industry recorded means the question could not be answered, not that the
 * answer is bad. Following the compliance rule's treatment of an unread
 * register, the rule returns `not_applicable`: it neither blocks the lead nor
 * joins the score. A workspace that has not tagged anything `EXCLUDED` yet —
 * which is every workspace on the day this ships — must see nothing change.
 *
 * ## Weight 0, on purpose
 *
 * A blocking rule already decides the outcome on its own; giving it scoring
 * weight as well double-counts it (the HANDOFF makes exactly this criticism of
 * `compliance.opt-out`'s 15 points). So this rule is a pure gate: weight 0,
 * contributing nothing to either side of the score, visible in the trace as the
 * reason a lead is blocked rather than as points anything earned.
 */
const EXCLUDED_INDUSTRY_VALUES: readonly string[] = ['EXCLUDED'];

export const industryExcludedRule: ScoringRule = {
  id: 'icp.industry-excluded',
  name: 'Not an excluded industry',
  category: 'icp',
  question: 'Has this company been marked as one we do not work with?',
  why: 'Some markets are closed by policy, not by fit — a perfect lead in one is still a lead nobody should spend time on. Tagging a company with the EXCLUDED industry makes that decision once, and this check enforces it on every lead from that company whatever they score.',
  defaultEnabled: true,
  defaultSeverity: 'blocking',
  defaultWeight: 0,
  reads: ['industry'],

  evaluate: ({ read }) => {
    const values = read.textList('industry');

    if (values.length === 0) {
      return {
        outcome: 'not_applicable',
        explanation:
          'This lead has no industry recorded, so Greenlight could not check whether its company is excluded, and the check was left out rather than blocking by default.',
        remedy: 'Set the industry on the lead or its company record.',
      };
    }

    if (matchesList(values, EXCLUDED_INDUSTRY_VALUES) !== null) {
      return {
        outcome: 'fail',
        explanation:
          'This company is marked EXCLUDED, so it is in a market your workspace has decided not to work with. The lead is blocked whatever it scores.',
        remedy:
          'Do not work this lead. If the EXCLUDED tag is wrong, correct the industry on the company record and the lead re-scores.',
        detail: { industry: values.join(', '), excluded: true },
      };
    }

    return {
      outcome: 'pass',
      explanation: `${values.join(', ')} is not an excluded industry, so this lead is free to score on its merits.`,
      detail: { industry: values.join(', '), excluded: false },
    };
  },
};
