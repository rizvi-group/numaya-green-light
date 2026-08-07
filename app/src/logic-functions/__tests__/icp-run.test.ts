import { describe, expect, it } from 'vitest';

import {
  applyIcpToWorkspace,
  leaveIcpOpen,
  probeCompanyFields,
  proposeIcpForWorkspace,
  readIcpReviewStatus,
} from 'src/logic-functions/icp-run';
import type { BackfillStateStore } from 'src/logic-functions/backfill-run';
import type { BackfillState } from 'src/backfill/backfill-state';

import {
  createFakeClient,
  mutationData,
  type FakeClient,
} from 'src/logic-functions/__tests__/fake-client';

const NOW = new Date('2026-08-03T12:00:00.000Z');

const CONFIG_RECORD = {
  id: 'config-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  icpIndustries: [],
  icpRegions: [],
  icpSizeBands: { bands: [] },
  gateThreshold: 70,
};

interface WorkspaceOptions {
  /** Company field names the fake schema answers to. */
  readonly companyFields?: readonly string[];
  readonly companies?: readonly Record<string, unknown>[];
  readonly people?: readonly Record<string, unknown>[];
  readonly configRecords?: readonly Record<string, unknown>[] | null;
  /**
   * A server **stricter than Twenty 2.26**: one that rejects a selection naming
   * a column it does not have.
   *
   * Labelled rather than deleted. Twenty does not behave this way — see the
   * `companies` branch below — so `loadIcpConfigRecord`'s fall-back cannot fire
   * against the instance this app ships against, and the test that drives this
   * switch says so in its name. It is kept because the rung is kept: selection
   * validation is a property of this release rather than of GraphQL, and if
   * Twenty ever tightened it, this is the behaviour the fall-back exists for.
   */
  readonly reviewColumnsMissing?: boolean;
  /** Make every `updateGreenlightConfig` fail. */
  readonly configWriteFails?: boolean;
}

const nodeFields = (request: Record<string, unknown>, key: string): string[] => {
  const connection = request[key] as Record<string, unknown> | undefined;
  const edges = connection?.['edges'] as Record<string, unknown> | undefined;
  const node = (edges?.['node'] ?? {}) as Record<string, unknown>;

  return Object.keys(node);
};

/**
 * The columns a `filter` argument names.
 *
 * Only the top level, which is where Twenty's *"Object company doesn't have any
 * `X` field"* is decided. Below that a composite's sub-path is checked against
 * the composite's own shape and produces a different complaint (*"Sub field
 * `is` not found for composite type: ADDRESS"*), which nothing here exercises —
 * so this fake stops at the depth it can honestly model.
 */
const filterFields = (request: Record<string, unknown>, key: string): string[] => {
  const connection = request[key] as Record<string, unknown> | undefined;
  const args = connection?.['__args'] as Record<string, unknown> | undefined;
  const filter = args?.['filter'];

  return typeof filter === 'object' && filter !== null
    ? Object.keys(filter as Record<string, unknown>)
    : [];
};

const connection = (
  name: string,
  nodes: readonly Record<string, unknown>[],
): Record<string, unknown> => ({
  [name]: { edges: nodes.map((node) => ({ node })) },
});

const makeWorkspace = (options: WorkspaceOptions = {}): FakeClient => {
  const companyFields = new Set([
    'id',
    'name',
    'createdAt',
    ...(options.companyFields ?? []),
  ]);

  return createFakeClient({
    query: (request) => {
      if ('greenlightConfigs' in request) {
        const asks = nodeFields(request, 'greenlightConfigs');

        if (options.reviewColumnsMissing === true && asks.includes('icpReviewedAt')) {
          throw new Error('Cannot query field "icpReviewedAt"');
        }

        return connection('greenlightConfigs', options.configRecords ?? [CONFIG_RECORD]);
      }

      if ('companies' in request) {
        const node = request['companies'] as Record<string, unknown>;

        if ('totalCount' in node) {
          return { companies: { totalCount: (options.companies ?? []).length } };
        }

        // Only the filter is checked, and this is the whole point of the fake.
        //
        // It used to reject unknown names in the *selection* — which is a server
        // Twenty is not. Twenty validates arguments and leaves selection sets
        // alone: a column Company does not have is selected without complaint
        // and comes back `null`. Modelling the reverse made `probeCompanyFields`
        // look like it could tell a missing industry column from a present one,
        // when live it reported every candidate as present on every workspace.
        // See `probeField` in `icp-run.ts` for what that cost.
        for (const field of filterFields(request, 'companies')) {
          if (!companyFields.has(field)) {
            throw new Error(`Object company doesn't have any "${field}" field.`);
          }
        }

        // Selected-but-absent columns come back `null`, exactly as Twenty
        // returns them, rather than being quietly dropped — which is what makes
        // "the sample has the column and it is empty" and "the workspace has no
        // such column" look identical to a caller, as they do live.
        const absent = nodeFields(request, 'companies').filter(
          (field) => !companyFields.has(field),
        );

        return connection(
          'companies',
          (options.companies ?? []).map((company) => ({
            ...Object.fromEntries(absent.map((field) => [field, null])),
            ...company,
          })),
        );
      }

      if ('people' in request) {
        const node = request['people'] as Record<string, unknown>;

        if ('totalCount' in node) {
          return { people: { totalCount: (options.people ?? []).length } };
        }

        return connection('people', options.people ?? []);
      }

      return {};
    },
    mutation: (request) => {
      if (options.configWriteFails === true && 'updateGreenlightConfig' in request) {
        throw new Error('permission denied');
      }

      if ('updateGreenlightConfig' in request) {
        return { updateGreenlightConfig: { id: 'config-1' } };
      }

      return { createGreenlightAuditLog: { id: 'audit-1' } };
    },
  });
};

const memoryStore = (): BackfillStateStore & { state: BackfillState | null } => {
  const store = {
    state: null as BackfillState | null,
    read: async () => store.state,
    write: async (state: BackfillState) => {
      store.state = state;
    },
  };

  return store;
};

const deps = (client: FakeClient) => ({
  client,
  store: memoryStore(),
  now: NOW,
  requestedBy: 'Workspace member 42',
});

describe('readIcpReviewStatus', () => {
  it('reports the idle points from the workspace’s own config record', async () => {
    const outcome = await readIcpReviewStatus({ client: makeWorkspace() });

    expect(outcome.status).toBe(200);
    expect(outcome.body.outcome).toBe('ok');
    expect(outcome.body.status?.idlePoints).toBe(40);
    expect(outcome.body.status?.review.decision).toBe('NOT_REVIEWED');
  });

  it('says plainly when there is no configuration record to review', async () => {
    const outcome = await readIcpReviewStatus({
      client: makeWorkspace({ configRecords: [] }),
    });

    expect(outcome.body.outcome).toBe('config_missing');
    expect(outcome.body.status).toBeNull();
  });

  /**
   * Against Twenty this cannot happen, and the name says so.
   *
   * Selection sets are not validated, so the extended read succeeds on every
   * workspace and the fall-back rung is unreachable. The rung and this test are
   * both kept for the server that tightened, not for the one we ship against —
   * see `loadIcpConfigRecord` and `WorkspaceOptions.reviewColumnsMissing`.
   */
  it('falls back to the shipped selection on a server stricter than Twenty', async () => {
    const outcome = await readIcpReviewStatus({
      client: makeWorkspace({ reviewColumnsMissing: true }),
    });

    expect(outcome.body.outcome).toBe('ok');
    expect(outcome.body.status?.idlePoints).toBe(40);
  });

  /**
   * And this is what actually happens on Twenty: one read, no fall-back, and a
   * review column the workspace does not have arrives as `null` rather than as
   * an error. The panel is still correct — `NOT_REVIEWED` is the right answer
   * for a record with no decision on it — which is why the unreachable rung was
   * never noticed and why nothing depends on it.
   */
  it('reads the review columns in a single request on a real Twenty', async () => {
    const client = makeWorkspace();
    const outcome = await readIcpReviewStatus({ client });

    expect(outcome.body.outcome).toBe('ok');
    expect(outcome.body.status?.review.decision).toBe('NOT_REVIEWED');
    expect(client.callsTo('greenlightConfigs')).toHaveLength(1);
  });
});

describe('probeCompanyFields', () => {
  it('finds the custom field this workspace happens to use', async () => {
    const probe = await probeCompanyFields(
      makeWorkspace({ companyFields: ['sector', 'employees'] }),
    );

    expect(probe.paths.industry).toEqual(['sector']);
    expect(probe.paths.size).toEqual(['employees']);
    expect(probe.selection['sector']).toBe(true);
    expect(probe.notes.join(' ')).toContain('Company.sector');
  });

  it('reports the absence of an industry field as the real problem it is', async () => {
    const probe = await probeCompanyFields(
      makeWorkspace({ companyFields: ['employees'] }),
    );

    expect(probe.paths.industry).toEqual([]);
    expect(probe.notes.join(' ')).toContain('no industry field on Company');
  });

  it('reads the stock address composite when it is available', async () => {
    const probe = await probeCompanyFields(
      makeWorkspace({ companyFields: ['address'] }),
    );

    expect(probe.paths.region).toEqual(['address.addressCountry']);
  });
});

describe('proposeIcpForWorkspace', () => {
  const companies = [
    ...Array.from({ length: 40 }, (_, index) => ({
      id: `company-${index}`,
      name: `Maker ${index}`,
      createdAt: '2026-02-01T00:00:00.000Z',
      industry: 'Manufacturing',
      employees: 120,
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `other-${index}`,
      name: `Shop ${index}`,
      createdAt: '2026-02-01T00:00:00.000Z',
      industry: 'Retail',
      employees: 4,
    })),
  ];

  it('derives a profile from the workspace’s own companies and measures it', async () => {
    const client = makeWorkspace({
      companyFields: ['industry', 'employees'],
      companies,
      people: [
        {
          id: 'person-1',
          createdAt: '2026-03-01T00:00:00.000Z',
          updatedAt: '2026-08-03T00:00:00.000Z',
          name: { firstName: 'Jane', lastName: 'Roe' },
          emails: { primaryEmail: 'jane@acme.com' },
          jobTitle: 'CEO',
          company: { id: 'c', name: 'Acme' },
        },
      ],
    });

    const outcome = await proposeIcpForWorkspace({ client, now: NOW });

    expect(outcome.body.outcome).toBe('proposed');
    expect(outcome.body.proposal?.industry.suggestions[0]?.label).toBe(
      'Manufacturing',
    );
    expect(outcome.body.selection?.industries).toEqual(['Manufacturing']);
    expect(outcome.body.impact?.sampled).toBe(1);
    expect(outcome.body.notes.join(' ')).toContain('Company.industry');

    // Nothing may be written by a proposal.
    expect(client.mutationNames()).toEqual([]);
  });

  it('names the industries the workspace holds that the profile rejects', async () => {
    // The worst outcome this product can produce: enrichment fills the industry
    // in, the score does not move, and nothing says why. The profile accepts
    // Manufacturing; four companies are Retail and score as a miss forever.
    const client = makeWorkspace({
      companyFields: ['industry', 'employees'],
      companies,
      configRecords: [{ ...CONFIG_RECORD, icpIndustries: ['Manufacturing'] }],
    });

    const outcome = await proposeIcpForWorkspace({ client, now: NOW });

    expect(outcome.body.unmatched?.industry.clusters.map((one) => one.label)).toEqual(
      ['Retail'],
    );
    expect(outcome.body.unmatched?.industry.companies).toBe(4);
    expect(outcome.body.notes.join(' ')).toContain(
      'your profile does not accept: Retail (4)',
    );
    // Naming a mismatch must never move a score or write anything.
    expect(client.mutationNames()).toEqual([]);
  });

  it('reports no mismatch when the profile already lists every industry seen', async () => {
    const client = makeWorkspace({
      companyFields: ['industry', 'employees'],
      companies,
      configRecords: [
        { ...CONFIG_RECORD, icpIndustries: ['Manufacturing', 'Retail'] },
      ],
    });

    const outcome = await proposeIcpForWorkspace({ client, now: NOW });

    expect(outcome.body.unmatched?.industry.clusters).toEqual([]);
    expect(outcome.body.notes.join(' ')).not.toContain('does not accept');
  });

  it('claims no mismatch at all while the profile is still empty', async () => {
    // An unset profile accepts every industry, so reporting 2 "unmatched" here
    // would contradict the rule and the panel directly above it.
    const client = makeWorkspace({
      companyFields: ['industry', 'employees'],
      companies,
    });

    const outcome = await proposeIcpForWorkspace({ client, now: NOW });

    expect(outcome.body.unmatched?.industry.clusters).toEqual([]);
    expect(outcome.body.notes.join(' ')).not.toContain('does not accept');
  });

  it('proposes nothing when the schema has no industry field, and says why', async () => {
    const outcome = await proposeIcpForWorkspace({
      client: makeWorkspace({
        companyFields: ['employees'],
        companies: companies.map(({ industry: _industry, ...rest }) => rest),
      }),
      now: NOW,
    });

    expect(outcome.body.proposal?.industry.proposed).toBe(false);
    expect(outcome.body.notes.join(' ')).toContain('no industry field');
  });

  it('survives a workspace with no companies at all', async () => {
    const outcome = await proposeIcpForWorkspace({
      client: makeWorkspace({ companyFields: ['industry'] }),
      now: NOW,
    });

    expect(outcome.body.outcome).toBe('proposed');
    expect(outcome.body.selection).toEqual({
      industries: [],
      regions: [],
      sizeBands: [],
    });
  });
});

describe('applyIcpToWorkspace', () => {
  const selection = {
    industries: ['Manufacturing'],
    regions: [],
    sizeBands: [
      { label: '51–200 employees', minEmployees: 51, maxEmployees: 200 },
    ],
  };

  it('writes the profile and the review stamp in one patch, and audits it', async () => {
    const client = makeWorkspace();
    const outcome = await applyIcpToWorkspace({
      ...deps(client),
      selection,
      warnings: [],
      rescore: false,
    });

    expect(outcome.status).toBe(200);
    expect(outcome.body.outcome).toBe('applied');

    const written = mutationData(client.callsTo('updateGreenlightConfig')[0] ?? {});

    expect(written['icpIndustries']).toEqual(['Manufacturing']);
    expect(written['icpSizeBands']).toEqual({ bands: selection.sizeBands });
    expect(written['icpReviewDecision']).toBe('APPLIED');
    expect(written['icpReviewedAt']).toBe(NOW.toISOString());

    const audit = mutationData(client.callsTo('createGreenlightAuditLog')[0] ?? {});

    expect(audit['eventType']).toBe('CONFIG_CHANGED');
    expect(audit['actorDisplayName']).toBe('Workspace member 42');
    expect(
      (audit['ruleTrace'] as Record<string, unknown>)['action'],
    ).toBe('icp_applied');
    // What the person was told this would do, recorded at the moment they said
    // yes — not what a screen said ten minutes earlier.
    expect(
      (audit['ruleTrace'] as Record<string, unknown>)['impact'],
    ).toBeDefined();
  });

  it('does not touch the backfill unless a re-score was asked for', async () => {
    const dependencies = deps(makeWorkspace());

    await applyIcpToWorkspace({
      ...dependencies,
      selection,
      warnings: [],
      rescore: false,
    });

    expect(dependencies.store.state).toBeNull();
  });

  it('re-scores by starting the existing backfill in "all" mode', async () => {
    const dependencies = deps(makeWorkspace());

    const outcome = await applyIcpToWorkspace({
      ...dependencies,
      selection,
      warnings: [],
      rescore: true,
    });

    expect(dependencies.store.state?.mode).toBe('all');
    expect(dependencies.store.state?.status).toBe('running');
    expect(dependencies.store.state?.requestedBy).toContain('ICP change');
    expect(outcome.body.rescore?.started).toBe(true);
  });

  it('writes the profile even when the review columns cannot be written', async () => {
    const client = createFakeClient({
      query: makeWorkspace().query,
      mutation: (request) => {
        if ('updateGreenlightConfig' in request) {
          const data = mutationData(
            request['updateGreenlightConfig'] as Record<string, unknown>,
          );

          if ('icpReviewDecision' in data) {
            throw new Error('Unknown field icpReviewDecision');
          }
        }

        return {};
      },
    });

    const outcome = await applyIcpToWorkspace({
      ...deps(client),
      selection,
      warnings: [],
      rescore: false,
    });

    expect(outcome.body.outcome).toBe('applied');
    expect(outcome.body.message).toContain('could not stamp the review date');

    const second = mutationData(client.callsTo('updateGreenlightConfig')[1] ?? {});

    expect(second['icpIndustries']).toEqual(['Manufacturing']);
    expect(second['icpReviewDecision']).toBeUndefined();
  });

  it('changes nothing and says so when the write fails outright', async () => {
    const outcome = await applyIcpToWorkspace({
      ...deps(makeWorkspace({ configWriteFails: true })),
      selection,
      warnings: [],
      rescore: false,
    });

    expect(outcome.status).toBe(502);
    expect(outcome.body.outcome).toBe('write_failed');
    expect(outcome.body.message).toContain('nothing has changed');
  });

  it('refuses to write when there is no configuration record', async () => {
    const client = makeWorkspace({ configRecords: [] });

    await applyIcpToWorkspace({
      ...deps(client),
      selection,
      warnings: [],
      rescore: false,
    });

    expect(client.callsTo('updateGreenlightConfig')).toEqual([]);
  });
});

describe('leaveIcpOpen', () => {
  it('records the decision without touching the profile', async () => {
    const client = makeWorkspace();
    const outcome = await leaveIcpOpen({
      client,
      now: NOW,
      requestedBy: 'Workspace member 42',
    });

    expect(outcome.body.outcome).toBe('left_open');
    expect(outcome.body.status?.review.decision).toBe('LEFT_OPEN');
    expect(outcome.body.status?.idlePoints).toBe(40);

    const written = mutationData(client.callsTo('updateGreenlightConfig')[0] ?? {});

    expect(written).toEqual({
      icpReviewedAt: NOW.toISOString(),
      icpReviewDecision: 'LEFT_OPEN',
    });
  });

  it('keeps asking, and says why, when the decision cannot be recorded', async () => {
    const outcome = await leaveIcpOpen({
      client: makeWorkspace({ configWriteFails: true }),
      now: NOW,
      requestedBy: 'Workspace member 42',
    });

    expect(outcome.status).toBe(502);
    expect(outcome.body.message).toContain('keep asking');
  });
});
