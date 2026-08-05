import { describe, expect, it } from 'vitest';

import {
  parsePipelineRequest,
  runPipelineCommand,
} from 'src/logic-functions/pipeline-run';
import { HANDOFF_FROM, HANDOFF_TO } from 'src/pipeline/wire';
import type {
  AdvanceRequest,
  AdvanceResponse,
  PipelineErrorResponse,
} from 'src/pipeline/wire';

import {
  aPerson,
  anOpportunity,
  createFakeWorkspace,
  type FakeWorkspace,
  type FakeWorkspaceOptions,
} from 'src/logic-functions/__tests__/pipeline-fakes';

const NOW = new Date('2026-08-06T09:00:00.000Z');
const ACTOR = 'Workspace member wm-1';

const advance = async (
  options: FakeWorkspaceOptions,
  request: Partial<AdvanceRequest> = {},
): Promise<{
  client: FakeWorkspace;
  status: number;
  body: AdvanceResponse | PipelineErrorResponse;
}> => {
  const client = createFakeWorkspace(options);

  const outcome = await runPipelineCommand(
    {
      action: 'advance',
      leadId: 'person-a',
      opportunityId: null,
      toLane: HANDOFF_TO,
      acknowledgedUnmet: [],
      ...request,
    },
    { client, now: NOW, actor: ACTOR },
  );

  return {
    client,
    status: outcome.status,
    body: outcome.body as AdvanceResponse | PipelineErrorResponse,
  };
};

const auditRows = (client: FakeWorkspace): Record<string, unknown>[] =>
  client.created['createGreenlightAuditLog'] ?? [];

describe('advance', () => {
  describe('the handoff line', () => {
    it('should create exactly one Opportunity, with company and point of contact pre-linked', async () => {
      const { client, body } = await advance({ people: [aPerson()] });

      const created = client.created['createOpportunity'] ?? [];

      expect(created).toHaveLength(1);
      expect(created[0]).toMatchObject({
        name: 'Northwind Logistics',
        stage: 'NEW',
        companyId: 'company-a',
        pointOfContactId: 'person-a',
      });
      expect((body as AdvanceResponse).createdOpportunityId).toBe('opportunity-1');
      expect((body as AdvanceResponse).card.lane).toBe(HANDOFF_TO);
    });

    it('should be the only path that creates one — a card with a deal moves its stage instead', async () => {
      const { client, body } = await advance(
        { people: [aPerson()], opportunities: [anOpportunity()] },
        { toLane: 'screening' },
      );

      expect(client.created['createOpportunity']).toBeUndefined();
      expect(client.created['updateOpportunity']?.[0]).toMatchObject({
        stage: 'SCREENING',
      });
      expect((body as AdvanceResponse).createdOpportunityId).toBeNull();
      expect((body as AdvanceResponse).card.lane).toBe('screening');
    });

    it('should never create a second deal for a lead that already has one', async () => {
      const { client } = await advance(
        { people: [aPerson()], opportunities: [anOpportunity()] },
        { toLane: HANDOFF_TO },
      );

      expect(client.created['createOpportunity']).toBeUndefined();
    });

    it('should open the deal where it was dropped, and say so, when a drag skips lanes', async () => {
      const { client, body } = await advance({ people: [aPerson()] }, {
        toLane: 'meeting',
      });

      expect(client.created['createOpportunity']?.[0]).toMatchObject({
        stage: 'MEETING',
      });
      expect((body as AdvanceResponse).notices.join(' ')).toContain(
        'crossed the handoff line',
      );
    });

    it('should say nothing unusual about the canonical crossing', async () => {
      const { body } = await advance({
        people: [aPerson({ greenlightDecision: 'PASS' })],
      });

      expect((body as AdvanceResponse).notices.join(' ')).not.toContain(
        'crossed the handoff line',
      );
      expect(HANDOFF_FROM).toBe('qualified');
    });
  });

  describe('the lead lanes', () => {
    it('should write the gate decision that produces the lane', async () => {
      const { client, body } = await advance(
        { people: [aPerson({ greenlightDecision: 'PASS' })] },
        { toLane: 'held' },
      );

      expect(client.created['updatePerson']?.[0]).toMatchObject({
        greenlightDecision: 'GATE',
      });
      expect((body as AdvanceResponse).card.lane).toBe('held');
    });

    it('should record the move but write nothing when a card is dropped into Enriching', async () => {
      const { client, body } = await advance(
        { people: [aPerson({ greenlightDecision: 'GATE' })] },
        { toLane: 'enriching' },
      );

      expect(client.created['updatePerson']).toBeUndefined();
      expect((body as AdvanceResponse).notices.join(' ')).toContain(
        'not a lane a card can be dropped into',
      );
      expect(auditRows(client)).toHaveLength(1);
    });
  });

  describe('the audit row', () => {
    it('should write one row for every move, acknowledgement or not', async () => {
      const { client } = await advance({ people: [aPerson()] });

      expect(auditRows(client)).toHaveLength(1);
      expect(auditRows(client)[0]).toMatchObject({
        // The default move is the handoff, which creates the Opportunity — the
        // only path in the app that does, and the reason it has an event type of
        // its own rather than sharing MOVED.
        eventType: 'HANDED_OFF',
        actorType: 'HUMAN',
        actorDisplayName: ACTOR,
        leadRecordId: 'person-a',
        leadDisplayName: 'Priya Raman',
        occurredAt: NOW.toISOString(),
      });
    });

    it('should distinguish a stage move from the handoff that created the deal', async () => {
      // The distinction the two event types exist for. Both rows are ordinary
      // pipeline progress — neither is an override, and whether the criteria
      // were met lives in `overrideReason`, not here — but only one of them
      // answers "when did this deal start".
      const { client } = await advance(
        {
          people: [aPerson({ greenlightDecision: 'PASS' })],
          opportunities: [anOpportunity({ stage: 'NEW' })],
        },
        { leadId: null, opportunityId: 'opportunity-a', toLane: 'screening' },
      );

      expect(auditRows(client)[0]).toMatchObject({ eventType: 'MOVED' });
      expect(String(auditRows(client)[0]?.['name'])).toContain('MOVED ·');
    });

    it('should name the outstanding criteria and who moved it anyway', async () => {
      const { client } = await advance(
        // Scores 40 against a gate threshold of 70, so the first exit criterion
        // for Qualified -> New is genuinely unmet.
        { people: [aPerson({ greenlightScore: 40 })] },
        { acknowledgedUnmet: ['qualified.score-clears-gate'] },
      );

      const reason = String(auditRows(client)[0]?.['overrideReason'] ?? '');

      expect(reason).toContain('1 exit criterion outstanding');
      expect(reason).toContain('score clears the gate');
      expect(reason).toContain(ACTOR);
      expect(String(auditRows(client)[0]?.['name'])).toContain('Qualified → New');
    });

    it('should pluralise, and keep an id it cannot resolve to a label', async () => {
      const { client } = await advance(
        { people: [aPerson({ greenlightScore: 40, emails: { primaryEmail: null } })] },
        {
          acknowledgedUnmet: [
            'qualified.score-clears-gate',
            'something.the.client.invented',
          ],
        },
      );

      const reason = String(auditRows(client)[0]?.['overrideReason'] ?? '');

      expect(reason).toContain('2 exit criteria outstanding');
      expect(reason).toContain('something.the.client.invented');
    });

    it('should take the actor from the request and never from the body', () => {
      const parsed = parsePipelineRequest({
        action: 'advance',
        leadId: 'person-a',
        opportunityId: null,
        toLane: 'new',
        actorDisplayName: 'Someone Else',
        actor: 'admin',
      });

      expect(parsed.ok).toBe(true);
      expect(Object.keys(parsed.ok ? parsed.request : {})).toEqual([
        'action',
        'leadId',
        'opportunityId',
        'toLane',
        'acknowledgedUnmet',
      ]);
    });
  });

  describe('never refusing', () => {
    it('should return the card and a notice when the stage write is rejected', async () => {
      const { client, status, body } = await advance(
        {
          people: [aPerson()],
          opportunities: [anOpportunity()],
          failMutations: ['updateOpportunity'],
        },
        { toLane: 'proposal' },
      );

      expect(status).toBe(200);
      expect((body as AdvanceResponse).notices.join(' ')).toContain('could not move');
      expect(auditRows(client)).toHaveLength(1);
    });

    it('should return the card and a notice when the handoff insert is rejected', async () => {
      const { client, status, body } = await advance({
        people: [aPerson()],
        failMutations: ['createOpportunity'],
      });

      expect(status).toBe(200);
      expect((body as AdvanceResponse).createdOpportunityId).toBeNull();
      expect((body as AdvanceResponse).notices.join(' ')).toContain(
        'could not open a deal',
      );
      expect(auditRows(client)).toHaveLength(1);
    });

    it('should still move the card when the audit row cannot be written, and say so loudly', async () => {
      const { status, body } = await advance({
        people: [aPerson()],
        failMutations: ['createGreenlightAuditLog'],
      });

      expect(status).toBe(200);
      expect((body as AdvanceResponse).createdOpportunityId).toBe('opportunity-1');
      expect((body as AdvanceResponse).notices.join(' ')).toContain(
        'could not write the move to its audit log',
      );
    });

    it('should say the card is gone rather than inventing one', async () => {
      const { status, body } = await advance({ people: [] });

      expect(status).toBe(404);
      expect((body as PipelineErrorResponse).code).toBe('not_found');
    });

    it('should refuse only a request it cannot understand', () => {
      expect(
        parsePipelineRequest({
          action: 'advance',
          leadId: null,
          opportunityId: null,
          toLane: 'new',
        }).ok,
      ).toBe(false);

      expect(
        parsePipelineRequest({
          action: 'advance',
          leadId: 'person-a',
          opportunityId: null,
          toLane: 'not-a-lane',
        }).ok,
      ).toBe(false);
    });
  });

  it('should work from an opportunity id alone, for a deal with no linked lead', async () => {
    const { client, status, body } = await advance(
      {
        people: [],
        opportunities: [anOpportunity({ pointOfContactId: null })],
      },
      { leadId: null, opportunityId: 'opportunity-a', toLane: 'customer' },
    );

    expect(status).toBe(200);
    expect((body as AdvanceResponse).card.lane).toBe('customer');
    expect(client.created['updateOpportunity']?.[0]).toMatchObject({
      stage: 'CUSTOMER',
    });
  });
});
