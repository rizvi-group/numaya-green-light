import { describe, expect, it } from 'vitest';

import { runPipelineCommand } from 'src/logic-functions/pipeline-run';
import { BOARD_LANE_LIMIT } from 'src/pipeline/wire';
import type { BoardResponse, LaneSummary } from 'src/pipeline/wire';
import type { PipelineLane } from 'src/pipeline/types';

import {
  aPerson,
  anOpportunity,
  createFakeWorkspace,
  type FakeWorkspaceOptions,
} from 'src/logic-functions/__tests__/pipeline-fakes';

const NOW = new Date('2026-08-06T09:00:00.000Z');

const board = async (
  options: FakeWorkspaceOptions,
  perLane?: number,
): Promise<BoardResponse> => {
  const client = createFakeWorkspace(options);

  const outcome = await runPipelineCommand(
    { action: 'board', ...(perLane === undefined ? {} : { perLane }) },
    { client, now: NOW, actor: 'Workspace member wm-1' },
  );

  expect(outcome.status).toBe(200);
  expect(outcome.body.action).toBe('board');

  return outcome.body as BoardResponse;
};

const lane = (response: BoardResponse, name: PipelineLane): LaneSummary => {
  const found = response.lanes.find((summary) => summary.lane === name);

  expect(found).toBeDefined();

  return found as LaneSummary;
};

const heldPeople = (count: number): Record<string, unknown>[] =>
  Array.from({ length: count }, (_, index) =>
    aPerson({
      id: `person-${index}`,
      createdAt: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      name: { firstName: 'Held', lastName: `Lead ${index}` },
      emails: { primaryEmail: `held-${index}@northwind.example` },
      companyId: null,
      company: null,
      greenlightDecision: 'GATE',
      greenlightScore: 40 + index,
    }),
  );

describe('the board', () => {
  it('should return every lane, in board order, on an empty workspace', async () => {
    const response = await board({ people: [], opportunities: [] });

    expect(response.lanes.map((summary) => summary.lane)).toEqual([
      'captured',
      'enriching',
      'held',
      'qualified',
      'new',
      'screening',
      'meeting',
      'proposal',
      'customer',
    ]);
    expect(response.lanes.every((summary) => summary.total === 0)).toBe(true);
    expect(response.generatedAt).toBe(NOW.toISOString());
  });

  it('should place a scored, passing lead with no deal in Qualified', async () => {
    const response = await board({ people: [aPerson()], opportunities: [] });

    expect(lane(response, 'qualified').total).toBe(1);
    expect(lane(response, 'qualified').cards[0]?.displayName).toBe('Priya Raman');
  });

  it('should place an unscored lead with fillable gaps in Enriching, not Captured', async () => {
    // The lane is derived from the enrichment planner's own answer, handed over
    // rather than recomputed — so a lane and the button on its card cannot
    // disagree about whether a provider has anything to look up.
    const response = await board({
      people: [
        aPerson({
          greenlightDecision: null,
          greenlightScore: null,
          greenlightTrace: null,
        }),
      ],
    });

    expect(lane(response, 'enriching').total).toBe(1);
    expect(lane(response, 'captured').total).toBe(0);
  });

  it('should place a lead with a deal in the deal’s own lane, not in Qualified', async () => {
    const response = await board({
      people: [aPerson()],
      opportunities: [anOpportunity({ stage: 'SCREENING' })],
    });

    expect(lane(response, 'qualified').total).toBe(0);
    expect(lane(response, 'screening').total).toBe(1);
    expect(lane(response, 'screening').cards[0]?.opportunityId).toBe(
      'opportunity-a',
    );
  });

  it('should still show a deal whose point of contact was not read', async () => {
    // The lead is deliberately absent from the workspace. A board that omitted
    // the deal would look complete and be short by one, which is the failure
    // `BoardResponse.notices` exists to prevent — so it gets a card built on
    // what the deal itself says.
    const response = await board({
      people: [],
      opportunities: [anOpportunity({ stage: 'PROPOSAL' })],
    });

    expect(lane(response, 'proposal').total).toBe(1);
    expect(lane(response, 'proposal').cards[0]?.leadId).toBeNull();
    expect(lane(response, 'proposal').cards[0]?.opportunityId).toBe(
      'opportunity-a',
    );
  });

  describe('truncation', () => {
    it('should cap the cards at perLane while total stays the true lane count', async () => {
      const response = await board({ people: heldPeople(5) }, 2);

      expect(lane(response, 'held').total).toBe(5);
      expect(lane(response, 'held').cards).toHaveLength(2);
    });

    it('should clamp perLane to BOARD_LANE_LIMIT however much the client asks for', async () => {
      const response = await board({ people: heldPeople(60) }, 5_000);

      expect(lane(response, 'held').total).toBe(60);
      expect(lane(response, 'held').cards).toHaveLength(BOARD_LANE_LIMIT);
    });

    it('should truncate deterministically, so two reads of one lane agree', async () => {
      const options = { people: heldPeople(8) };

      const first = await board(options, 3);
      const second = await board(options, 3);

      expect(lane(first, 'held').cards.map((card) => card.displayName)).toEqual(
        lane(second, 'held').cards.map((card) => card.displayName),
      );
    });

    it('should treat a perLane of zero or nonsense as the shipped limit', async () => {
      expect(lane(await board({ people: heldPeople(3) }, 0), 'held').cards).toHaveLength(
        1,
      );
      expect(
        lane(await board({ people: heldPeople(3) }, Number.NaN), 'held').cards,
      ).toHaveLength(3);
    });
  });

  describe('fail-open', () => {
    it('should paint the board on shipped defaults when the config cannot be read', async () => {
      const response = await board({ people: [aPerson()], failConfigRead: true });

      expect(lane(response, 'qualified').total).toBe(1);
      expect(response.notices.join(' ')).toContain('shipped defaults');
    });

    it('should paint the board when there is no config record at all', async () => {
      const response = await board({ people: [aPerson()], config: null });

      expect(lane(response, 'qualified').total).toBe(1);
      expect(response.notices.join(' ')).toContain('configuration record');
    });

    it('should return a board and a notice when the lead pages fail', async () => {
      const response = await board({
        people: [aPerson()],
        opportunities: [anOpportunity({ pointOfContactId: null })],
        failPeoplePages: true,
      });

      expect(response.notices.join(' ')).toContain('could not');
      // The deal half still painted. A read that failed cost its own records and
      // nothing else.
      expect(lane(response, 'new').total).toBe(1);
    });

    it('should return a board and a notice when the deal pages fail', async () => {
      const response = await board({
        people: [aPerson()],
        opportunities: [anOpportunity()],
        failOpportunityPages: true,
      });

      expect(response.notices.join(' ')).toContain('could not');
      expect(lane(response, 'qualified').total).toBe(1);
    });

    it('should report activity criteria as unchecked, not unmet, when task and note reads fail', async () => {
      const response = await board({
        people: [aPerson()],
        opportunities: [anOpportunity({ stage: 'SCREENING' })],
        failActivityReads: true,
      });

      const card = lane(response, 'screening').cards[0];

      expect(response.notices.join(' ')).toContain('unchecked rather than unmet');
      expect(
        card?.readiness.indeterminate.map((result) => result.criterionId),
      ).toContain('meeting.discovery-call-logged');
      expect(card?.readiness.unmet.map((result) => result.criterionId)).not.toContain(
        'meeting.discovery-call-logged',
      );
    });

    it('should say why the owner criterion is unchecked when the workspace has no owner field', async () => {
      const response = await board({
        people: [aPerson()],
        opportunities: [anOpportunity()],
      });

      expect(response.notices.join(' ')).toContain('no owner field on Opportunity');
      expect(
        lane(response, 'new').cards[0]?.readiness.indeterminate.map(
          (result) => result.criterionId,
        ),
      ).toContain('screening.owner-assigned');
    });

    it('should never throw, even when every read fails at once', async () => {
      const response = await board({
        people: [aPerson()],
        opportunities: [anOpportunity()],
        failConfigRead: true,
        failPeoplePages: true,
        failOpportunityPages: true,
        failActivityReads: true,
      });

      expect(response.action).toBe('board');
      expect(response.lanes).toHaveLength(9);
      expect(response.notices.length).toBeGreaterThan(0);
    });
  });

  it('should read Person and Opportunity in pages of sixty, not one request per card', async () => {
    const client = createFakeWorkspace({ people: heldPeople(5) });

    await runPipelineCommand(
      { action: 'board' },
      { client, now: NOW, actor: 'Workspace member wm-1' },
    );

    const pages = client
      .callsTo('people')
      .map((call) => (call['__args'] as Record<string, unknown>)?.['first']);

    expect(pages).toContain(60);
    // One page of people, one of deals, one config, one owner probe. Nothing
    // that scales with the number of cards.
    expect(client.calls.length).toBeLessThan(10);
  });
});
