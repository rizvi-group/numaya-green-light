import { describe, expect, it } from 'vitest';

import { resolveConfig } from 'src/scoring';
import { toScoringConfigInput } from 'src/logic-functions/greenlight-config-record';

import type { CompanyFacts, CompanyFieldPaths } from 'src/icp/icp-analysis';
import {
  MIN_KNOWN_VALUES,
  applyIcpToConfigInput,
  proposeIcpFromCompanies,
  toIcpConfigPatch,
} from 'src/icp/icp-proposal';

const PATHS: CompanyFieldPaths = {
  industry: ['industry'],
  region: ['address.addressCountry'],
  size: ['employees'],
};

let sequence = 0;

const company = ({
  industries = [] as string[],
  regions = [] as string[],
  employeeCount = null as number | null,
}): CompanyFacts => {
  sequence += 1;

  return {
    id: `company-${sequence}`,
    name: `Company ${sequence}`,
    industries,
    regions,
    employeeCount,
  };
};

const repeat = <T,>(count: number, make: (index: number) => T): T[] =>
  Array.from({ length: count }, (_, index) => make(index));

const propose = (companies: CompanyFacts[], totalCompanies: number | null = null) =>
  proposeIcpFromCompanies({
    companies,
    totalCompanies: totalCompanies ?? companies.length,
    paths: PATHS,
  });

describe('proposeIcp — refusing to guess', () => {
  it('proposes nothing at all for a workspace with no companies', () => {
    const proposal = propose([]);

    expect(proposal.industry.proposed).toBe(false);
    expect(proposal.region.proposed).toBe(false);
    expect(proposal.size.proposed).toBe(false);
    expect(proposal.industry.reason).toContain('no companies');
    expect(proposal.selection).toEqual({
      industries: [],
      regions: [],
      sizeBands: [],
    });
  });

  it('says so plainly when companies exist but the industry field is blank on all of them', () => {
    const proposal = propose(repeat(50, () => company({ employeeCount: 30 })));

    expect(proposal.industry.proposed).toBe(false);
    expect(proposal.industry.known).toBe(0);
    expect(proposal.industry.reason).toContain('None of the 50 companies');
    // The dimension that *does* have data is unaffected by the one that does not.
    expect(proposal.size.proposed).toBe(true);
  });

  it('refuses a profile drawn from fewer than the minimum number of values', () => {
    const proposal = propose(
      repeat(MIN_KNOWN_VALUES - 1, () =>
        company({ industries: ['Manufacturing'] }),
      ),
    );

    expect(proposal.industry.proposed).toBe(false);
    expect(proposal.industry.reason).toContain('too few');
    // The values found are still offered, so a human can start from them.
    expect(proposal.industry.alternatives).toHaveLength(1);
  });

  it('refuses a long uniform tail, where every industry has one or two companies', () => {
    const proposal = propose(
      repeat(120, (index) =>
        company({ industries: [`Industry ${Math.floor(index / 2)}`] }),
      ),
    );

    expect(proposal.industry.proposed).toBe(false);
    expect(proposal.industry.distinctValues).toBe(60);
    expect(proposal.industry.reason).toContain('no clear cluster');
    expect(proposal.selection.industries).toEqual([]);
  });

  it('refuses when every industry appears exactly once', () => {
    const proposal = propose(
      repeat(40, (index) => company({ industries: [`Industry ${index}`] })),
    );

    expect(proposal.industry.proposed).toBe(false);
  });
});

describe('proposeIcp — when the data does have a shape', () => {
  it('proposes the dominant industry and stops once coverage is reached', () => {
    const proposal = propose([
      ...repeat(50, () => company({ industries: ['Manufacturing'] })),
      ...repeat(5, () => company({ industries: ['Retail'] })),
      ...repeat(5, () => company({ industries: ['Legal'] })),
    ]);

    expect(proposal.industry.proposed).toBe(true);
    expect(proposal.industry.suggestions.map((one) => one.label)).toEqual([
      'Manufacturing',
    ]);
    expect(proposal.industry.alternatives.map((one) => one.label)).toEqual([
      'Legal',
      'Retail',
    ]);
    expect(proposal.industry.confidence).toBe('high');
    expect(proposal.selection.industries).toEqual(['Manufacturing']);
  });

  it('writes every spelling of a clustered industry, not just the label', () => {
    const proposal = propose([
      ...repeat(20, () => company({ industries: ['SaaS'] })),
      ...repeat(15, () => company({ industries: ['saas'] })),
      ...repeat(10, () => company({ industries: ['Software Services'] })),
    ]);

    // The two SaaS spellings normalise to one target; "Software Services" is a
    // separate literal and has to be written separately or it would never match.
    expect(proposal.selection.industries).toContain('SaaS');
    expect(proposal.selection.industries).toContain('Software Services');
  });

  it('drops confidence when the field is only filled in on a few records', () => {
    const proposal = propose([
      ...repeat(15, () => company({ industries: ['Manufacturing'] })),
      ...repeat(200, () => company({})),
    ]);

    expect(proposal.industry.proposed).toBe(true);
    expect(proposal.industry.confidence).toBe('low');
    expect(proposal.industry.coverage).toBeLessThan(0.1);
  });

  it('never proposes more than the suggestion cap', () => {
    const proposal = propose(
      repeat(200, (index) => company({ industries: [`Industry ${index % 20}`] })),
    );

    expect(proposal.industry.suggestions.length).toBeLessThanOrEqual(12);
  });

  it('proposes regions without merging spellings', () => {
    const proposal = propose([
      ...repeat(20, () => company({ regions: ['United States'] })),
      ...repeat(20, () => company({ regions: ['US'] })),
    ]);

    expect(proposal.region.proposed).toBe(true);
    expect(proposal.selection.regions).toEqual(
      expect.arrayContaining(['United States', 'US']),
    );
  });
});

describe('proposeIcp — size bands', () => {
  it('merges the chosen buckets into contiguous bands', () => {
    const proposal = propose([
      ...repeat(30, () => company({ employeeCount: 20 })),
      ...repeat(30, () => company({ employeeCount: 100 })),
      ...repeat(2, () => company({ employeeCount: 40_000 })),
    ]);

    expect(proposal.size.proposed).toBe(true);
    expect(proposal.size.bands).toHaveLength(1);
    expect(proposal.size.bands[0]).toMatchObject({
      minEmployees: 11,
      maxEmployees: 200,
    });
  });

  it('reports how many companies fall outside every band it proposes', () => {
    const proposal = propose([
      ...repeat(40, () => company({ employeeCount: 20 })),
      ...repeat(10, () => company({ employeeCount: 40_000 })),
    ]);

    expect(proposal.size.bands[0]).toMatchObject({
      minEmployees: 11,
      maxEmployees: 50,
    });
    expect(proposal.size.outsideCount).toBeGreaterThan(0);
    expect(proposal.size.outsideShare).toBeCloseTo(0.2, 5);
  });

  it('keeps two separate bands when the chosen buckets are not adjacent', () => {
    const proposal = propose([
      ...repeat(30, () => company({ employeeCount: 5 })),
      ...repeat(30, () => company({ employeeCount: 500 })),
    ]);

    expect(proposal.size.bands).toHaveLength(2);
    expect(proposal.size.bands.map((band) => band.minEmployees)).toEqual([
      1, 201,
    ]);
  });

  it('leaves the top band unbounded rather than inventing a ceiling', () => {
    const proposal = propose(
      repeat(30, () => company({ employeeCount: 20_000 })),
    );

    expect(proposal.size.bands[0]?.maxEmployees).toBeNull();
  });
});

describe('the config patch', () => {
  it('produces exactly the shape the ICP rules parse', () => {
    const patch = toIcpConfigPatch({
      industries: ['Manufacturing', 'SaaS'],
      regions: ['Germany'],
      sizeBands: [
        { label: '11–50 employees', minEmployees: 11, maxEmployees: 50 },
        { label: '5,001+ employees', minEmployees: 5001, maxEmployees: null },
      ],
    });

    expect(patch).toEqual({
      icpIndustries: ['Manufacturing', 'SaaS'],
      icpRegions: ['Germany'],
      icpSizeBands: {
        bands: [
          { label: '11–50 employees', minEmployees: 11, maxEmployees: 50 },
          { label: '5,001+ employees', minEmployees: 5001, maxEmployees: null },
        ],
      },
    });
  });

  it('survives the round trip through the record reader and the engine resolver', () => {
    // The point of this test: a patch that writes cleanly and then gets silently
    // dropped by `resolveIcp` would leave the record showing a profile the
    // engine is not using — worse than not writing at all.
    const patch = toIcpConfigPatch({
      industries: ['Manufacturing'],
      regions: ['Germany'],
      sizeBands: [
        { label: '11–50 employees', minEmployees: 11, maxEmployees: 50 },
        { label: '5,001+ employees', minEmployees: 5001, maxEmployees: null },
      ],
    });

    const { config, degradations } = resolveConfig(
      toScoringConfigInput({ ...patch, id: 'config-1' }),
    );

    expect(config.icp.industries).toEqual(['Manufacturing']);
    expect(config.icp.regions).toEqual(['Germany']);
    expect(config.icp.sizeBands).toEqual([
      { label: '11–50 employees', minEmployees: 11, maxEmployees: 50 },
      { label: '5,001+ employees', minEmployees: 5001, maxEmployees: null },
    ]);
    expect(
      degradations.filter((one) => one.code === 'icp_malformed'),
    ).toEqual([]);
  });

  it('patches a profile into a raw config input without disturbing anything else', () => {
    const patched = applyIcpToConfigInput(
      { gateThreshold: 65, rules: { 'icp.industry': { weight: 20 } } },
      {
        industries: ['Retail'],
        regions: [],
        sizeBands: [
          { label: 'small', minEmployees: 1, maxEmployees: 50 },
        ],
      },
    );

    const { config } = resolveConfig(patched);

    expect(config.gateThreshold).toBe(65);
    expect(config.icp.industries).toEqual(['Retail']);
    expect(config.icp.sizeBands).toHaveLength(1);
  });

  it('tolerates a base config that is not an object', () => {
    expect(
      applyIcpToConfigInput(null, {
        industries: ['Retail'],
        regions: [],
        sizeBands: [],
      }),
    ).toEqual({ icp: { industries: ['Retail'], regions: [], sizeBands: [] } });
  });
});
