/**
 * What applying a profile would actually do — measured, before anything is
 * written.
 *
 * ## Why this is not optional
 *
 * Writing an ICP changes every future score in the workspace. Three rules that
 * were reporting `not_applicable` and scoring 0/0 start reporting pass or fail
 * and scoring 0/40, and a lead that has no industry recorded fails a `major`
 * rule it was previously exempt from. Applied to a live pipeline that is not a
 * settings change, it is a re-gating of every rep's working list, and the
 * difference between "this sharpens the queue" and "this holds nine hundred
 * leads a team was working from" is not knowable by reading the profile. It is
 * only knowable by scoring against it.
 *
 * So this module scores the sample twice — once with the workspace's current
 * configuration and once with the proposed profile patched into it — and reports
 * the transitions. The engine is pure and never throws, so this can be done
 * exactly, in-process, with no writes and no side effects.
 *
 * ## The second number, which matters more than the first
 *
 * `readability` counts, per dimension, how many sampled leads Greenlight can
 * even *read* the value from. It is separate from "how many match" for a reason
 * that the first live measurement made unavoidable: a profile can be perfectly
 * correct about the customer's market and still fail every lead, because the
 * scoring path never sees the field it needs. When that is the situation, an
 * impact preview that only reported "would gate 1,190 leads" would be true and
 * useless — the admin would conclude their ICP is wrong. It is not; the plumbing
 * is missing. The two numbers together say which.
 */

import {
  scoreLead,
  toLeadRecord,
  type GateDecision,
  type LeadFieldKey,
  type ScoringResult,
} from 'src/scoring';
import { toScoringConfigInput } from 'src/logic-functions/greenlight-config-record';

import {
  applyIcpToConfigInput,
  type IcpSelection,
} from 'src/icp/icp-proposal';
import { ICP_RULE_DIMENSIONS, type IcpRuleId } from 'src/icp/icp-status';

/** Which logical field each ICP rule needs to be able to read. */
export const ICP_RULE_FIELD_KEYS = {
  'icp.industry': 'industry',
  'icp.region': 'region',
  'icp.company-size': 'employeeCount',
} as const satisfies Record<IcpRuleId, LeadFieldKey>;

export interface IcpReadability {
  readonly ruleId: IcpRuleId;
  readonly fieldKey: LeadFieldKey;
  /** The rule was in play at all — i.e. the proposal configures this dimension. */
  readonly active: boolean;
  /** Leads where some mapped field resolved to a value. */
  readonly readable: number;
  /** Leads the rule would pass. */
  readonly matched: number;
  /** Leads that carry a value which is not in the profile. */
  readonly mismatched: number;
  /** Leads where nothing could be read, so the rule fails for want of data. */
  readonly unreadable: number;
  /** Field paths the engine tried, in order — what to point at or fill in. */
  readonly candidates: readonly string[];
  /** The path that answered, on the leads where one did. */
  readonly resolvedPaths: readonly string[];
}

export interface IcpImpactExample {
  readonly leadId: string | null;
  readonly display: string;
  readonly scoreBefore: number | null;
  readonly scoreAfter: number | null;
  readonly reason: string;
}

export interface IcpImpact {
  readonly sampled: number;
  /** Leads in the workspace, when countable. Drives the extrapolation only. */
  readonly totalLeads: number | null;
  readonly approvedBefore: number;
  readonly approvedAfter: number;
  readonly gatedBefore: number;
  readonly gatedAfter: number;
  readonly blocked: number;
  /** Cleared today, held after. The number that decides whether this is safe. */
  readonly newlyGated: number;
  /** Held today, cleared after — possible, because a matching lead earns points. */
  readonly newlyApproved: number;
  readonly unchanged: number;
  readonly averageScoreBefore: number | null;
  readonly averageScoreAfter: number | null;
  /** `newlyGated` scaled to the whole workspace. Clearly an estimate; label it. */
  readonly estimatedNewlyGated: number | null;
  readonly readability: readonly IcpReadability[];
  readonly examples: readonly IcpImpactExample[];
  /** True when the profile is empty, i.e. there is nothing to preview. */
  readonly empty: boolean;
}

const EXAMPLE_LIMIT = 5;

const displayName = (node: unknown): string => {
  if (typeof node !== 'object' || node === null) {
    return 'Unnamed lead';
  }

  const record = node as Record<string, unknown>;
  const name = record['name'];

  if (typeof name === 'object' && name !== null) {
    const parts = name as Record<string, unknown>;
    const joined = [parts['firstName'], parts['lastName']]
      .filter((part): part is string => typeof part === 'string')
      .join(' ')
      .trim();

    if (joined.length > 0) {
      return joined;
    }
  }

  if (typeof name === 'string' && name.trim().length > 0) {
    return name.trim();
  }

  const emails = record['emails'];

  if (typeof emails === 'object' && emails !== null) {
    const primary = (emails as Record<string, unknown>)['primaryEmail'];

    if (typeof primary === 'string' && primary.trim().length > 0) {
      return primary.trim();
    }
  }

  return 'Unnamed lead';
};

const isEmptySelection = (selection: IcpSelection): boolean =>
  selection.industries.length === 0 &&
  selection.regions.length === 0 &&
  selection.sizeBands.length === 0;

const dimensionIsActive = (
  ruleId: IcpRuleId,
  selection: IcpSelection,
): boolean => {
  const key = ICP_RULE_DIMENSIONS[ruleId];

  return key === 'industries'
    ? selection.industries.length > 0
    : key === 'regions'
      ? selection.regions.length > 0
      : selection.sizeBands.length > 0;
};

const average = (values: readonly number[]): number | null =>
  values.length === 0
    ? null
    : Math.round(
        (values.reduce((sum, value) => sum + value, 0) / values.length) * 10,
      ) / 10;

interface ReadabilityAccumulator {
  readable: number;
  matched: number;
  mismatched: number;
  unreadable: number;
  candidates: string[];
  resolvedPaths: Set<string>;
}

const observeReadability = (
  result: ScoringResult,
  ruleId: IcpRuleId,
  accumulator: ReadabilityAccumulator,
): void => {
  const entry = result.trace.find((traceEntry) => traceEntry.ruleId === ruleId);

  if (entry === undefined || entry.outcome === 'not_applicable') {
    return;
  }

  const fieldKey = ICP_RULE_FIELD_KEYS[ruleId];
  const observation = entry.observations.find(
    (candidate) => candidate.key === fieldKey,
  );

  if (observation !== undefined && accumulator.candidates.length === 0) {
    accumulator.candidates = [...observation.candidates];
  }

  const present = observation?.present ?? false;

  if (present) {
    accumulator.readable += 1;

    if (observation?.mappedTo !== null && observation?.mappedTo !== undefined) {
      accumulator.resolvedPaths.add(observation.mappedTo);
    }
  } else {
    accumulator.unreadable += 1;
  }

  if (entry.outcome === 'pass' || entry.outcome === 'partial') {
    accumulator.matched += 1;
  } else if (entry.outcome === 'fail' && present) {
    accumulator.mismatched += 1;
  }
};

export interface IcpImpactInput {
  /** Raw Person nodes, fetched with the same selection the scoring path uses. */
  readonly leads: readonly unknown[];
  /** The `GreenlightConfig` record as read, unmodified. */
  readonly configRecord: unknown;
  readonly selection: IcpSelection;
  /** Injected, like everywhere else in this codebase. */
  readonly now: Date;
  readonly totalLeads: number | null;
}

/**
 * Score the sample twice and report the difference. Never throws — `scoreLead`
 * does not, and nothing else here can.
 */
export const previewIcpImpact = ({
  leads,
  configRecord,
  selection,
  now,
  totalLeads,
}: IcpImpactInput): IcpImpact => {
  const baseConfig = toScoringConfigInput(configRecord);
  const proposedConfig = applyIcpToConfigInput(baseConfig, selection);

  const readability = new Map<IcpRuleId, ReadabilityAccumulator>();

  for (const ruleId of Object.keys(ICP_RULE_DIMENSIONS) as IcpRuleId[]) {
    readability.set(ruleId, {
      readable: 0,
      matched: 0,
      mismatched: 0,
      unreadable: 0,
      candidates: [],
      resolvedPaths: new Set<string>(),
    });
  }

  const tally: Record<GateDecision, number> = {
    approved: 0,
    gated: 0,
    blocked: 0,
    unscored: 0,
  };
  const tallyAfter: Record<GateDecision, number> = {
    approved: 0,
    gated: 0,
    blocked: 0,
    unscored: 0,
  };

  const scoresBefore: number[] = [];
  const scoresAfter: number[] = [];
  const examples: IcpImpactExample[] = [];

  let newlyGated = 0;
  let newlyApproved = 0;
  let unchanged = 0;

  for (const node of leads) {
    const lead = toLeadRecord(node);

    const before = scoreLead({ lead, now, config: baseConfig });
    const after = scoreLead({ lead, now, config: proposedConfig });

    tally[before.decision] += 1;
    tallyAfter[after.decision] += 1;

    if (before.score !== null) {
      scoresBefore.push(before.score);
    }

    if (after.score !== null) {
      scoresAfter.push(after.score);
    }

    for (const ruleId of readability.keys()) {
      const accumulator = readability.get(ruleId);

      if (accumulator !== undefined) {
        observeReadability(after, ruleId, accumulator);
      }
    }

    if (before.decision === after.decision) {
      unchanged += 1;
      continue;
    }

    if (before.decision === 'approved' && after.decision === 'gated') {
      newlyGated += 1;

      if (examples.length < EXAMPLE_LIMIT) {
        examples.push({
          leadId: lead.id ?? null,
          display: displayName(node),
          scoreBefore: before.score,
          scoreAfter: after.score,
          reason: after.reasons[0] ?? after.summary,
        });
      }

      continue;
    }

    if (before.decision === 'gated' && after.decision === 'approved') {
      newlyApproved += 1;
    }
  }

  return {
    sampled: leads.length,
    totalLeads,
    approvedBefore: tally.approved,
    approvedAfter: tallyAfter.approved,
    gatedBefore: tally.gated,
    gatedAfter: tallyAfter.gated,
    blocked: tally.blocked,
    newlyGated,
    newlyApproved,
    unchanged,
    averageScoreBefore: average(scoresBefore),
    averageScoreAfter: average(scoresAfter),
    estimatedNewlyGated:
      totalLeads === null || leads.length === 0
        ? null
        : Math.round((newlyGated / leads.length) * totalLeads),
    readability: (Object.keys(ICP_RULE_DIMENSIONS) as IcpRuleId[]).map(
      (ruleId): IcpReadability => {
        const accumulator = readability.get(ruleId);

        return {
          ruleId,
          fieldKey: ICP_RULE_FIELD_KEYS[ruleId],
          active: dimensionIsActive(ruleId, selection),
          readable: accumulator?.readable ?? 0,
          matched: accumulator?.matched ?? 0,
          mismatched: accumulator?.mismatched ?? 0,
          unreadable: accumulator?.unreadable ?? 0,
          candidates: accumulator?.candidates ?? [],
          resolvedPaths: [...(accumulator?.resolvedPaths ?? [])],
        };
      },
    ),
    examples,
    empty: isEmptySelection(selection),
  };
};
