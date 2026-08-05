import { describe, expect, it, vi } from 'vitest';

import {
  parsePipelineRequest,
  runPipelineCommand,
  type CaptureEnrichPort,
  type CaptureScorePort,
} from 'src/logic-functions/pipeline-run';
import type { CaptureRequest, CaptureResponse, PipelineErrorResponse } from 'src/pipeline/wire';

import { mutationData } from 'src/logic-functions/__tests__/fake-client';
import {
  aCompany,
  aPerson,
  createFakeWorkspace,
  type FakeWorkspace,
  type FakeWorkspaceOptions,
} from 'src/logic-functions/__tests__/pipeline-fakes';

const NOW = new Date('2026-08-06T09:00:00.000Z');

const REQUEST: CaptureRequest = {
  action: 'capture',
  firstName: 'Priya',
  lastName: 'Raman',
  email: 'priya@northwind.example',
  companyName: 'Northwind Logistics',
};

const capture = async (
  options: FakeWorkspaceOptions,
  request: Partial<CaptureRequest> = {},
  ports: {
    enrich?: CaptureEnrichPort | null;
    score?: CaptureScorePort | null;
  } = {},
): Promise<{
  client: FakeWorkspace;
  body: CaptureResponse | PipelineErrorResponse;
  status: number;
}> => {
  const client = createFakeWorkspace(options);

  const outcome = await runPipelineCommand(
    { ...REQUEST, ...request },
    {
      client,
      now: NOW,
      actor: 'Workspace member wm-1',
      enrich: ports.enrich ?? null,
      score: ports.score ?? null,
    },
  );

  return {
    client,
    status: outcome.status,
    body: outcome.body as CaptureResponse | PipelineErrorResponse,
  };
};

const companyMutations = (client: FakeWorkspace): string[] =>
  client.mutationNames().filter((name) => name.toLowerCase().includes('company'));

describe('capture', () => {
  describe('the request', () => {
    it('should refuse a body with no name', () => {
      const parsed = parsePipelineRequest({
        action: 'capture',
        firstName: '  ',
        lastName: '',
        email: 'a@b.co',
      });

      expect(parsed).toEqual({
        ok: false,
        message: 'Give this person a name before saving them.',
      });
    });

    it('should refuse an address nobody can write to', () => {
      const parsed = parsePipelineRequest({
        action: 'capture',
        firstName: 'Priya',
        lastName: 'Raman',
        email: 'priya-at-northwind',
      });

      expect(parsed.ok).toBe(false);
    });

    it('should accept a first name alone', () => {
      const parsed = parsePipelineRequest({
        action: 'capture',
        firstName: 'Priya',
        email: 'priya@northwind.example',
      });

      expect(parsed.ok).toBe(true);
    });
  });

  describe('dedupe — the company', () => {
    it('should link an existing company by domain, taken from the website', async () => {
      const { client, body } = await capture(
        { companies: [aCompany()] },
        { companyName: 'Northwind', companyWebsite: 'https://www.northwind.example/about' },
      );

      expect((body as CaptureResponse).matchedExistingCompany).toBe(true);
      expect(companyMutations(client)).toEqual([]);
      expect(mutationData(client.callsTo('createPerson')[0] ?? {})['companyId']).toBe(
        'company-a',
      );
    });

    it('should link an existing company by domain, taken from the email address', async () => {
      const { client, body } = await capture(
        { companies: [aCompany()] },
        { companyName: undefined, companyWebsite: undefined },
      );

      expect((body as CaptureResponse).matchedExistingCompany).toBe(true);
      expect(companyMutations(client)).toEqual([]);
    });

    it('should not let a lookalike domain claim a lead', async () => {
      // `ilike '%northwind.example%'` matches `notnorthwind.example` too. The
      // confirmation on the normalised key is what stops the lead being filed
      // under somebody else's account.
      const { client, body } = await capture({
        companies: [
          aCompany({
            id: 'company-x',
            name: 'Not Northwind',
            domainName: { primaryLinkUrl: 'https://notnorthwind.example' },
          }),
        ],
      });

      expect((body as CaptureResponse).matchedExistingCompany).toBe(false);
      expect(client.created['createCompany']).toHaveLength(1);
    });

    it('should fall back to an exact name match when no domain matches', async () => {
      const { client, body } = await capture(
        {
          companies: [
            aCompany({ id: 'company-b', domainName: { primaryLinkUrl: null } }),
          ],
        },
        { companyWebsite: undefined, email: 'priya@gmail.example' },
      );

      expect((body as CaptureResponse).matchedExistingCompany).toBe(true);
      expect(companyMutations(client)).toEqual([]);
      expect(mutationData(client.callsTo('createPerson')[0] ?? {})['companyId']).toBe(
        'company-b',
      );
    });

    it('should insert a company only when neither lookup found one', async () => {
      const { client, body } = await capture({ companies: [] });

      expect((body as CaptureResponse).matchedExistingCompany).toBe(false);
      expect(client.created['createCompany']).toHaveLength(1);
      expect(client.created['createCompany']?.[0]).toMatchObject({
        name: 'Northwind Logistics',
        domainName: { primaryLinkUrl: 'https://northwind.example' },
      });
    });

    it('should create the lead without a company when there is nothing to identify one by', async () => {
      // No name, no website, and an email whose domain is a mailbox provider is
      // still a domain — so this is the genuinely empty case.
      const { client, body } = await capture(
        { companies: [] },
        { companyName: undefined, companyWebsite: undefined, email: 'priya@x' },
      );

      // `priya@x` has no dot, so `domainKey` refuses it.
      expect(companyMutations(client)).toEqual([]);
      expect((body as CaptureResponse).notices.join(' ')).toContain(
        'without a company',
      );
    });
  });

  describe('never modifying a company a human curated', () => {
    it('should issue no company mutation at all when an existing company is linked', async () => {
      const { client } = await capture({ companies: [aCompany()] });

      expect(companyMutations(client)).toEqual([]);
    });

    it('should never issue an update against Company on any capture path', async () => {
      for (const options of [
        { companies: [aCompany()] },
        { companies: [] },
        { companies: [aCompany({ domainName: { primaryLinkUrl: null } })] },
      ]) {
        const { client } = await capture(options);

        expect(
          client.mutationNames().filter((name) => /^update.*company/i.test(name)),
        ).toEqual([]);
      }
    });

    it('should leave a matched company’s own fields exactly as they were', async () => {
      const existing = aCompany({ name: 'Northwind Logistics Ltd' });
      const { client, body } = await capture(
        { companies: [existing] },
        { companyName: 'Northwind Logistics Limited' },
      );

      // The request carried a different name for the same domain. The linked
      // record keeps the name a human gave it; nothing is patched to agree with
      // what was typed into the drawer.
      expect((body as CaptureResponse).matchedExistingCompany).toBe(true);
      expect(client.created['updateCompany']).toBeUndefined();
      expect(existing['name']).toBe('Northwind Logistics Ltd');
    });
  });

  describe('dedupe — the person', () => {
    it('should open the lead that already exists rather than creating a second', async () => {
      const { client, body } = await capture({
        people: [aPerson()],
        companies: [aCompany()],
      });

      const response = body as CaptureResponse;

      expect(response.matchedExistingPerson).toBe(true);
      expect(client.created['createPerson']).toBeUndefined();
      expect(companyMutations(client)).toEqual([]);
      expect(response.card.leadId).toBe('person-a');
      expect(response.notices.join(' ')).toContain('already in this workspace');
    });

    it('should create the person when the address is new', async () => {
      const { client, body } = await capture({ people: [aPerson()] }, {
        email: 'someone-else@northwind.example',
      });

      expect((body as CaptureResponse).matchedExistingPerson).toBe(false);
      expect(client.created['createPerson']).toHaveLength(1);
    });
  });

  describe('the chain', () => {
    it('should enrich and then score, and return the placed card', async () => {
      const order: string[] = [];
      const enrich = vi.fn(async () => {
        order.push('enrich');
      });
      const score = vi.fn(async () => {
        order.push('score');
      });

      const { body } = await capture({}, {}, { enrich, score });

      expect(order).toEqual(['enrich', 'score']);
      expect(enrich).toHaveBeenCalledWith('person-1');
      expect((body as CaptureResponse).card.leadId).toBe('person-1');
      expect((body as CaptureResponse).card.actions.length).toBeGreaterThan(0);
    });
  });

  describe('fail-open', () => {
    it('should create the lead without a company when the insert is rejected', async () => {
      const { client, body } = await capture({ failMutations: ['createCompany'] });

      expect(client.created['createPerson']).toHaveLength(1);
      expect((body as CaptureResponse).notices.join(' ')).toContain(
        'could not create the company',
      );
    });

    it('should create the lead when the company lookups themselves fail', async () => {
      const { client, body } = await capture({
        companies: [aCompany()],
        failCompanyLookups: true,
      });

      // A rejected probe degrades to "no match found", whose cost is a duplicate
      // company a human can merge — never a failed capture.
      expect(client.created['createCompany']).toHaveLength(1);
      expect((body as CaptureResponse).action).toBe('capture');
    });

    it('should keep the lead and say so when enrichment fails', async () => {
      const { client, body } = await capture(
        {},
        {},
        {
          enrich: async () => {
            throw new Error('provider timed out');
          },
        },
      );

      expect(client.created['createPerson']).toHaveLength(1);
      expect((body as CaptureResponse).notices.join(' ')).toContain(
        'could not look it up against your providers',
      );
    });

    it('should keep the lead and say so when scoring fails', async () => {
      const { body } = await capture(
        {},
        {},
        {
          score: async () => {
            throw new Error('scoring blew up');
          },
        },
      );

      expect((body as CaptureResponse).notices.join(' ')).toContain(
        'could not be scored just now',
      );
      expect((body as CaptureResponse).card).toBeDefined();
    });

    it('should say plainly that nothing was saved when the person cannot be created', async () => {
      const { status, body } = await capture({ failMutations: ['createPerson'] });

      expect(status).toBe(502);
      expect(body.action).toBe('error');
      expect((body as PipelineErrorResponse).code).toBe('unavailable');
      expect((body as PipelineErrorResponse).message).toContain('Nothing was saved');
    });

    it('should still capture when the configuration cannot be read', async () => {
      const { client, body } = await capture({ failConfigRead: true });

      expect(client.created['createPerson']).toHaveLength(1);
      expect((body as CaptureResponse).notices.join(' ')).toContain(
        'shipped defaults',
      );
    });
  });
});
