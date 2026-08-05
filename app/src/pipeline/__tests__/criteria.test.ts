import { describe, expect, it } from 'vitest';

import {
  ALL_CRITERIA,
  CRITERION_COST,
  DECISION_MAKER_RULE_ID,
  DEFAULT_STAGE_DWELL_DAYS,
  STAGE_CRITERIA,
  cheapnessOf,
  criteriaFor,
  evaluateTransition,
  formatDay,
  readTrace,
  readiness,
  resolvePipelineConfig,
  transitionForLane,
} from 'src/pipeline/criteria';
import type {
  CriterionResult,
  CriterionSnapshot,
  LeadSnapshot,
  OpportunitySnapshot,
  TransitionId,
} from 'src/pipeline/types';

const NOW = new Date('2026-08-06T09:00:00.000Z');

const snapshotOf = (
  lead: LeadSnapshot,
  opportunity: OpportunitySnapshot | null = null,
  config: unknown = null,
): CriterionSnapshot => ({
  lead,
  opportunity,
  config: resolvePipelineConfig(config),
  now: NOW,
});

const resultOf = (
  transition: TransitionId,
  snapshot: CriterionSnapshot,
  criterionId: string,
): CriterionResult => {
  const found = evaluateTransition(transition, snapshot).find(
    (result) => result.criterionId === criterionId,
  );

  if (found === undefined) {
    throw new Error(`no criterion ${criterionId} on ${transition}`);
  }

  return found;
};

const tracePassing = (ruleId: string) => ({
  rules: [
    {
      ruleId,
      ruleName: 'Decision-maker',
      outcome: 'pass',
      severity: 'major',
      contributed: true,
      pointsEarned: 20,
      pointsPossible: 20,
      explanation: 'Priya Raman is Head of Operations, which can sign.',
    },
  ],
});

/* -------------------------------------------------------------------------- */
/* Qualified → New                                                             */
/* -------------------------------------------------------------------------- */

describe('qualified.score-clears-gate', () => {
  const id = 'qualified.score-clears-gate';

  it('should be met at or above the threshold', () => {
    const result = resultOf('qualified_to_new', snapshotOf({ score: 50 }), id);

    expect(result.status).toBe('met');
    expect(result.evidence).toBe('scored 50, at or above your gate threshold of 50');
  });

  it('should be unmet below the threshold, with a sentence naming both numbers', () => {
    const result = resultOf('qualified_to_new', snapshotOf({ score: 32 }), id);

    expect(result.status).toBe('unmet');
    expect(result.evidence).toBe('scored 32, below your gate threshold of 50');
    expect(result.sentence).toContain('32');
    expect(result.sentence).toContain('50');
  });

  it('should be indeterminate when the lead has never been scored', () => {
    const result = resultOf('qualified_to_new', snapshotOf({ score: null }), id);

    expect(result.status).toBe('indeterminate');
    expect(result.evidence).toContain('never been scored');
  });

  it('should be indeterminate when the score was not read at all', () => {
    const result = resultOf('qualified_to_new', snapshotOf({}), id);

    expect(result.status).toBe('indeterminate');
    expect(result.evidence).toContain('not read');
  });

  it('should honour a configured threshold', () => {
    const result = resultOf(
      'qualified_to_new',
      snapshotOf({ score: 60 }, null, { gateThreshold: 75 }),
      id,
    );

    expect(result.status).toBe('unmet');
    expect(result.evidence).toContain('75');
  });
});

describe('qualified.company-identified', () => {
  const id = 'qualified.company-identified';

  it('should be met and name the company', () => {
    const result = resultOf(
      'qualified_to_new',
      snapshotOf({ companyName: 'Northwind Logistics' }),
      id,
    );

    expect(result.status).toBe('met');
    expect(result.evidence).toBe('linked to Northwind Logistics');
  });

  it('should be met on a link whose name did not come through', () => {
    const result = resultOf(
      'qualified_to_new',
      snapshotOf({ companyName: null, companyId: 'c-1' }),
      id,
    );

    expect(result.status).toBe('met');
  });

  it('should be unmet when the record has no company', () => {
    const result = resultOf(
      'qualified_to_new',
      snapshotOf({ companyName: null, companyId: null, displayName: 'Priya Raman' }),
      id,
    );

    expect(result.status).toBe('unmet');
    expect(result.evidence).toBe('no company on the record');
    expect(result.sentence).toContain('Priya Raman');
  });

  it('should be indeterminate when the company link was never loaded', () => {
    const result = resultOf('qualified_to_new', snapshotOf({}), id);

    expect(result.status).toBe('indeterminate');
  });
});

describe('qualified.contactable-email', () => {
  const id = 'qualified.contactable-email';

  it('should be met on a usable address', () => {
    const result = resultOf(
      'qualified_to_new',
      snapshotOf({ email: 'priya@northwind.example' }),
      id,
    );

    expect(result.status).toBe('met');
    expect(result.evidence).toContain('priya@northwind.example');
  });

  it('should be unmet on an empty address', () => {
    const result = resultOf('qualified_to_new', snapshotOf({ email: '' }), id);

    expect(result.status).toBe('unmet');
    expect(result.evidence).toBe('no email address on the record');
  });

  it('should be unmet on something that is not an address at all', () => {
    const result = resultOf(
      'qualified_to_new',
      snapshotOf({ email: 'ask reception' }),
      id,
    );

    expect(result.status).toBe('unmet');
    expect(result.evidence).toContain('ask reception');
  });

  it('should be indeterminate when no email was loaded', () => {
    const result = resultOf('qualified_to_new', snapshotOf({}), id);

    expect(result.status).toBe('indeterminate');
  });
});

/* -------------------------------------------------------------------------- */
/* New → Screening                                                             */
/* -------------------------------------------------------------------------- */

describe('screening.decision-maker-on-record', () => {
  const id = 'screening.decision-maker-on-record';

  it('should be met when the scoring rule passed', () => {
    const result = resultOf(
      'new_to_screening',
      snapshotOf({ trace: tracePassing(DECISION_MAKER_RULE_ID) }),
      id,
    );

    expect(result.status).toBe('met');
    expect(result.evidence).toContain('Head of Operations');
  });

  it('should be met on partial credit, because that is how an influencer scores', () => {
    const result = resultOf(
      'new_to_screening',
      snapshotOf({
        trace: [
          {
            ruleId: DECISION_MAKER_RULE_ID,
            outcome: 'partial',
            explanation: 'Operations Manager influences but does not sign.',
          },
        ],
      }),
      id,
    );

    expect(result.status).toBe('met');
  });

  it('should be unmet when the scoring rule failed', () => {
    const result = resultOf(
      'new_to_screening',
      snapshotOf({
        companyName: 'Northwind Logistics',
        displayName: 'Priya Raman',
        trace: [
          {
            ruleId: DECISION_MAKER_RULE_ID,
            outcome: 'fail',
            explanation: 'No job title on the record.',
          },
        ],
      }),
      id,
    );

    expect(result.status).toBe('unmet');
    expect(result.sentence).toContain('Northwind Logistics');
  });

  it('should be indeterminate when the rule is absent from the trace', () => {
    const result = resultOf(
      'new_to_screening',
      snapshotOf({ trace: { rules: [] } }),
      id,
    );

    expect(result.status).toBe('indeterminate');
  });

  it('should be indeterminate when the rule errored rather than judged', () => {
    const result = resultOf(
      'new_to_screening',
      snapshotOf({
        trace: [{ ruleId: DECISION_MAKER_RULE_ID, outcome: 'errored' }],
      }),
      id,
    );

    expect(result.status).toBe('indeterminate');
  });

  it('should be indeterminate when no trace was loaded', () => {
    const result = resultOf('new_to_screening', snapshotOf({}), id);

    expect(result.status).toBe('indeterminate');
    expect(result.evidence).toContain('not loaded');
  });
});

describe('screening.owner-assigned', () => {
  const id = 'screening.owner-assigned';

  it('should be met when the deal has an owner', () => {
    const result = resultOf(
      'new_to_screening',
      snapshotOf({ ownerId: null }, { ownerId: 'member-1' }),
      id,
    );

    expect(result.status).toBe('met');
    expect(result.evidence).toBe('the deal has an owner');
  });

  it('should accept the owner on the person when the deal has none', () => {
    const result = resultOf(
      'new_to_screening',
      snapshotOf({ ownerId: 'member-1' }, { ownerId: null }),
      id,
    );

    expect(result.status).toBe('met');
  });

  it('should be unmet when nobody owns it', () => {
    const result = resultOf(
      'new_to_screening',
      snapshotOf({ ownerId: null }, { ownerId: null }),
      id,
    );

    expect(result.status).toBe('unmet');
    expect(result.evidence).toBe('nobody owns this deal');
  });

  it('should be indeterminate when no owner field was loaded', () => {
    const result = resultOf('new_to_screening', snapshotOf({}, {}), id);

    expect(result.status).toBe('indeterminate');
  });
});

/* -------------------------------------------------------------------------- */
/* Screening → Meeting                                                         */
/* -------------------------------------------------------------------------- */

describe('meeting.discovery-call-logged', () => {
  const id = 'meeting.discovery-call-logged';

  it('should be met on a call that has happened, and date it', () => {
    const result = resultOf(
      'screening_to_meeting',
      snapshotOf({}, { lastDiscoveryCallAt: '2026-07-14T10:30:00.000Z' }),
      id,
    );

    expect(result.status).toBe('met');
    expect(result.evidence).toBe('discovery call logged 2026-07-14');
  });

  it('should be unmet on a call that is only booked', () => {
    const result = resultOf(
      'screening_to_meeting',
      snapshotOf({}, { lastDiscoveryCallAt: '2026-08-20T10:30:00.000Z' }),
      id,
    );

    expect(result.status).toBe('unmet');
    expect(result.evidence).toContain('has not happened yet');
  });

  it('should be unmet when no call is logged at all', () => {
    const result = resultOf(
      'screening_to_meeting',
      snapshotOf({}, { lastDiscoveryCallAt: null }),
      id,
    );

    expect(result.status).toBe('unmet');
    expect(result.evidence).toBe('no discovery call is logged against this deal');
  });

  it('should be indeterminate when activity was not loaded', () => {
    const result = resultOf('screening_to_meeting', snapshotOf({}, {}), id);

    expect(result.status).toBe('indeterminate');
  });

  it('should be indeterminate on a date it cannot read', () => {
    const result = resultOf(
      'screening_to_meeting',
      snapshotOf({}, { lastDiscoveryCallAt: 'last Tuesday' }),
      id,
    );

    expect(result.status).toBe('indeterminate');
  });

  it('should be indeterminate when the run had no usable clock', () => {
    const results = evaluateTransition('screening_to_meeting', {
      lead: {},
      opportunity: { lastDiscoveryCallAt: '2026-07-14T10:30:00.000Z' },
      config: resolvePipelineConfig(null),
      now: new Date(Number.NaN),
    });

    expect(results[0]?.status).toBe('indeterminate');
  });
});

/* -------------------------------------------------------------------------- */
/* Meeting → Proposal                                                          */
/* -------------------------------------------------------------------------- */

describe('proposal.amount-set', () => {
  const id = 'proposal.amount-set';

  it('should be met on a positive amount', () => {
    const result = resultOf('meeting_to_proposal', snapshotOf({}, { amount: 12000 }), id);

    expect(result.status).toBe('met');
    expect(result.evidence).toBe('amount set to 12000');
  });

  it('should be unmet on an empty amount', () => {
    const result = resultOf('meeting_to_proposal', snapshotOf({}, { amount: null }), id);

    expect(result.status).toBe('unmet');
    expect(result.evidence).toBe('the amount is empty');
  });

  it('should be unmet on a zero amount', () => {
    const result = resultOf('meeting_to_proposal', snapshotOf({}, { amount: 0 }), id);

    expect(result.status).toBe('unmet');
  });

  it('should be indeterminate when the amount was not loaded', () => {
    const result = resultOf('meeting_to_proposal', snapshotOf({}, {}), id);

    expect(result.status).toBe('indeterminate');
  });
});

describe('proposal.close-date-set', () => {
  const id = 'proposal.close-date-set';

  it('should be met on a close date, past or future', () => {
    expect(
      resultOf('meeting_to_proposal', snapshotOf({}, { closeDate: '2026-09-30' }), id)
        .status,
    ).toBe('met');
    expect(
      resultOf('meeting_to_proposal', snapshotOf({}, { closeDate: '2026-01-30' }), id)
        .status,
    ).toBe('met');
  });

  it('should be unmet on an empty close date, in the words the spec uses', () => {
    const result = resultOf(
      'meeting_to_proposal',
      snapshotOf({}, { closeDate: null }),
      id,
    );

    expect(result.status).toBe('unmet');
    expect(result.evidence).toBe('close date is empty');
  });

  it('should be indeterminate on a close date it cannot read', () => {
    const result = resultOf(
      'meeting_to_proposal',
      snapshotOf({}, { closeDate: 'end of Q3' }),
      id,
    );

    expect(result.status).toBe('indeterminate');
  });

  it('should be indeterminate when the close date was not loaded', () => {
    const result = resultOf('meeting_to_proposal', snapshotOf({}, {}), id);

    expect(result.status).toBe('indeterminate');
  });
});

describe('proposal.note-since-meeting', () => {
  const id = 'proposal.note-since-meeting';

  it('should be met on a note written after the meeting', () => {
    const result = resultOf(
      'meeting_to_proposal',
      snapshotOf(
        {},
        {
          lastDiscoveryCallAt: '2026-07-14T10:30:00.000Z',
          lastNoteAt: '2026-07-16T08:00:00.000Z',
        },
      ),
      id,
    );

    expect(result.status).toBe('met');
    expect(result.evidence).toBe('note logged 2026-07-16, after the meeting on 2026-07-14');
  });

  it('should be unmet on a note that predates the meeting', () => {
    const result = resultOf(
      'meeting_to_proposal',
      snapshotOf(
        {},
        {
          lastDiscoveryCallAt: '2026-07-14T10:30:00.000Z',
          lastNoteAt: '2026-07-10T08:00:00.000Z',
        },
      ),
      id,
    );

    expect(result.status).toBe('unmet');
    expect(result.evidence).toContain('predates');
  });

  it('should be unmet when there is no note at all', () => {
    const result = resultOf(
      'meeting_to_proposal',
      snapshotOf(
        {},
        { lastDiscoveryCallAt: '2026-07-14T10:30:00.000Z', lastNoteAt: null },
      ),
      id,
    );

    expect(result.status).toBe('unmet');
  });

  it('should be indeterminate when there is no meeting to measure against', () => {
    const result = resultOf(
      'meeting_to_proposal',
      snapshotOf({}, { lastDiscoveryCallAt: null, lastNoteAt: '2026-07-16T08:00:00.000Z' }),
      id,
    );

    expect(result.status).toBe('indeterminate');
    expect(result.evidence).toContain('no meeting date');
  });

  it('should be indeterminate when activity was not loaded', () => {
    const result = resultOf('meeting_to_proposal', snapshotOf({}, {}), id);

    expect(result.status).toBe('indeterminate');
  });
});

/* -------------------------------------------------------------------------- */
/* Proposal → Customer                                                         */
/* -------------------------------------------------------------------------- */

describe('proposal_to_customer', () => {
  it('should have no criteria at all, because a person closes a deal', () => {
    expect(STAGE_CRITERIA.proposal_to_customer).toEqual([]);
  });

  it('should read as "nothing to tick" rather than as an empty checklist', () => {
    const stage = readiness(
      evaluateTransition('proposal_to_customer', snapshotOf({})),
      'proposal_to_customer',
    );

    expect(stage.total).toBe(0);
    expect(stage.percent).toBeNull();
    expect(stage.summary).toContain('does not get a vote');
  });
});

/* -------------------------------------------------------------------------- */
/* Readiness                                                                   */
/* -------------------------------------------------------------------------- */

describe('readiness', () => {
  const met = (id: string, cost: number): CriterionResult => ({
    criterionId: id,
    label: id,
    transition: 'meeting_to_proposal',
    status: 'met',
    evidence: 'done',
    cost,
    actionKind: 'SET_THE_AMOUNT',
    sentence: 'x',
  });

  const unmet = (id: string, cost: number): CriterionResult => ({
    ...met(id, cost),
    status: 'unmet',
  });

  const unknown = (id: string, cost: number): CriterionResult => ({
    ...met(id, cost),
    status: 'indeterminate',
  });

  it('should count met against met plus unmet', () => {
    const stage = readiness([met('a', 10), met('b', 10), unmet('c', 10)]);

    expect(stage.met).toBe(2);
    expect(stage.total).toBe(3);
    expect(stage.percent).toBe(67);
  });

  it('should exclude indeterminate criteria from the denominator', () => {
    const stage = readiness([met('a', 10), unmet('b', 10), unknown('c', 10)]);

    expect(stage.total).toBe(2);
    expect(stage.percent).toBe(50);
    expect(stage.indeterminate).toHaveLength(1);
  });

  it('should report percent as null rather than 100 when nothing could be checked', () => {
    const stage = readiness([unknown('a', 10), unknown('b', 10)]);

    expect(stage.total).toBe(0);
    expect(stage.percent).toBeNull();
    expect(stage.summary).toContain('could not check any');
  });

  it('should report percent as null for an empty list', () => {
    const stage = readiness([]);

    expect(stage.percent).toBeNull();
    expect(stage.transition).toBeNull();
  });

  it('should order the unmet list cheapest first', () => {
    const stage = readiness([
      unmet('expensive', CRITERION_COST.BOOK_A_MEETING),
      unmet('cheap', CRITERION_COST.SET_A_FIELD),
      unmet('middling', CRITERION_COST.WRITE_IT_UP),
    ]);

    expect(stage.unmet.map((result) => result.criterionId)).toEqual([
      'cheap',
      'middling',
      'expensive',
    ]);
  });

  it('should break a cost tie on declaration order', () => {
    const stage = readiness([unmet('first', 10), unmet('second', 10)]);

    expect(stage.unmet.map((result) => result.criterionId)).toEqual([
      'first',
      'second',
    ]);
  });

  it('should write the arithmetic the spec asks for', () => {
    const stage = readiness([
      met('amount', 10),
      met('note', 10),
      met('owner', 10),
      unmet('close date', 10),
    ]);

    expect(stage.summary).toBe('3 of 4 met — missing: close date.');
  });

  it('should say what it could not check, alongside the arithmetic', () => {
    const stage = readiness([met('amount', 10), unknown('note', 10)]);

    expect(stage.summary).toContain('1 of 1 met');
    expect(stage.summary).toContain('could not be checked: note');
  });

  it('should survive being handed something that is not an array', () => {
    const stage = readiness(null as unknown as CriterionResult[]);

    expect(stage.met).toBe(0);
    expect(stage.percent).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Fail-open, configuration and the shared machinery                           */
/* -------------------------------------------------------------------------- */

describe('evaluateTransition — fail-open', () => {
  it('should record a criterion that throws as indeterminate, never as unmet', () => {
    const exploding: LeadSnapshot = {};

    Object.defineProperty(exploding, 'score', {
      enumerable: true,
      get: () => {
        throw new Error('field reader exploded');
      },
    });

    const results = evaluateTransition('qualified_to_new', snapshotOf(exploding));
    const stage = readiness(results, 'qualified_to_new');

    expect(
      results.find((result) => result.criterionId === 'qualified.score-clears-gate')
        ?.status,
    ).toBe('indeterminate');
    expect(stage.unmet).toHaveLength(0);
  });

  it('should return nothing for a transition that does not exist', () => {
    expect(evaluateTransition(null, snapshotOf({}))).toEqual([]);
    expect(criteriaFor(null)).toEqual([]);
  });
});

describe('resolvePipelineConfig', () => {
  it('should seed the shipped defaults from nothing at all', () => {
    const config = resolvePipelineConfig(undefined);

    expect(config.gateThreshold).toBe(50);
    expect(config.stageDwellDays).toEqual(DEFAULT_STAGE_DWELL_DAYS);
  });

  it('should repair one bad key without losing the others', () => {
    const config = resolvePipelineConfig({
      gateThreshold: 'seventy',
      stageDwellDays: { screening: 21, meeting: 'soon', proposal: -3 },
    });

    expect(config.gateThreshold).toBe(50);
    expect(config.stageDwellDays.screening).toBe(21);
    expect(config.stageDwellDays.meeting).toBe(DEFAULT_STAGE_DWELL_DAYS.meeting);
    expect(config.stageDwellDays.proposal).toBe(DEFAULT_STAGE_DWELL_DAYS.proposal);
  });

  it('should accept an explicit null dwell as "this lane never goes stale"', () => {
    const config = resolvePipelineConfig({ stageDwellDays: { qualified: null } });

    expect(config.stageDwellDays.qualified).toBeNull();
  });

  it('should reject a threshold outside 0-100', () => {
    expect(resolvePipelineConfig({ gateThreshold: 400 }).gateThreshold).toBe(50);
    expect(resolvePipelineConfig({ gateThreshold: 0 }).gateThreshold).toBe(0);
  });
});

describe('readTrace', () => {
  it('should accept every envelope the gate queue accepts', () => {
    const entry = { ruleId: 'icp.industry', outcome: 'pass' };

    expect(readTrace([entry])).toHaveLength(1);
    expect(readTrace({ rules: [entry] })).toHaveLength(1);
    expect(readTrace({ trace: [entry] })).toHaveLength(1);
    expect(readTrace({ entries: [entry] })).toHaveLength(1);
  });

  it('should return nothing for a trace it cannot read', () => {
    expect(readTrace(null)).toEqual([]);
    expect(readTrace('{}')).toEqual([]);
    expect(readTrace({ nothing: true })).toEqual([]);
  });

  it('should drop entries with no rule id rather than repair them', () => {
    expect(readTrace([{ outcome: 'fail' }, { ruleId: 'icp.region' }])).toHaveLength(1);
  });
});

describe('the catalogue', () => {
  it('should give every criterion a unique id, a cost and a usable sentence', () => {
    const ids = ALL_CRITERIA.map((criterion) => criterion.id);

    expect(new Set(ids).size).toBe(ids.length);

    for (const criterion of ALL_CRITERIA) {
      expect(criterion.cost).toBeGreaterThan(0);
      expect(criterion.sentence.length).toBeGreaterThan(30);
      expect(criterion.sentence.endsWith('.')).toBe(true);
    }
  });

  it('should file every criterion under the transition it claims', () => {
    for (const transition of Object.keys(STAGE_CRITERIA) as TransitionId[]) {
      for (const criterion of STAGE_CRITERIA[transition]) {
        expect(criterion.appliesTo).toBe(transition);
      }
    }
  });

  it('should keep the cost example in the spec true: a close date beats a meeting', () => {
    expect(CRITERION_COST.SET_A_FIELD).toBeLessThan(CRITERION_COST.BOOK_A_MEETING);
    expect(cheapnessOf(CRITERION_COST.SET_A_FIELD)).toBeGreaterThan(
      cheapnessOf(CRITERION_COST.BOOK_A_MEETING),
    );
  });

  it('should clamp cheapness rather than let a bad cost sort to the front', () => {
    expect(cheapnessOf(500)).toBe(0);
    expect(cheapnessOf(-500)).toBe(100);
    expect(cheapnessOf(Number.NaN)).toBe(0);
  });

  it('should map each lane to the transition it is working towards', () => {
    expect(transitionForLane('qualified')).toBe('qualified_to_new');
    expect(transitionForLane('new')).toBe('new_to_screening');
    expect(transitionForLane('screening')).toBe('screening_to_meeting');
    expect(transitionForLane('meeting')).toBe('meeting_to_proposal');
    expect(transitionForLane('proposal')).toBe('proposal_to_customer');
    expect(transitionForLane('captured')).toBeNull();
    expect(transitionForLane('enriching')).toBeNull();
    expect(transitionForLane('held')).toBeNull();
    expect(transitionForLane('customer')).toBeNull();
  });

  it('should format a day in UTC, with no locale in sight', () => {
    expect(formatDay(new Date('2026-07-14T23:30:00.000Z'))).toBe('2026-07-14');
  });
});
