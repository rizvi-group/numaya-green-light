import { describe, expect, it } from 'vitest';

import { DEFAULT_STAGE_DWELL_DAYS, MS_PER_DAY } from 'src/pipeline/criteria';
import { buildPipelineCard, nextAction } from 'src/pipeline/next-action';
import type {
  LeadSnapshot,
  NextActionInput,
  OpportunitySnapshot,
} from 'src/pipeline';

const NOW = new Date('2026-08-06T09:00:00.000Z');

const ago = (days: number): string =>
  new Date(NOW.getTime() - days * MS_PER_DAY).toISOString();

const DECISION_MAKER_PASSED = [
  {
    ruleId: 'contact.decision-maker',
    ruleName: 'Decision-maker',
    outcome: 'pass',
    severity: 'major',
    contributed: true,
    pointsEarned: 20,
    pointsPossible: 20,
    explanation: 'Priya Raman is Head of Operations, which can sign.',
  },
];

const aQualifiedLead = (overrides: Partial<LeadSnapshot> = {}): LeadSnapshot => ({
  id: 'f1a2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  displayName: 'Priya Raman',
  companyName: 'Northwind Logistics',
  decision: 'PASS',
  score: 82,
  email: 'priya@northwind.example',
  ...overrides,
});

const kinds = (input: NextActionInput, now: Date = NOW): readonly string[] =>
  nextAction(input, now).map((action) => action.kind);

/* -------------------------------------------------------------------------- */
/* Tier 1 — blockers are terminal                                              */
/* -------------------------------------------------------------------------- */

describe('nextAction — blockers', () => {
  it('should return the block and nothing else for a suppressed lead', () => {
    const actions = nextAction(
      {
        lead: aQualifiedLead({
          suppressed: true,
          suppressionReason: 'asked us to stop',
          companyName: null,
          email: null,
          score: 12,
        }),
      },
      NOW,
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe('CLEAR_THE_BLOCK');
    expect(actions[0]?.evidence).toContain('asked us to stop');
  });

  it('should return the block and nothing else for an opted-out lead', () => {
    const actions = nextAction(
      { lead: aQualifiedLead({ optedOut: true, companyName: null }) },
      NOW,
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe('CLEAR_THE_BLOCK');
  });

  it('should return the block and nothing else for a BLOCKED decision', () => {
    const actions = nextAction({ lead: aQualifiedLead({ decision: 'BLOCKED' }) }, NOW);

    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe('CLEAR_THE_BLOCK');
  });

  it('should suppress even the criteria of a live deal, because the lane is not the blocker', () => {
    const actions = nextAction(
      {
        lead: aQualifiedLead({ suppressed: true }),
        opportunity: { stage: 'MEETING', amount: null, closeDate: null },
      },
      NOW,
    );

    expect(actions.map((action) => action.kind)).toEqual(['CLEAR_THE_BLOCK']);
  });

  it('should never phrase a block as a sales action', () => {
    const actions = nextAction({ lead: aQualifiedLead({ optedOut: true }) }, NOW);

    expect(actions[0]?.sentence.startsWith('Do not work')).toBe(true);
    expect(actions[0]?.cheapness).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Tier 2 — missing exit criteria, cheapest first                              */
/* -------------------------------------------------------------------------- */

describe('nextAction — exit criteria', () => {
  it('should rank the cheapest missing criterion first', () => {
    const actions = nextAction(
      {
        lead: aQualifiedLead({
          companyName: null,
          companyId: null,
          email: null,
          score: 30,
        }),
      },
      NOW,
    );

    expect(actions.map((action) => action.kind)).toEqual([
      'LINK_THE_COMPANY',
      'FIND_AN_EMAIL',
      'STRENGTHEN_THE_RECORD',
    ]);
    expect(actions[0]?.reason).toContain('cheapest');
  });

  it('should prefer setting a close date to booking a meeting, as the spec says in as many words', () => {
    const actions = nextAction(
      {
        lead: aQualifiedLead(),
        opportunity: {
          stage: 'MEETING',
          amount: 12000,
          closeDate: null,
          lastDiscoveryCallAt: '2026-07-14T10:00:00.000Z',
          lastNoteAt: '2026-07-10T10:00:00.000Z',
        },
      },
      NOW,
    );

    expect(actions[0]?.kind).toBe('SET_THE_CLOSE_DATE');
    expect(actions[1]?.kind).toBe('LOG_THE_NOTE');
  });

  it('should hand the cheapness of the criterion through to the action', () => {
    const actions = nextAction(
      {
        lead: aQualifiedLead(),
        opportunity: { stage: 'MEETING', amount: null, closeDate: '2026-09-30' },
      },
      NOW,
    );

    expect(actions[0]?.kind).toBe('SET_THE_AMOUNT');
    expect(actions[0]?.cheapness).toBe(90);
  });

  it('should never turn an indeterminate criterion into an action', () => {
    // Nothing about this deal was loaded, so nothing about it can be demanded.
    const actions = nextAction(
      { lead: aQualifiedLead(), opportunity: { stage: 'MEETING' } },
      NOW,
    );

    expect(actions.every((action) => action.kind !== 'SET_THE_AMOUNT')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Tier 3 — enrichable gaps                                                    */
/* -------------------------------------------------------------------------- */

describe('nextAction — enrichable gaps', () => {
  it('should offer one enrichment action for all the gaps at once', () => {
    const actions = nextAction(
      {
        lead: aQualifiedLead({
          enrichableGaps: ['industry', 'employeeCount', 'region'],
        }),
      },
      NOW,
    );

    const enrich = actions.filter((action) => action.kind === 'ENRICH_THE_RECORD');

    expect(enrich).toHaveLength(1);
    expect(enrich[0]?.sentence).toContain('industry, company size and region');
    expect(enrich[0]?.sentence).toContain('Northwind Logistics');
  });

  it('should rank a gap below a missing exit criterion', () => {
    expect(
      kinds({
        lead: aQualifiedLead({ email: null, enrichableGaps: ['industry'] }),
      }),
    ).toEqual(['FIND_AN_EMAIL', 'ENRICH_THE_RECORD']);
  });

  it('should say nothing when there are no gaps to fill', () => {
    expect(kinds({ lead: aQualifiedLead({ enrichableGaps: [] }) })).not.toContain(
      'ENRICH_THE_RECORD',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Tier 4 — staleness                                                          */
/* -------------------------------------------------------------------------- */

describe('nextAction — staleness', () => {
  const inScreening = (enteredDaysAgo: number): NextActionInput => ({
    lead: aQualifiedLead({ trace: DECISION_MAKER_PASSED, ownerId: 'member-1' }),
    opportunity: {
      id: 'o-1',
      stage: 'SCREENING',
      stageEnteredAt: ago(enteredDaysAgo),
      lastDiscoveryCallAt: '2026-07-14T10:00:00.000Z',
    },
  });

  it('should stay quiet on the day the stage is expected to take', () => {
    const expected = DEFAULT_STAGE_DWELL_DAYS.screening ?? 0;

    expect(kinds(inScreening(expected))).not.toContain('CHASE_THE_STAGE');
  });

  it('should speak up the day after', () => {
    const expected = DEFAULT_STAGE_DWELL_DAYS.screening ?? 0;
    const actions = nextAction(inScreening(expected + 1), NOW);

    // Second, not first: this fixture also has every Screening criterion met, so
    // "ready to advance" leads and staleness follows it. That ordering is the
    // point — a card that has been sitting for fifteen days *because nobody
    // moved it* should be told to move, not chased. Chasing is what you do when
    // you cannot move.
    const stale = actions.find((action) => action.kind === 'CHASE_THE_STAGE');

    expect(actions[0]?.kind).toBe('ADVANCE_THE_CARD');
    expect(stale?.sentence).toContain('15 days');
    expect(stale?.sentence).toContain('14 days');
  });

  it('should lead with the chase when the stage is not ready to leave', () => {
    // The same overdue card with one criterion outstanding. Now there is nothing
    // to advance to, so staleness is the top of the list — and the unmet
    // criterion outranks it, because "book the discovery call" is what would
    // actually unstick the deal that chasing it is about.
    const expected = DEFAULT_STAGE_DWELL_DAYS.screening ?? 0;
    const actions = nextAction(
      {
        ...inScreening(expected + 1),
        opportunity: {
          id: 'o-1',
          stage: 'SCREENING',
          stageEnteredAt: ago(expected + 1),
          lastDiscoveryCallAt: null,
        },
      },
      NOW,
    );

    expect(actions.map((action) => action.kind)).not.toContain(
      'ADVANCE_THE_CARD',
    );
    expect(actions[0]?.kind).toBe('BOOK_A_MEETING');
    expect(actions.map((action) => action.kind)).toContain('CHASE_THE_STAGE');
  });

  it('should say nothing about a lane that never goes stale', () => {
    expect(
      kinds({
        lead: aQualifiedLead(),
        opportunity: { stage: 'CUSTOMER', stageEnteredAt: ago(900) },
      }),
    ).not.toContain('CHASE_THE_STAGE');
  });

  it('should say nothing about a card it cannot date', () => {
    expect(
      kinds({
        lead: aQualifiedLead({ trace: DECISION_MAKER_PASSED, ownerId: 'member-1' }),
        opportunity: { stage: 'SCREENING', lastDiscoveryCallAt: '2026-07-14T10:00:00.000Z' },
      }),
    ).not.toContain('CHASE_THE_STAGE');
  });

  it('should fall back to createdAt for a person-derived lane', () => {
    const actions = nextAction(
      { lead: aQualifiedLead({ createdAt: ago(30) }) },
      NOW,
    );

    expect(actions.map((action) => action.kind)).toContain('CHASE_THE_STAGE');
    expect(
      actions.find((action) => action.kind === 'CHASE_THE_STAGE')?.sentence,
    ).toContain('Qualified');
  });

  it('should say a single day in the singular', () => {
    const actions = nextAction(
      {
        lead: aQualifiedLead({ createdAt: ago(2) }),
        config: { stageDwellDays: { qualified: 1 } },
      },
      NOW,
    );

    expect(
      actions.find((action) => action.kind === 'CHASE_THE_STAGE')?.sentence,
    ).toContain('the 1 day this stage usually takes');
  });
});

/* -------------------------------------------------------------------------- */
/* Tier 5 — score band                                                         */
/* -------------------------------------------------------------------------- */

describe('nextAction — score band', () => {
  const weakTrace = {
    rules: [
      {
        ruleId: 'icp.region',
        ruleName: 'Target region',
        outcome: 'partial',
        severity: 'major',
        contributed: true,
        pointsEarned: 5,
        pointsPossible: 10,
        explanation: 'The region on the record is a country, not one of your target regions.',
        remedy: 'Set the region to one of your target regions, or widen the profile.',
      },
      {
        ruleId: 'icp.industry',
        ruleName: 'Target industry',
        outcome: 'pass',
        severity: 'major',
        contributed: true,
        pointsEarned: 19,
        pointsPossible: 20,
        explanation: 'Logistics matched on a synonym rather than exactly.',
      },
      {
        ruleId: 'contact.phone-valid',
        ruleName: 'Dialable phone number',
        outcome: 'fail',
        severity: 'minor',
        contributed: true,
        pointsEarned: 0,
        pointsPossible: 30,
        explanation: 'No phone number on the record.',
      },
    ],
  };

  it('should pick the weakest rule the lead still passes, not the one it failed', () => {
    const actions = nextAction({ lead: aQualifiedLead({ trace: weakTrace }) }, NOW);
    const band = actions.find((action) => action.kind === 'STRENGTHEN_THE_RECORD');

    expect(band?.evidence).toBe('Target region: 5 of 10 points');
    expect(band?.sentence).toContain('widen the profile');
  });

  it('should fall back to the explanation when a rule offers no remedy', () => {
    const actions = nextAction(
      {
        lead: aQualifiedLead({
          trace: { rules: [weakTrace.rules[1]] },
        }),
      },
      NOW,
    );

    expect(
      actions.find((action) => action.kind === 'STRENGTHEN_THE_RECORD')?.sentence,
    ).toContain('matched on a synonym');
  });

  it('should say nothing when every passing rule earned full credit', () => {
    expect(
      kinds({ lead: aQualifiedLead({ trace: { rules: DECISION_MAKER_PASSED } }) }),
    ).not.toContain('STRENGTHEN_THE_RECORD');
  });

  it('should break a tie on rule id, so the same trace always names the same rule', () => {
    const tied = {
      rules: [
        { ...weakTrace.rules[0], ruleId: 'zz.rule', ruleName: 'Zulu' },
        { ...weakTrace.rules[0], ruleId: 'aa.rule', ruleName: 'Alpha' },
      ],
    };

    const actions = nextAction({ lead: aQualifiedLead({ trace: tied }) }, NOW);

    expect(
      actions.find((action) => action.kind === 'STRENGTHEN_THE_RECORD')?.evidence,
    ).toContain('Alpha');
  });
});

/* -------------------------------------------------------------------------- */
/* The fallbacks                                                               */
/* -------------------------------------------------------------------------- */

describe('nextAction — when there is nothing wrong', () => {
  it('should offer to advance a card whose every criterion is met', () => {
    const actions = nextAction(
      {
        lead: aQualifiedLead({ trace: DECISION_MAKER_PASSED, ownerId: 'member-1' }),
        opportunity: { stage: 'NEW', stageEnteredAt: ago(1) },
      },
      NOW,
    );

    expect(actions.map((action) => action.kind)).toEqual(['ADVANCE_THE_CARD']);
    expect(actions[0]?.sentence).toContain('Screening');
    expect(actions[0]?.sentence).toContain('will not move it for you');
  });

  it('should say so plainly when a won deal needs nothing', () => {
    const actions = nextAction(
      {
        lead: aQualifiedLead(),
        opportunity: { stage: 'CUSTOMER', stageEnteredAt: ago(3) },
      },
      NOW,
    );

    expect(actions.map((action) => action.kind)).toEqual(['NOTHING_TO_DO']);
    expect(actions[0]?.sentence).toContain('closed');
  });

  it('should never return an empty list', () => {
    expect(nextAction({ lead: {} }, NOW).length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Fail-open                                                                   */
/* -------------------------------------------------------------------------- */

describe('nextAction — fail-open', () => {
  it('should survive an empty input', () => {
    const actions = nextAction({ lead: {} }, NOW);

    expect(actions).toHaveLength(1);
    expect(actions[0]?.sentence.length).toBeGreaterThan(20);
  });

  it('should survive a lead that is not an object', () => {
    expect(() =>
      nextAction({ lead: null as unknown as LeadSnapshot }, NOW),
    ).not.toThrow();
  });

  it('should survive an unusable clock without inventing a staleness action', () => {
    const actions = nextAction(
      { lead: aQualifiedLead({ createdAt: ago(400) }) },
      new Date('not a date'),
    );

    expect(actions.map((action) => action.kind)).not.toContain('CHASE_THE_STAGE');
  });

  it('should survive a malformed trace', () => {
    expect(() =>
      nextAction({ lead: aQualifiedLead({ trace: 'not json at all' }) }, NOW),
    ).not.toThrow();
  });

  it('should survive a malformed configuration record', () => {
    expect(() =>
      nextAction({ lead: aQualifiedLead(), config: 'nonsense' }, NOW),
    ).not.toThrow();
  });

  it('should report its own failure rather than an action derived from half a pass', () => {
    const exploding = {} as LeadSnapshot;

    Object.defineProperty(exploding, 'suppressed', {
      enumerable: true,
      get: () => {
        throw new Error('reader exploded');
      },
    });

    const actions = nextAction({ lead: exploding }, NOW);

    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe('NOTHING_TO_DO');
    expect(actions[0]?.evidence).toBe('reader exploded');
  });
});

/* -------------------------------------------------------------------------- */
/* Determinism                                                                 */
/* -------------------------------------------------------------------------- */

describe('nextAction — determinism', () => {
  const input: NextActionInput = {
    lead: aQualifiedLead({
      trace: {
        rules: [
          {
            ruleId: 'icp.region',
            ruleName: 'Target region',
            outcome: 'partial',
            contributed: true,
            pointsEarned: 5,
            pointsPossible: 10,
            explanation: 'Region matched loosely.',
          },
        ],
      },
      enrichableGaps: ['industry', 'seniority'],
      createdAt: ago(40),
      email: null,
    }),
    opportunity: [
      { id: 'a', stage: 'NEW', createdAt: '2026-06-01T00:00:00.000Z' },
      { id: 'b', stage: 'SCREENING', createdAt: '2026-05-01T00:00:00.000Z', stageEnteredAt: ago(30) },
    ] as OpportunitySnapshot[],
  };

  it('should give an identical answer for identical inputs and the same now', () => {
    expect(nextAction(input, NOW)).toEqual(nextAction(input, NOW));
    expect(JSON.stringify(nextAction(input, NOW))).toBe(
      JSON.stringify(nextAction(input, new Date(NOW.getTime()))),
    );
  });

  it('should not depend on the order the opportunities arrived in', () => {
    const reversed: NextActionInput = {
      ...input,
      opportunity: [...(input.opportunity as OpportunitySnapshot[])].reverse(),
    };

    expect(nextAction(reversed, NOW)).toEqual(nextAction(input, NOW));
  });
});

/* -------------------------------------------------------------------------- */
/* The card                                                                    */
/* -------------------------------------------------------------------------- */

describe('buildPipelineCard', () => {
  it('should carry the lane, the arithmetic and the action in one payload', () => {
    const card = buildPipelineCard(
      {
        lead: aQualifiedLead({ trace: DECISION_MAKER_PASSED, ownerId: null }),
        opportunity: { id: 'o-1', stage: 'NEW', stageEnteredAt: ago(1), ownerId: null },
      },
      NOW,
    );

    expect(card.lane).toBe('new');
    expect(card.opportunityId).toBe('o-1');
    expect(card.displayName).toBe('Priya Raman');
    expect(card.companyName).toBe('Northwind Logistics');
    expect(card.score).toBe(82);
    expect(card.readiness.summary).toBe('1 of 2 met — missing: owner assigned.');
    expect(card.actions[0]?.kind).toBe('ASSIGN_AN_OWNER');
    expect(card.advisedAt).toBe(NOW.toISOString());
  });

  it('should leave advisedAt empty rather than throw on an unusable clock', () => {
    const card = buildPipelineCard({ lead: aQualifiedLead() }, new Date('nope'));

    expect(card.advisedAt).toBe('');
  });

  it('should degrade to a nameless card rather than fail on an empty lead', () => {
    const card = buildPipelineCard({ lead: {} }, NOW);

    expect(card.displayName).toBe('Unnamed lead');
    expect(card.lane).toBe('captured');
    expect(card.actions.length).toBeGreaterThan(0);
  });
});
