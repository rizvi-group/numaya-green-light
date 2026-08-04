/**
 * Reading the workspace's own Company records and finding the shape in them.
 *
 * Pure — no client, no clock, no SDK — for the same reason `src/scoring/` is:
 * this is the part that has to behave sensibly against data nobody has seen, and
 * the only way to assert that is to hand it the awkward shapes directly. The
 * awkward shapes are not hypothetical: no companies at all, an `industry` field
 * that does not exist on the object, an `industry` field that exists and is
 * blank on every record, free text where "SaaS", "saas " and "SaaS " are three
 * strings and one industry, one industry holding 90% of the book, and a tail of
 * two hundred industries with two companies each.
 *
 * ## What this module refuses to do
 *
 * It never invents a value. Every cluster it reports is a string somebody in the
 * workspace typed, counted, with the raw variants kept. Greenlight cannot know a
 * customer's target market, and the moment this file starts mapping "Software"
 * onto a taxonomy of our choosing it is guessing on the customer's behalf — which
 * is the thing the permissive default exists to avoid.
 *
 * ## Clustering, and why the raw variants are carried forward
 *
 * `icp.industry` matches with `matchesList`, which compares
 * `normalise(value) === normalise(target)` — trim, lowercase, collapse runs of
 * whitespace, and nothing else. So "Software" and "software " are one target;
 * "Software" and "Software Development" are two, and writing only the first would
 * silently fail every lead carrying the second.
 *
 * Clustering here is therefore for *presentation and evidence* only. A cluster
 * groups variants a human would call one industry so the panel can say "Software
 * — 214 companies (31%)" instead of listing nine spellings, and it carries every
 * raw variant with it so that accepting the cluster writes all nine into the
 * config. Merge for the human, match on the literals.
 */

import { getByPath, isPlainObject, stringLeaves } from 'src/scoring/field-access';
import { normalise } from 'src/scoring/rules/helpers';

/* -------------------------------------------------------------------------- */
/* Where the facts live on a Company                                           */
/* -------------------------------------------------------------------------- */

/**
 * Industry field names worth probing for, in order of how likely they are to be
 * the one.
 *
 * Twenty's stock Company object has **no industry field**. It ships `name`,
 * `domainName`, `address`, `employees`, `linkedinLink`, `xLink`,
 * `annualRecurringRevenue`, `idealCustomerProfile` and `accountOwner`. Industry,
 * where it exists at all, is a custom field the workspace added, so its name is
 * unknowable at build time and has to be discovered against the live schema —
 * see `probeCompanyFields` in `src/logic-functions/icp-run.ts`.
 *
 * A single-token list, not dotted paths: each of these is probed with its own
 * cheap query, because an unknown field name fails the whole GraphQL request and
 * one probe per candidate is the only way to learn which ones exist.
 */
export const COMPANY_INDUSTRY_FIELD_CANDIDATES: readonly string[] = [
  'industry',
  'industries',
  'sector',
  'vertical',
  'companyIndustry',
  'businessType',
];

/**
 * Region paths, deliberately the same candidates the scoring engine's default
 * field mapping uses for `region`, minus the ones that only make sense on a
 * Person. `address` is a stock composite, so `address.addressCountry` is the one
 * that usually answers.
 */
export const COMPANY_REGION_FIELD_CANDIDATES: readonly string[] = [
  'region',
  'country',
];

/** Read after `address` has been selected as a composite. */
export const COMPANY_ADDRESS_REGION_PATH = 'address.addressCountry';

/**
 * Headcount candidates. `employees` is the stock field; the rest are the names
 * workspaces that outgrew it tend to pick.
 */
export const COMPANY_SIZE_FIELD_CANDIDATES: readonly string[] = [
  'employees',
  'employeeCount',
  'numberOfEmployees',
  'headcount',
  'companySize',
];

/* -------------------------------------------------------------------------- */
/* Facts                                                                       */
/* -------------------------------------------------------------------------- */

/** One company, reduced to the three things an ICP is made of. */
export interface CompanyFacts {
  readonly id: string | null;
  readonly name: string | null;
  /** Every industry-ish string on the record, raw and untouched. */
  readonly industries: readonly string[];
  readonly regions: readonly string[];
  /** Null when absent, unparseable, or not a plausible headcount. */
  readonly employeeCount: number | null;
}

/** Which field names the live schema actually answered to. */
export interface CompanyFieldPaths {
  readonly industry: readonly string[];
  readonly region: readonly string[];
  readonly size: readonly string[];
}

const readStrings = (
  node: Record<string, unknown>,
  paths: readonly string[],
): string[] => {
  const seen = new Set<string>();
  const values: string[] = [];

  for (const path of paths) {
    for (const leaf of stringLeaves(getByPath(node, path))) {
      const key = normalise(leaf);

      // A placeholder is worse than a blank: it clusters, it looks like
      // evidence, and it would be written into the config as a target industry.
      if (key.length === 0 || IGNORED_VALUES.has(key)) {
        continue;
      }

      if (!seen.has(key)) {
        seen.add(key);
        values.push(leaf.trim());
      }
    }
  }

  return values;
};

/**
 * Values that mean "somebody typed something rather than nothing". A subset of
 * the engine's `PLACEHOLDER_VALUES`, plus the two an import tool writes into an
 * industry column.
 */
const IGNORED_VALUES = new Set([
  '-',
  '--',
  '.',
  'n/a',
  'na',
  'n.a.',
  'none',
  'null',
  'nil',
  'unknown',
  'other',
  'others',
  'tbd',
  'tba',
  'test',
  'not set',
  'not provided',
]);

/**
 * A headcount below 1 is not a small company, it is a blank somebody stored as a
 * zero — and treating it as a real value would drag a proposed band's floor down
 * to include every company with no data at all. Anything above a million is a
 * typo. Both are reported as unknown rather than dropped silently: the coverage
 * figure is what tells the human how much of the proposal rests on real data.
 */
const MAX_PLAUSIBLE_HEADCOUNT = 1_000_000;

const readEmployeeCount = (
  node: Record<string, unknown>,
  paths: readonly string[],
): number | null => {
  for (const path of paths) {
    const raw = getByPath(node, path);
    const value =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string' && raw.trim().length > 0
          ? Number(raw.trim())
          : Number.NaN;

    if (
      Number.isFinite(value) &&
      value >= 1 &&
      value <= MAX_PLAUSIBLE_HEADCOUNT
    ) {
      return Math.round(value);
    }
  }

  return null;
};

/** Reduce one fetched Company node to facts. Never throws. */
export const toCompanyFacts = (
  node: unknown,
  paths: CompanyFieldPaths,
): CompanyFacts => {
  if (!isPlainObject(node)) {
    return {
      id: null,
      name: null,
      industries: [],
      regions: [],
      employeeCount: null,
    };
  }

  return {
    id: typeof node['id'] === 'string' ? node['id'] : null,
    name: typeof node['name'] === 'string' ? node['name'] : null,
    industries: readStrings(node, paths.industry),
    regions: readStrings(node, paths.region),
    employeeCount: readEmployeeCount(node, paths.size),
  };
};

/* -------------------------------------------------------------------------- */
/* Clustering                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A group of raw values a human would call one thing.
 *
 * `values` is what gets written into the config, and it is every variant seen —
 * see the note at the top of this file. `label` is only ever shown.
 */
export interface IcpValueCluster {
  /** Display form: the most frequent raw spelling in the cluster. */
  readonly label: string;
  /** Every raw variant, deduped by the engine's own `normalise`. */
  readonly values: readonly string[];
  /** Companies carrying any variant in this cluster. */
  readonly count: number;
  /** `count` as a share of companies that have any value for this dimension. */
  readonly share: number;
  /** Up to three company names, so the human can sanity-check the cluster. */
  readonly examples: readonly string[];
}

export interface DimensionAnalysis {
  /** Companies with at least one usable value. */
  readonly known: number;
  /** Companies examined. */
  readonly total: number;
  /** `known / total`, 0 when nothing was examined. */
  readonly coverage: number;
  /** Distinct values before clustering — the free-text-sprawl number. */
  readonly distinctValues: number;
  /** Sorted by `count` descending, then label, so output is deterministic. */
  readonly clusters: readonly IcpValueCluster[];
}

/**
 * Generic words that turn one industry into two spellings.
 *
 * Stripped only when building the *merge* key, never from the stored values, and
 * only when something is left over: "Services" on its own stays "Services".
 * Deliberately short. Every entry here is a decision that two strings mean the
 * same thing, and being wrong about that silently merges two real markets — so
 * the list holds only words that are pure noise in an industry name.
 */
const GENERIC_SUFFIXES: readonly string[] = [
  'services',
  'service',
  'industry',
  'industries',
  'sector',
  'sectors',
  'solutions',
];

/**
 * The key two spellings must share to be treated as one industry.
 *
 * Four conservative steps on top of the engine's `normalise`: `&` becomes `and`,
 * punctuation becomes a word break, a single trailing generic word is dropped, a
 * trailing plural `s` is dropped from any word of five or more characters, and
 * what is left is joined with no separator at all. That last step is what merges
 * spellings that differ only in where the spaces and hyphens fell. Together they
 * merge "SaaS"/"saas", "E-Commerce"/"ecommerce", "Health Care"/"Healthcare",
 * "Food & Beverage"/"food and beverage", "Software Services"/"Software" and
 * "Logistics"/"Logistic".
 *
 * They deliberately do **not** merge "Finance" and "Financial Services", or
 * "Health" and "Healthcare": those look related to a reader and are different
 * words to a matcher, and a merge that is wrong writes a market the customer
 * does not sell to into their config. Both spellings are still offered as
 * separate rows, so a human who considers them one thing can tick both.
 */
export const clusterKey = (value: string): string => {
  const base = normalise(value)
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (base.length === 0) {
    return '';
  }

  const words = base.split(' ');
  const last = words[words.length - 1] ?? '';

  const withoutGeneric =
    words.length > 1 && GENERIC_SUFFIXES.includes(last)
      ? words.slice(0, -1)
      : words;

  return withoutGeneric
    .map((word) =>
      word.length >= 5 && word.endsWith('s') ? word.slice(0, -1) : word,
    )
    .join('');
};

interface ClusterAccumulator {
  key: string;
  /** Raw spelling -> how many companies used it. */
  spellings: Map<string, { display: string; count: number }>;
  companies: Set<string>;
  count: number;
  examples: string[];
}

const identityKey = (value: string): string => normalise(value);

/**
 * Cluster one dimension across a company sample.
 *
 * `merge` is false for regions: "US" and "USA" are not merged, because a region
 * list is matched literally against whatever a lead carries and quietly folding
 * country spellings together would put a target in the config the workspace
 * never named. Both spellings appear as their own clusters and the human picks.
 */
export const analyseDimension = (
  companies: readonly CompanyFacts[],
  pick: (facts: CompanyFacts) => readonly string[],
  { merge }: { merge: boolean },
): DimensionAnalysis => {
  const clusters = new Map<string, ClusterAccumulator>();
  const distinct = new Set<string>();
  let known = 0;

  for (const [index, company] of companies.entries()) {
    const values = pick(company);

    if (values.length === 0) {
      continue;
    }

    known += 1;

    const companyKey = company.id ?? `#${index}`;

    for (const value of values) {
      distinct.add(identityKey(value));

      const key = merge ? clusterKey(value) : identityKey(value);

      if (key.length === 0) {
        continue;
      }

      let cluster = clusters.get(key);

      if (cluster === undefined) {
        cluster = {
          key,
          spellings: new Map(),
          companies: new Set(),
          count: 0,
          examples: [],
        };
        clusters.set(key, cluster);
      }

      const spellingKey = identityKey(value);
      const spelling = cluster.spellings.get(spellingKey);

      if (spelling === undefined) {
        cluster.spellings.set(spellingKey, { display: value.trim(), count: 1 });
      } else {
        spelling.count += 1;
      }

      if (!cluster.companies.has(companyKey)) {
        cluster.companies.add(companyKey);
        cluster.count += 1;

        if (cluster.examples.length < 3 && company.name !== null) {
          cluster.examples.push(company.name);
        }
      }
    }
  }

  const built = [...clusters.values()].map((cluster): IcpValueCluster => {
    const spellings = [...cluster.spellings.values()].sort(
      (a, b) => b.count - a.count || a.display.localeCompare(b.display),
    );

    return {
      label: spellings[0]?.display ?? cluster.key,
      values: spellings.map((spelling) => spelling.display),
      count: cluster.count,
      share: known === 0 ? 0 : cluster.count / known,
      examples: cluster.examples,
    };
  });

  return {
    known,
    total: companies.length,
    coverage: companies.length === 0 ? 0 : known / companies.length,
    distinctValues: distinct.size,
    clusters: built.sort(
      (a, b) => b.count - a.count || a.label.localeCompare(b.label),
    ),
  };
};

/* -------------------------------------------------------------------------- */
/* Size distribution                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Conventional headcount boundaries, not boundaries derived from the data.
 *
 * A percentile-derived band ("your 10th to 90th percentile is 7 to 340
 * employees") is more faithful to the sample and much worse as a *profile*: it
 * encodes sampling noise as a hard cut-off, and it produces edges nobody can
 * defend in a sales meeting. These six buckets are the ones every sales
 * organisation already argues in, so the evidence attaches to a shape the human
 * already has an opinion about.
 */
export const SIZE_BUCKETS: readonly {
  label: string;
  minEmployees: number;
  maxEmployees: number | null;
}[] = [
  { label: '1–10 employees', minEmployees: 1, maxEmployees: 10 },
  { label: '11–50 employees', minEmployees: 11, maxEmployees: 50 },
  { label: '51–200 employees', minEmployees: 51, maxEmployees: 200 },
  { label: '201–1,000 employees', minEmployees: 201, maxEmployees: 1000 },
  { label: '1,001–5,000 employees', minEmployees: 1001, maxEmployees: 5000 },
  { label: 'Over 5,000 employees', minEmployees: 5001, maxEmployees: null },
];

export interface SizeBucketCount {
  readonly label: string;
  readonly minEmployees: number;
  readonly maxEmployees: number | null;
  readonly count: number;
  readonly share: number;
}

export interface SizeAnalysis {
  readonly known: number;
  readonly total: number;
  readonly coverage: number;
  readonly buckets: readonly SizeBucketCount[];
  readonly smallest: number | null;
  readonly largest: number | null;
  readonly median: number | null;
}

export const analyseSizes = (
  companies: readonly CompanyFacts[],
): SizeAnalysis => {
  const counts = companies
    .map((company) => company.employeeCount)
    .filter((count): count is number => count !== null)
    .sort((a, b) => a - b);

  const known = counts.length;

  const buckets = SIZE_BUCKETS.map((bucket): SizeBucketCount => {
    const count = counts.filter(
      (value) =>
        value >= bucket.minEmployees &&
        (bucket.maxEmployees === null || value <= bucket.maxEmployees),
    ).length;

    return { ...bucket, count, share: known === 0 ? 0 : count / known };
  });

  return {
    known,
    total: companies.length,
    coverage: companies.length === 0 ? 0 : known / companies.length,
    buckets,
    smallest: counts[0] ?? null,
    largest: counts[known - 1] ?? null,
    median: known === 0 ? null : (counts[Math.floor((known - 1) / 2)] ?? null),
  };
};

/* -------------------------------------------------------------------------- */
/* The whole picture                                                           */
/* -------------------------------------------------------------------------- */

export interface IcpAnalysis {
  /** Companies actually examined. */
  readonly sampled: number;
  /** Companies in the workspace, when countable. Null means the count failed. */
  readonly totalCompanies: number | null;
  readonly industry: DimensionAnalysis;
  readonly region: DimensionAnalysis;
  readonly size: SizeAnalysis;
  /** Field names the schema answered to, so the panel can say where this came from. */
  readonly paths: CompanyFieldPaths;
}

export const analyseCompanies = ({
  companies,
  totalCompanies,
  paths,
}: {
  readonly companies: readonly CompanyFacts[];
  readonly totalCompanies: number | null;
  readonly paths: CompanyFieldPaths;
}): IcpAnalysis => ({
  sampled: companies.length,
  totalCompanies,
  industry: analyseDimension(companies, (facts) => facts.industries, {
    merge: true,
  }),
  region: analyseDimension(companies, (facts) => facts.regions, {
    merge: false,
  }),
  size: analyseSizes(companies),
  paths,
});
