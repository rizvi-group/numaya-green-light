/**
 * Turning an analysis of the workspace's companies into a *proposal a human
 * accepts, edits or rejects* — never into configuration.
 *
 * Nothing in this file writes anything. `proposeIcp` returns suggestions with
 * the evidence attached, and `toIcpConfigPatch` turns whatever the human ended
 * up selecting into the exact record shape the ICP rules parse. The gap between
 * those two functions is where a person has to stand, and it is deliberate: an
 * ICP is a commercial decision about who the business sells to, and no amount of
 * arithmetic over a CRM export makes it ours to take.
 *
 * ## The thresholds, and why each one refuses rather than guesses
 *
 * Every constant below exists to make this module decline. A profile derived
 * from twelve companies, or from a field set on 3% of records, or from a tail of
 * two hundred industries with two companies each, is not a weak profile — it is
 * an arbitrary one, and applying it would gate real leads on noise. Declining is
 * a *result*: the panel says how much data there was and why it was not enough,
 * which is a fact the admin can act on (fill the field in, or configure the ICP
 * by hand from knowledge that is not in the CRM at all).
 */

import type { IcpSizeBand } from 'src/scoring';

import {
  analyseCompanies,
  type DimensionAnalysis,
  type IcpAnalysis,
  type IcpValueCluster,
  type SizeAnalysis,
  type SizeBucketCount,
} from 'src/icp/icp-analysis';
import {
  mergeBucketsIntoBands,
  toPlainBand,
} from 'src/icp/icp-size-bands';

/* -------------------------------------------------------------------------- */
/* Thresholds                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Below this many companies carrying a value, any pattern is an accident of who
 * happened to fill the field in. Ten is not a statistical claim; it is the point
 * below which a human reading the evidence would say "that is not enough" — and
 * they would be right, so the module says it for them.
 */
export const MIN_KNOWN_VALUES = 10;

/** One company is an anecdote. Two is the floor for calling something a pattern. */
export const MIN_CLUSTER_COMPANIES = 2;

/** Stop adding suggestions once this share of the known values is covered. */
export const COVERAGE_TARGET = 0.8;

/**
 * More than a dozen target industries is not a profile, it is the absence of
 * one — and an ICP that accepts everything scores exactly like the empty ICP
 * this whole feature exists to fix.
 */
export const MAX_SUGGESTIONS = 12;

/**
 * If the single largest cluster is smaller than this, the data has no shape.
 * This is the "long uniform tail" case: two hundred industries, two companies
 * each, no winner. Proposing the top twelve there would be proposing the
 * alphabetically lucky.
 */
export const MIN_TOP_SHARE = 0.05;

/** A bucket smaller than this is not worth widening a band for. */
export const MIN_BUCKET_SHARE = 0.05;

/* -------------------------------------------------------------------------- */
/* Shapes                                                                      */
/* -------------------------------------------------------------------------- */

export type IcpDimension = 'industry' | 'region' | 'size';

/**
 * How much the evidence is worth. Reported next to every suggestion, because a
 * suggestion drawn from 6% of the records and one drawn from 80% of them look
 * identical once they are a list of chips.
 */
export type IcpConfidence = 'none' | 'low' | 'moderate' | 'high';

export interface IcpValueDimensionProposal {
  readonly dimension: 'industry' | 'region';
  readonly proposed: boolean;
  readonly confidence: IcpConfidence;
  /** Plain words, always present — including, especially, when nothing is proposed. */
  readonly reason: string;
  readonly known: number;
  readonly sampled: number;
  readonly coverage: number;
  readonly distinctValues: number;
  /** Share of companies-with-a-value that the suggestions below would match. */
  readonly coveredShare: number;
  readonly suggestions: readonly IcpValueCluster[];
  /** Everything that did not make the cut, so a human can add it back. */
  readonly alternatives: readonly IcpValueCluster[];
}

export interface IcpSizeBandSuggestion extends IcpSizeBand {
  readonly count: number;
  readonly share: number;
}

export interface IcpSizeDimensionProposal {
  readonly dimension: 'size';
  readonly proposed: boolean;
  readonly confidence: IcpConfidence;
  readonly reason: string;
  readonly known: number;
  readonly sampled: number;
  readonly coverage: number;
  readonly coveredShare: number;
  readonly median: number | null;
  readonly smallest: number | null;
  readonly largest: number | null;
  readonly bands: readonly IcpSizeBandSuggestion[];
  /** Every bucket with its count, so the human can see what was left out. */
  readonly buckets: readonly SizeBucketCount[];
  /** Companies with a known headcount that no proposed band would accept. */
  readonly outsideCount: number;
  readonly outsideShare: number;
}

/** Exactly the three lists an ICP is, flattened and ready to be written. */
export interface IcpSelection {
  readonly industries: readonly string[];
  readonly regions: readonly string[];
  readonly sizeBands: readonly IcpSizeBand[];
}

export interface IcpProposal {
  readonly industry: IcpValueDimensionProposal;
  readonly region: IcpValueDimensionProposal;
  readonly size: IcpSizeDimensionProposal;
  /** What accepting the proposal unedited would write. */
  readonly selection: IcpSelection;
  readonly analysis: IcpAnalysis;
}

/* -------------------------------------------------------------------------- */
/* Confidence                                                                  */
/* -------------------------------------------------------------------------- */

const confidenceFor = (known: number, coverage: number): IcpConfidence => {
  if (known === 0) {
    return 'none';
  }

  if (known < MIN_KNOWN_VALUES) {
    return 'low';
  }

  if (coverage >= 0.6 && known >= 30) {
    return 'high';
  }

  if (coverage >= 0.25) {
    return 'moderate';
  }

  return 'low';
};

const percent = (share: number): string => `${Math.round(share * 100)}%`;

/* -------------------------------------------------------------------------- */
/* Industry and region                                                         */
/* -------------------------------------------------------------------------- */

const DIMENSION_NOUN: Record<'industry' | 'region', string> = {
  industry: 'industry',
  region: 'region',
};

/**
 * "an industry", "a region".
 *
 * The nouns are interpolated into sentences an admin reads on the ICP screen, and
 * "has a industry recorded" is the kind of wrongness that makes a user distrust
 * the numbers next to it. Keyed off the dimension rather than sniffing the first
 * letter because the set is closed and two entries are cheaper than a rule with
 * exceptions ("an hour", "a university").
 */
const DIMENSION_NOUN_WITH_ARTICLE: Record<'industry' | 'region', string> = {
  industry: 'an industry',
  region: 'a region',
};

const declineValueDimension = (
  dimension: 'industry' | 'region',
  analysis: DimensionAnalysis,
  reason: string,
): IcpValueDimensionProposal => ({
  dimension,
  proposed: false,
  confidence: confidenceFor(analysis.known, analysis.coverage),
  reason,
  known: analysis.known,
  sampled: analysis.total,
  coverage: analysis.coverage,
  distinctValues: analysis.distinctValues,
  coveredShare: 0,
  suggestions: [],
  alternatives: analysis.clusters,
});

export const proposeValueDimension = (
  dimension: 'industry' | 'region',
  analysis: DimensionAnalysis,
): IcpValueDimensionProposal => {
  const noun = DIMENSION_NOUN[dimension];
  const nounWithArticle = DIMENSION_NOUN_WITH_ARTICLE[dimension];

  if (analysis.total === 0) {
    return declineValueDimension(
      dimension,
      analysis,
      'There are no companies in this workspace to learn from, so Greenlight has nothing to propose. Set your target ' +
        `${noun}s by hand, or import your customers first.`,
    );
  }

  if (analysis.known === 0) {
    return declineValueDimension(
      dimension,
      analysis,
      `None of the ${analysis.total} companies examined has ${nounWithArticle} recorded, so there is nothing to derive a profile from.`,
    );
  }

  if (analysis.known < MIN_KNOWN_VALUES) {
    return declineValueDimension(
      dimension,
      analysis,
      `Only ${analysis.known} of ${analysis.total} companies has ${nounWithArticle} recorded. That is too few to tell a pattern from a coincidence, so nothing is proposed — the ${analysis.known} value${
        analysis.known === 1 ? '' : 's'
      } found are listed below if you want to start from them.`,
    );
  }

  const eligible = analysis.clusters.filter(
    (cluster) => cluster.count >= MIN_CLUSTER_COMPANIES,
  );

  const top = eligible[0];

  if (top === undefined || top.share < MIN_TOP_SHARE) {
    return declineValueDimension(
      dimension,
      analysis,
      `Your companies are spread across ${analysis.distinctValues} ${noun} values with no clear cluster — the largest holds ${
        top === undefined ? 'a single company' : percent(top.share)
      } of the ${analysis.known} that have one. A profile built from that would be arbitrary, so nothing is proposed.`,
    );
  }

  const suggestions: IcpValueCluster[] = [];
  let covered = 0;

  for (const cluster of eligible) {
    if (
      suggestions.length >= MAX_SUGGESTIONS ||
      covered >= COVERAGE_TARGET * analysis.known
    ) {
      break;
    }

    suggestions.push(cluster);
    covered += cluster.count;
  }

  const suggested = new Set(suggestions.map((cluster) => cluster.label));
  const coveredShare = analysis.known === 0 ? 0 : covered / analysis.known;

  return {
    dimension,
    proposed: true,
    confidence: confidenceFor(analysis.known, analysis.coverage),
    reason: `${suggestions.length} ${noun}${
      suggestions.length === 1 ? '' : 's'
    } cover ${percent(coveredShare)} of the ${analysis.known} companies that have one recorded (${percent(
      analysis.coverage,
    )} of the ${analysis.total} examined). Everything else found is listed below.`,
    known: analysis.known,
    sampled: analysis.total,
    coverage: analysis.coverage,
    distinctValues: analysis.distinctValues,
    coveredShare,
    suggestions,
    alternatives: analysis.clusters.filter(
      (cluster) => !suggested.has(cluster.label),
    ),
  };
};

/* -------------------------------------------------------------------------- */
/* Size                                                                        */
/* -------------------------------------------------------------------------- */

export const proposeSizeDimension = (
  analysis: SizeAnalysis,
): IcpSizeDimensionProposal => {
  const base = {
    dimension: 'size' as const,
    known: analysis.known,
    sampled: analysis.total,
    coverage: analysis.coverage,
    median: analysis.median,
    smallest: analysis.smallest,
    largest: analysis.largest,
    buckets: analysis.buckets,
    confidence: confidenceFor(analysis.known, analysis.coverage),
  };

  const decline = (reason: string): IcpSizeDimensionProposal => ({
    ...base,
    proposed: false,
    reason,
    coveredShare: 0,
    bands: [],
    outsideCount: analysis.known,
    outsideShare: analysis.known === 0 ? 0 : 1,
  });

  if (analysis.total === 0) {
    return decline(
      'There are no companies in this workspace to learn from, so Greenlight has nothing to propose.',
    );
  }

  if (analysis.known === 0) {
    return decline(
      `None of the ${analysis.total} companies examined has an employee count recorded, so there is nothing to derive size bands from.`,
    );
  }

  if (analysis.known < MIN_KNOWN_VALUES) {
    return decline(
      `Only ${analysis.known} of ${analysis.total} companies has an employee count recorded — too few to draw a band around.`,
    );
  }

  const ranked = [...analysis.buckets]
    .filter((bucket) => bucket.share >= MIN_BUCKET_SHARE)
    .sort((a, b) => b.count - a.count);

  const chosen: SizeBucketCount[] = [];
  let covered = 0;

  for (const bucket of ranked) {
    if (covered >= COVERAGE_TARGET) {
      break;
    }

    chosen.push(bucket);
    covered += bucket.share;
  }

  if (chosen.length === 0) {
    return decline(
      `The ${analysis.known} companies with a headcount are spread thinly across every size, with no band holding more than ${percent(
        Math.max(...analysis.buckets.map((bucket) => bucket.share)),
      )} of them. Nothing is proposed.`,
    );
  }

  const bands = mergeBucketsIntoBands(
    chosen.map((bucket) => bucket.label),
    analysis.buckets,
  );
  const coveredShare = bands.reduce((sum, band) => sum + band.share, 0);
  const outsideShare = Math.max(0, 1 - coveredShare);

  return {
    ...base,
    proposed: true,
    reason: `${bands.length === 1 ? 'This band covers' : `These ${bands.length} bands cover`} ${percent(
      coveredShare,
    )} of the ${analysis.known} companies with a headcount recorded (${percent(
      analysis.coverage,
    )} of the ${analysis.total} examined). The median is ${
      analysis.median === null
        ? 'unknown'
        : `${analysis.median.toLocaleString('en-US')} employees`
    }.`,
    coveredShare,
    bands,
    outsideCount: Math.round(outsideShare * analysis.known),
    outsideShare,
  };
};

/* -------------------------------------------------------------------------- */
/* The proposal                                                                */
/* -------------------------------------------------------------------------- */

export const selectionFrom = ({
  industry,
  region,
  size,
}: {
  readonly industry: IcpValueDimensionProposal;
  readonly region: IcpValueDimensionProposal;
  readonly size: IcpSizeDimensionProposal;
}): IcpSelection => ({
  // Every raw spelling, not the cluster label — see the note at the top of
  // `icp-analysis.ts`. The label is a display string; these are what the rule
  // compares against.
  industries: industry.suggestions.flatMap((cluster) => [...cluster.values]),
  regions: region.suggestions.flatMap((cluster) => [...cluster.values]),
  // `toPlainBand`, and the panel uses the same helper on the same buckets, so
  // the two selections serialise identically — which is what lets the panel tell
  // a freshly-measured impact from a stale one.
  sizeBands: size.bands.map(toPlainBand),
});

export const proposeIcp = (analysis: IcpAnalysis): IcpProposal => {
  const industry = proposeValueDimension('industry', analysis.industry);
  const region = proposeValueDimension('region', analysis.region);
  const size = proposeSizeDimension(analysis.size);

  return {
    industry,
    region,
    size,
    selection: selectionFrom({ industry, region, size }),
    analysis,
  };
};

/** Convenience for tests and for the one caller that has raw companies. */
export const proposeIcpFromCompanies = (
  input: Parameters<typeof analyseCompanies>[0],
): IcpProposal => proposeIcp(analyseCompanies(input));

/* -------------------------------------------------------------------------- */
/* What actually gets written                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The `GreenlightConfig` patch for a selection.
 *
 * The shapes here are not a choice — they are dictated by what the other side
 * parses, and both sides were read rather than assumed:
 *
 *   - `icpIndustries` / `icpRegions` are `FieldType.ARRAY` on the record and
 *     reach the engine through `asStringList`, then `resolveIcp`, then
 *     `matchesList`, which compares `normalise(value) === normalise(target)`.
 *     Flat arrays of the raw strings, therefore.
 *   - `icpSizeBands` is `FieldType.RAW_JSON` and is seeded as `{ bands: [...] }`.
 *     `readSizeBands` accepts either that or a bare array; the wrapped form is
 *     what the install hook writes, so it is what this writes too.
 *   - Each band needs `minEmployees` (finite, >= 0) and `maxEmployees` (finite
 *     or `null` for unbounded). `resolveIcp` silently drops any band missing
 *     those, so a band that looks right and scores nothing is exactly the
 *     failure this shape is copied to avoid.
 *
 * The field's own description mentions a `fit` weight. `resolveIcp` does not
 * read one and `icp.company-size` does not use one, so writing it would be
 * writing a lie into the record. Flagged in the report.
 */
export const toIcpConfigPatch = (
  selection: IcpSelection,
): Record<string, unknown> => ({
  icpIndustries: [...selection.industries],
  icpRegions: [...selection.regions],
  icpSizeBands: {
    bands: selection.sizeBands.map(
      ({ label, minEmployees, maxEmployees }) => ({
        label,
        minEmployees,
        maxEmployees,
      }),
    ),
  },
});

/**
 * The same selection expressed as the `icp` block of a raw scoring-config input,
 * so a preview can score a lead against a profile that has not been saved.
 * `resolveIcp` reads `industries`, `regions` and a bare `sizeBands` array.
 */
export const applyIcpToConfigInput = (
  base: unknown,
  selection: IcpSelection,
): Record<string, unknown> => ({
  ...(typeof base === 'object' && base !== null && !Array.isArray(base)
    ? (base as Record<string, unknown>)
    : {}),
  icp: {
    industries: [...selection.industries],
    regions: [...selection.regions],
    sizeBands: selection.sizeBands.map(
      ({ label, minEmployees, maxEmployees }) => ({
        label,
        minEmployees,
        maxEmployees,
      }),
    ),
  },
});
