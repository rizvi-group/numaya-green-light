import { describe, expect, it } from 'vitest';

import {
  deriveLane,
  deriveLanePlacement,
  isPersonDerivedLane,
  laneForStage,
  selectPrimaryOpportunity,
} from 'src/pipeline/lanes';
import type {
  LeadSnapshot,
  OpportunitySnapshot,
  PipelineLane,
} from 'src/pipeline/types';

const aLead = (overrides: Partial<LeadSnapshot> = {}): LeadSnapshot => ({
  id: 'f1a2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  displayName: 'Priya Raman',
  companyName: 'Northwind Logistics',
  ...overrides,
});

const anOpportunity = (
  overrides: Partial<OpportunitySnapshot> = {},
): OpportunitySnapshot => ({
  id: '11111111-1111-4111-8111-111111111111',
  stage: 'NEW',
  createdAt: '2026-07-01T00:00:00.000Z',
  ...overrides,
});

/* -------------------------------------------------------------------------- */

describe('laneForStage', () => {
  it('should read every stage Twenty ships, however it is cased or separated', () => {
    expect(laneForStage('NEW')).toBe('new');
    expect(laneForStage('screening')).toBe('screening');
    expect(laneForStage('Meeting')).toBe('meeting');
    expect(laneForStage(' PROPOSAL ')).toBe('proposal');
    expect(laneForStage('CUSTOMER')).toBe('customer');
  });

  it('should return null for a stage a workspace has renamed', () => {
    expect(laneForStage('Discovery')).toBeNull();
    expect(laneForStage('')).toBeNull();
    expect(laneForStage(null)).toBeNull();
    expect(laneForStage(undefined)).toBeNull();
  });
});

describe('deriveLane — the four Greenlight owns', () => {
  it('should place a never-scored lead with nothing to look up in Captured', () => {
    expect(deriveLane(aLead({ decision: 'UNSCORED' }), null)).toBe('captured');
  });

  it('should place a never-scored lead with enrichable gaps in Enriching', () => {
    expect(
      deriveLane(
        aLead({ decision: 'UNSCORED', enrichableGaps: ['industry'] }),
        null,
      ),
    ).toBe('enriching');
  });

  it('should place a lead with a run in flight in Enriching whatever its gaps', () => {
    expect(
      deriveLane(
        aLead({ decision: 'UNSCORED', enrichmentStatus: 'IN_PROGRESS' }),
        null,
      ),
    ).toBe('enriching');
  });

  it('should place a gated lead in Held', () => {
    expect(deriveLane(aLead({ decision: 'GATE' }), null)).toBe('held');
  });

  it('should place a compliance-blocked lead in Held', () => {
    expect(deriveLane(aLead({ decision: 'BLOCKED' }), null)).toBe('held');
  });

  it('should keep a held lead in Held even while enrichment is in flight', () => {
    expect(
      deriveLane(
        aLead({
          decision: 'GATE',
          enrichmentStatus: 'RUNNING',
          enrichableGaps: ['industry', 'region'],
        }),
        null,
      ),
    ).toBe('held');
  });

  it('should place a passing lead with no opportunity in Qualified', () => {
    expect(deriveLane(aLead({ decision: 'PASS' }), null)).toBe('qualified');
  });

  it('should keep a passing lead in Qualified even when gaps remain', () => {
    // The gap is an action on a qualified card, never a lane. Routing on "any
    // gap exists" would empty this lane and break the handoff line.
    expect(
      deriveLane(
        aLead({ decision: 'PASS', enrichableGaps: ['seniority'] }),
        null,
      ),
    ).toBe('qualified');
  });

  it('should fall back to Captured for a decision it does not recognise', () => {
    expect(deriveLane(aLead({ decision: 'MAYBE' }), null)).toBe('captured');
    expect(deriveLane(aLead({ decision: null }), null)).toBe('captured');
    expect(deriveLane(aLead(), null)).toBe('captured');
  });
});

describe('deriveLane — the five Twenty owns', () => {
  const cases: readonly (readonly [string, PipelineLane])[] = [
    ['NEW', 'new'],
    ['SCREENING', 'screening'],
    ['MEETING', 'meeting'],
    ['PROPOSAL', 'proposal'],
    ['CUSTOMER', 'customer'],
  ];

  for (const [stage, lane] of cases) {
    it(`should read ${stage} as ${lane}`, () => {
      expect(
        deriveLane(aLead({ decision: 'PASS' }), anOpportunity({ stage })),
      ).toBe(lane);
    });
  }

  it('should place an unrecognised stage in New and say that it did', () => {
    const placement = deriveLanePlacement(
      aLead({ decision: 'PASS' }),
      anOpportunity({ stage: 'Discovery' }),
    );

    expect(placement.lane).toBe('new');
    expect(placement.stageRecognised).toBe(false);
    expect(placement.note).toContain('Discovery');
  });

  it('should let the opportunity win over an UNSCORED person', () => {
    const placement = deriveLanePlacement(
      aLead({ decision: 'UNSCORED' }),
      anOpportunity({ stage: 'PROPOSAL' }),
    );

    expect(placement.lane).toBe('proposal');
    expect(placement.source).toBe('opportunity');
  });

  it('should let the opportunity win over a blocked person, because the lane is not the blocker', () => {
    expect(
      deriveLane(
        aLead({ decision: 'BLOCKED', suppressed: true }),
        anOpportunity({ stage: 'MEETING' }),
      ),
    ).toBe('meeting');
  });
});

describe('selectPrimaryOpportunity', () => {
  it('should follow the furthest-advanced live deal', () => {
    const chosen = selectPrimaryOpportunity([
      anOpportunity({ id: 'a', stage: 'NEW' }),
      anOpportunity({ id: 'b', stage: 'PROPOSAL' }),
      anOpportunity({ id: 'c', stage: 'SCREENING' }),
    ]);

    expect(chosen?.id).toBe('b');
  });

  it('should not let a won deal hide a live one', () => {
    const chosen = selectPrimaryOpportunity([
      anOpportunity({ id: 'won', stage: 'CUSTOMER' }),
      anOpportunity({ id: 'live', stage: 'NEW' }),
    ]);

    expect(chosen?.id).toBe('live');
  });

  it('should choose a won deal when it is all there is', () => {
    const chosen = selectPrimaryOpportunity([
      anOpportunity({ id: 'won', stage: 'CUSTOMER' }),
    ]);

    expect(chosen?.id).toBe('won');
  });

  it('should break a stage tie on the most recently created', () => {
    const chosen = selectPrimaryOpportunity([
      anOpportunity({ id: 'old', stage: 'MEETING', createdAt: '2026-01-01T00:00:00.000Z' }),
      anOpportunity({ id: 'new', stage: 'MEETING', createdAt: '2026-06-01T00:00:00.000Z' }),
    ]);

    expect(chosen?.id).toBe('new');
  });

  it('should break a remaining tie on id, so the answer never depends on input order', () => {
    const first = selectPrimaryOpportunity([
      anOpportunity({ id: 'bbb', stage: 'MEETING', createdAt: null }),
      anOpportunity({ id: 'aaa', stage: 'MEETING', createdAt: null }),
    ]);
    const second = selectPrimaryOpportunity([
      anOpportunity({ id: 'aaa', stage: 'MEETING', createdAt: null }),
      anOpportunity({ id: 'bbb', stage: 'MEETING', createdAt: null }),
    ]);

    expect(first?.id).toBe('aaa');
    expect(second?.id).toBe('aaa');
  });

  it('should return null for an empty list', () => {
    expect(selectPrimaryOpportunity([])).toBeNull();
  });

  it('should count the opportunities it chose between', () => {
    const placement = deriveLanePlacement(aLead({ decision: 'PASS' }), [
      anOpportunity({ id: 'a', stage: 'NEW' }),
      anOpportunity({ id: 'b', stage: 'MEETING' }),
    ]);

    expect(placement.lane).toBe('meeting');
    expect(placement.opportunityId).toBe('b');
    expect(placement.opportunityCount).toBe(2);
    expect(placement.note).toContain('2 opportunities');
  });
});

describe('deriveLane — fail-open', () => {
  it('should not throw on a lead that is not an object', () => {
    expect(deriveLane(null as unknown as LeadSnapshot, null)).toBe('captured');
    expect(deriveLane('nonsense' as unknown as LeadSnapshot, null)).toBe(
      'captured',
    );
  });

  it('should not throw on rubbish in the opportunity list', () => {
    const placement = deriveLanePlacement(aLead({ decision: 'PASS' }), [
      null as unknown as OpportunitySnapshot,
      undefined as unknown as OpportunitySnapshot,
    ]);

    expect(placement.lane).toBe('qualified');
    expect(placement.source).toBe('person');
  });

  it('should treat an empty opportunity object as a deal with an unreadable stage', () => {
    expect(deriveLane(aLead({ decision: 'PASS' }), {})).toBe('new');
  });

  it('should accept undefined where an opportunity was expected', () => {
    expect(deriveLane(aLead({ decision: 'PASS' }), undefined)).toBe('qualified');
  });
});

describe('isPersonDerivedLane', () => {
  it('should name the four lanes Greenlight derives and no others', () => {
    expect(isPersonDerivedLane('captured')).toBe(true);
    expect(isPersonDerivedLane('enriching')).toBe(true);
    expect(isPersonDerivedLane('held')).toBe(true);
    expect(isPersonDerivedLane('qualified')).toBe(true);
    expect(isPersonDerivedLane('new')).toBe(false);
    expect(isPersonDerivedLane('customer')).toBe(false);
  });
});
