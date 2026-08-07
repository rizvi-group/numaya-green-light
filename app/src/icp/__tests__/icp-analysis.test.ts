import { describe, expect, it } from 'vitest';

import {
  analyseCompanies,
  analyseDimension,
  analyseSizes,
  clusterKey,
  findUnmatchedValues,
  toCompanyFacts,
  type CompanyFacts,
  type CompanyFieldPaths,
} from 'src/icp/icp-analysis';

const PATHS: CompanyFieldPaths = {
  industry: ['industry'],
  region: ['address.addressCountry'],
  size: ['employees'],
};

const facts = (
  industries: string[],
  regions: string[] = [],
  employeeCount: number | null = null,
  name = 'Acme',
): CompanyFacts => ({
  id: `${name}-${industries.join('|')}-${employeeCount ?? 'x'}`,
  name,
  industries,
  regions,
  employeeCount,
});

describe('toCompanyFacts', () => {
  it('reads industry, country and headcount from a stock-shaped company', () => {
    expect(
      toCompanyFacts(
        {
          id: 'a',
          name: 'Acme',
          industry: 'Manufacturing',
          address: { addressCountry: 'Germany' },
          employees: 240,
        },
        PATHS,
      ),
    ).toEqual({
      id: 'a',
      name: 'Acme',
      industries: ['Manufacturing'],
      regions: ['Germany'],
      employeeCount: 240,
    });
  });

  it('reports a company with nothing set as having nothing set', () => {
    expect(toCompanyFacts({ id: 'a', name: 'Acme' }, PATHS)).toEqual({
      id: 'a',
      name: 'Acme',
      industries: [],
      regions: [],
      employeeCount: null,
    });
  });

  it('survives a node that is not an object at all', () => {
    expect(toCompanyFacts('nonsense', PATHS).industries).toEqual([]);
    expect(toCompanyFacts(null, PATHS).employeeCount).toBeNull();
  });

  it('drops placeholder industries rather than clustering them', () => {
    for (const placeholder of ['n/a', 'Unknown', '--', 'other', '  ']) {
      expect(
        toCompanyFacts({ id: 'a', industry: placeholder }, PATHS).industries,
      ).toEqual([]);
    }
  });

  it('treats a zero or negative headcount as unknown, not as a tiny company', () => {
    expect(toCompanyFacts({ employees: 0 }, PATHS).employeeCount).toBeNull();
    expect(toCompanyFacts({ employees: -4 }, PATHS).employeeCount).toBeNull();
  });

  it('reads a headcount stored as a string, and refuses an implausible one', () => {
    expect(toCompanyFacts({ employees: '120' }, PATHS).employeeCount).toBe(120);
    expect(
      toCompanyFacts({ employees: 9_000_000 }, PATHS).employeeCount,
    ).toBeNull();
  });

  it('falls back through the candidate paths in order', () => {
    const paths: CompanyFieldPaths = {
      industry: ['industry', 'sector'],
      region: ['region', 'address.addressCountry'],
      size: ['employees', 'headcount'],
    };

    expect(toCompanyFacts({ sector: 'Legal', headcount: 12 }, paths)).toEqual({
      id: null,
      name: null,
      industries: ['Legal'],
      regions: [],
      employeeCount: 12,
    });
  });
});

describe('clusterKey', () => {
  it('merges case, spacing and punctuation variants', () => {
    expect(clusterKey('SaaS')).toBe(clusterKey('saas '));
    expect(clusterKey('E-Commerce')).toBe(clusterKey('ecommerce'));
    expect(clusterKey('Food & Beverage')).toBe(clusterKey('food and beverage'));
  });

  it('merges a trailing generic word and a trailing plural', () => {
    expect(clusterKey('Software Services')).toBe(clusterKey('Software'));
    expect(clusterKey('Logistics')).toBe(clusterKey('Logistic'));
  });

  it('merges spellings that differ only in where the space fell', () => {
    expect(clusterKey('Health Care')).toBe(clusterKey('Healthcare'));
    expect(clusterKey('Real-Estate')).toBe(clusterKey('real estate'));
  });

  it('refuses to merge two words that merely look related', () => {
    expect(clusterKey('Finance')).not.toBe(clusterKey('Financial Services'));
    expect(clusterKey('Health')).not.toBe(clusterKey('Healthcare'));
  });

  it('keeps a generic word that is the whole value', () => {
    expect(clusterKey('Services')).toBe('service');
  });
});

describe('analyseDimension', () => {
  it('reports nothing at all for an empty workspace', () => {
    const analysis = analyseDimension([], (one) => one.industries, {
      merge: true,
    });

    expect(analysis).toMatchObject({
      known: 0,
      total: 0,
      coverage: 0,
      distinctValues: 0,
    });
    expect(analysis.clusters).toEqual([]);
  });

  it('separates "no companies" from "companies with nothing filled in"', () => {
    const analysis = analyseDimension(
      [facts([]), facts([]), facts([])],
      (one) => one.industries,
      { merge: true },
    );

    expect(analysis.total).toBe(3);
    expect(analysis.known).toBe(0);
    expect(analysis.coverage).toBe(0);
  });

  it('clusters free-text variants and carries every spelling forward', () => {
    const analysis = analyseDimension(
      [
        facts(['SaaS'], [], null, 'A'),
        facts(['saas'], [], null, 'B'),
        facts(['SaaS '], [], null, 'C'),
        facts(['Software Services'], [], null, 'D'),
        facts(['Software'], [], null, 'E'),
      ],
      (one) => one.industries,
      { merge: true },
    );

    const saas = analysis.clusters.find((one) => one.label === 'SaaS');
    const software = analysis.clusters.find(
      (one) => one.label === 'Software Services' || one.label === 'Software',
    );

    expect(saas?.count).toBe(3);
    // All three spellings normalise to the same string, so `matchesList` needs
    // exactly one of them in the config — storing the other two would be noise
    // in the record that changes nothing about what matches.
    expect(saas?.values).toEqual(['SaaS']);
    expect(software?.count).toBe(2);
    expect(software?.values).toHaveLength(2);
  });

  it('counts a company once even when it carries two spellings of one industry', () => {
    const analysis = analyseDimension(
      [facts(['SaaS', 'saas'], [], null, 'A')],
      (one) => one.industries,
      { merge: true },
    );

    expect(analysis.clusters[0]?.count).toBe(1);
  });

  it('does not merge regions, because a region list is matched literally', () => {
    const analysis = analyseDimension(
      [
        facts([], ['United States'], null, 'A'),
        facts([], ['US'], null, 'B'),
        facts([], ['united states'], null, 'C'),
      ],
      (one) => one.regions,
      { merge: false },
    );

    expect(analysis.clusters).toHaveLength(2);
    expect(analysis.clusters[0]?.count).toBe(2);
  });

  it('sorts clusters by size and reports the share of companies that have a value', () => {
    const analysis = analyseDimension(
      [
        facts(['Retail'], [], null, 'A'),
        facts(['Retail'], [], null, 'B'),
        facts(['Retail'], [], null, 'C'),
        facts(['Mining'], [], null, 'D'),
        facts([], [], null, 'E'),
      ],
      (one) => one.industries,
      { merge: true },
    );

    expect(analysis.clusters.map((one) => one.label)).toEqual([
      'Retail',
      'Mining',
    ]);
    expect(analysis.known).toBe(4);
    expect(analysis.coverage).toBe(0.8);
    expect(analysis.clusters[0]?.share).toBe(0.75);
  });
});

describe('analyseSizes', () => {
  it('reports no coverage when nobody has a headcount', () => {
    const analysis = analyseSizes([facts([]), facts([])]);

    expect(analysis.known).toBe(0);
    expect(analysis.median).toBeNull();
    expect(analysis.buckets.every((bucket) => bucket.count === 0)).toBe(true);
  });

  it('buckets headcounts and finds the median', () => {
    const analysis = analyseSizes([
      facts([], [], 5),
      facts([], [], 20),
      facts([], [], 30),
      facts([], [], 120),
      facts([], [], 9000),
    ]);

    expect(analysis.known).toBe(5);
    expect(analysis.median).toBe(30);
    expect(analysis.smallest).toBe(5);
    expect(analysis.largest).toBe(9000);
    expect(
      analysis.buckets.find((one) => one.minEmployees === 11)?.count,
    ).toBe(2);
    expect(
      analysis.buckets.find((one) => one.maxEmployees === null)?.count,
    ).toBe(1);
  });

  it('puts every bucket in the output even when it holds nothing', () => {
    expect(analyseSizes([facts([], [], 5)]).buckets).toHaveLength(6);
  });
});

describe('analyseCompanies', () => {
  it('carries the sample size and the discovered paths through', () => {
    const analysis = analyseCompanies({
      companies: [facts(['Retail'], ['France'], 40)],
      totalCompanies: 900,
      paths: PATHS,
    });

    expect(analysis.sampled).toBe(1);
    expect(analysis.totalCompanies).toBe(900);
    expect(analysis.paths).toEqual(PATHS);
    expect(analysis.industry.clusters[0]?.label).toBe('Retail');
    expect(analysis.region.clusters[0]?.label).toBe('France');
    expect(analysis.size.known).toBe(1);
  });
});

describe('findUnmatchedValues', () => {
  const industriesOf = (...values: string[][]) =>
    analyseDimension(
      values.map((one, index) => facts(one, [], null, `Co${index}`)),
      (one) => one.industries,
      { merge: true },
    );

  it('reports nothing when no target industries are set', () => {
    // The rule is not_applicable in this state and accepts everything, so
    // claiming every industry is "unmatched" would be a lie the page then shows.
    const analysis = industriesOf(['Software'], ['Mining'], ['Haulage']);

    expect(findUnmatchedValues(analysis, [])).toEqual({
      clusters: [],
      companies: 0,
      share: 0,
    });
  });

  it('reports nothing when every observed value is on the list', () => {
    const analysis = industriesOf(['Software'], ['Retail']);

    expect(findUnmatchedValues(analysis, ['software', 'retail']).clusters).toEqual(
      [],
    );
  });

  it('names the values the profile would reject, most common first', () => {
    const analysis = industriesOf(
      ['Software'],
      ['Computer and Network Security'],
      ['Computer and Network Security'],
      ['Haulage'],
    );

    const unmatched = findUnmatchedValues(analysis, ['software']);

    expect(unmatched.clusters.map((one) => one.label)).toEqual([
      'Computer and Network Security',
      'Haulage',
    ]);
    expect(unmatched.companies).toBe(3);
    expect(unmatched.share).toBeCloseTo(3 / 4);
  });

  it('matches on the raw variants, not the cluster label', () => {
    // The engine is handed every value on the record and passes on the first
    // hit, so a cluster is matched when ANY spelling in it is listed - even
    // when the label shown to the human is a different spelling.
    const analysis = industriesOf(['SaaS'], ['SaaS'], ['saas ']);

    expect(analysis.clusters[0]?.label).toBe('SaaS');
    expect(findUnmatchedValues(analysis, ['saas']).clusters).toEqual([]);
  });

  it('ignores case and surrounding whitespace, exactly as the engine does', () => {
    const analysis = industriesOf(['Retail']);

    expect(findUnmatchedValues(analysis, ['  RETAIL  ']).clusters).toEqual([]);
  });

  it('does not divide by zero when nothing has a value', () => {
    const analysis = industriesOf([], []);

    expect(findUnmatchedValues(analysis, ['software'])).toEqual({
      clusters: [],
      companies: 0,
      share: 0,
    });
  });
});
