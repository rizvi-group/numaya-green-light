/**
 * "How much of the scoring model is switched off?" — answered in points, from
 * the workspace's own configuration, with no hard-coded numbers.
 *
 * ## Why this is arithmetic and not a boolean
 *
 * The engine's handling of an empty ICP is correct and should not change: an
 * empty list means "no opinion", the rule reports `not_applicable`, and the
 * weighting drops it from *both* sides of the fraction so a workspace with no
 * industry opinion is not punished for it. Nothing is broken.
 *
 * What is missing is that the consequence is invisible. `not_applicable` on
 * three rules means industry, region and company size contribute nothing, so
 * every score in the workspace is built out of "do we hold contact details"
 * rather than "is this a fit" — and the score still looks like a score. A
 * boolean ("ICP not configured") does not convey that. A number does: 40 of the
 * 130 points this engine can award are idle, which is 31% of the model, and it
 * is the 31% that decides whether a lead is worth calling.
 *
 * The numbers are read out of the resolved configuration rather than restated
 * here, so a workspace that reweighted its rules gets its own arithmetic and not
 * ours. Pure: no client, no clock.
 */

import { ALL_RULES, resolveConfig, type ResolvedScoringConfig } from 'src/scoring';
import { toScoringConfigInput } from 'src/logic-functions/greenlight-config-record';

import {
  ICP_REVIEW_DECISION_VALUES,
  type GREENLIGHT_CONFIG_ICP_REVIEW_FIELD_UNIVERSAL_IDENTIFIERS,
} from 'src/constants/icp-identifiers';

/* -------------------------------------------------------------------------- */
/* Which rule reads which list                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The contract between a rule id and the config list that switches it on.
 *
 * Hard-coded, and guarded by a test that fails if the rule catalogue ever grows
 * an `icp` rule that is not in this map. Deriving it would mean the rules
 * declaring their own configuration dependency, which is a change to
 * `src/scoring/` this workstream does not own — and a missing entry here would
 * otherwise report an unconfigured dimension as configured, which is the one
 * error this whole surface exists to prevent.
 */
export const ICP_RULE_DIMENSIONS = {
  'icp.industry': 'industries',
  'icp.region': 'regions',
  'icp.company-size': 'sizeBands',
} as const satisfies Record<string, keyof ResolvedScoringConfig['icp']>;

export type IcpRuleId = keyof typeof ICP_RULE_DIMENSIONS;

/* -------------------------------------------------------------------------- */
/* Review state                                                                */
/* -------------------------------------------------------------------------- */

export type IcpReviewDecision =
  (typeof ICP_REVIEW_DECISION_VALUES)[keyof typeof ICP_REVIEW_DECISION_VALUES];

export interface IcpReviewState {
  readonly decision: IcpReviewDecision;
  readonly reviewedAt: string | null;
}

type IcpReviewFieldName =
  keyof typeof GREENLIGHT_CONFIG_ICP_REVIEW_FIELD_UNIVERSAL_IDENTIFIERS;

export const ICP_REVIEW_FIELD_NAMES: readonly IcpReviewFieldName[] = [
  'icpReviewedAt',
  'icpReviewDecision',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const KNOWN_DECISIONS: readonly string[] = Object.values(
  ICP_REVIEW_DECISION_VALUES,
);

/**
 * An empty ICP means one of two completely different things — "nobody has ever
 * looked at this" or "we sell to everyone and left it open on purpose" — and the
 * record could not tell them apart before these fields existed. A record from
 * before the upgrade has neither field set, which reads as never reviewed. That
 * is the correct answer for it: nobody had been asked.
 */
export const readReviewState = (record: unknown): IcpReviewState => {
  if (!isRecord(record)) {
    return {
      decision: ICP_REVIEW_DECISION_VALUES.notReviewed,
      reviewedAt: null,
    };
  }

  const raw = record['icpReviewDecision'];
  const decision =
    typeof raw === 'string' && KNOWN_DECISIONS.includes(raw.trim().toUpperCase())
      ? (raw.trim().toUpperCase() as IcpReviewDecision)
      : ICP_REVIEW_DECISION_VALUES.notReviewed;

  const reviewedAtRaw = record['icpReviewedAt'];
  const reviewedAt =
    typeof reviewedAtRaw === 'string' && reviewedAtRaw.trim().length > 0
      ? reviewedAtRaw
      : null;

  return { decision, reviewedAt };
};

/* -------------------------------------------------------------------------- */
/* Status                                                                      */
/* -------------------------------------------------------------------------- */

export interface IcpDimensionStatus {
  readonly ruleId: IcpRuleId;
  readonly name: string;
  readonly question: string;
  /** Does this dimension carry at least one entry? */
  readonly configured: boolean;
  readonly entryCount: number;
  readonly enabled: boolean;
  /** Points this rule would be worth if it were configured and enabled. */
  readonly weight: number;
  /** Enabled, not advisory, and unconfigured: points that exist and do nothing. */
  readonly idle: boolean;
}

export interface IcpStatus {
  /** At least one of the three dimensions carries an entry. */
  readonly configured: boolean;
  readonly fullyConfigured: boolean;
  /** Weight belonging to enabled ICP rules with nothing to judge. */
  readonly idlePoints: number;
  /** Weight belonging to every other rule that can score. */
  readonly activePoints: number;
  readonly totalPoints: number;
  /** `idlePoints / totalPoints`, 0 when the workspace has no scorable rules. */
  readonly idleShare: number;
  readonly dimensions: readonly IcpDimensionStatus[];
  readonly review: IcpReviewState;
  /** One sentence for the top of the panel. Never hedged, never a warning icon alone. */
  readonly headline: string;
}

const roundTo = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

export const readIcpStatus = (configRecord: unknown): IcpStatus => {
  const { config } = resolveConfig(toScoringConfigInput(configRecord));

  const dimensions: IcpDimensionStatus[] = [];
  let idlePoints = 0;
  let activePoints = 0;

  for (const rule of ALL_RULES) {
    const setting = config.rules[rule.id];
    const enabled = setting?.enabled ?? rule.defaultEnabled;
    const severity = setting?.severity ?? rule.defaultSeverity;
    const weight = setting?.weight ?? rule.defaultWeight;

    // Advisory rules are reported and never scored, so they are not points at
    // all — the engine excludes them from the denominator and so does this.
    const scorable = enabled && severity !== 'advisory';

    const dimensionKey =
      rule.id in ICP_RULE_DIMENSIONS
        ? ICP_RULE_DIMENSIONS[rule.id as IcpRuleId]
        : null;

    if (dimensionKey === null) {
      if (scorable) {
        activePoints += weight;
      }

      continue;
    }

    const entryCount = config.icp[dimensionKey].length;
    const configured = entryCount > 0;
    const idle = scorable && !configured;

    if (scorable) {
      if (configured) {
        activePoints += weight;
      } else {
        idlePoints += weight;
      }
    }

    dimensions.push({
      ruleId: rule.id as IcpRuleId,
      name: rule.name,
      question: rule.question,
      configured,
      entryCount,
      enabled,
      weight,
      idle,
    });
  }

  const totalPoints = idlePoints + activePoints;
  const idleShare = totalPoints === 0 ? 0 : idlePoints / totalPoints;
  const configured = dimensions.some((dimension) => dimension.configured);

  return {
    configured,
    fullyConfigured: dimensions.every((dimension) => dimension.configured),
    idlePoints,
    activePoints,
    totalPoints,
    idleShare: roundTo(idleShare, 4),
    dimensions,
    review: readReviewState(configRecord),
    headline: buildHeadline({
      dimensions,
      idlePoints,
      totalPoints,
      idleShare,
    }),
  };
};

const listNames = (names: readonly string[]): string => {
  if (names.length <= 1) {
    return names[0] ?? '';
  }

  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};

const buildHeadline = ({
  dimensions,
  idlePoints,
  totalPoints,
  idleShare,
}: {
  readonly dimensions: readonly IcpDimensionStatus[];
  readonly idlePoints: number;
  readonly totalPoints: number;
  readonly idleShare: number;
}): string => {
  const idleNames = dimensions
    .filter((dimension) => dimension.idle)
    .map((dimension) => dimension.name.toLowerCase());

  if (idleNames.length === 0) {
    return 'Every part of your ideal-customer profile is configured and scoring.';
  }

  return (
    `${listNames(idleNames)} ${idleNames.length === 1 ? 'is' : 'are'} not configured, so ` +
    `${idleNames.length === 1 ? 'it scores' : 'they score'} nothing. That is ${idlePoints} of the ` +
    `${totalPoints} points Greenlight can award — ${Math.round(idleShare * 100)}% of the model, and ` +
    'the part that decides whether a lead is a fit. Every score in this workspace is currently built ' +
    'from whether you hold contact details.'
  );
};
