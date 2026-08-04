/**
 * The scoring engine.
 *
 * Pure: no SDK import, no network, no I/O, no clock read. `now` arrives as a
 * parameter so every run is reproducible from its inputs alone.
 *
 * Fail-open is a hard product rule, and it is implemented at four levels:
 *   1. missing or unusable config     → seeded defaults / neutral weights
 *   2. a rule that throws             → recorded as `errored`, excluded from
 *                                       the score, never fatal
 *   3. nothing scorable at all        → decision `unscored`, lead passes
 *                                       through flagged rather than lost
 *   4. anything else that throws      → caught at the boundary, same as (3)
 *
 * A lead is never lost and never silently dropped.
 */

import { createFieldReader, isPlainObject } from 'src/scoring/field-access';
import { resolveConfig } from 'src/scoring/config';
import { ALL_RULES } from 'src/scoring/rules';
import { clamp01, roundTo } from 'src/scoring/rules/helpers';
import {
  SCORING_ENGINE_VERSION,
  type Degradation,
  type GateDecision,
  type LeadRecord,
  type ResolvedScoringConfig,
  type RuleSetting,
  type RuleTraceEntry,
  type RuleVerdict,
  type ScoreLeadInput,
  type ScoringBand,
  type ScoringResult,
  type ScoringRule,
} from 'src/scoring/types';

const MAX_REASONS = 5;

const isUsableDate = (value: unknown): value is Date =>
  value instanceof Date && !Number.isNaN(value.getTime());

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === 'string' ? error : 'unknown error';
};

const creditFor = (verdict: RuleVerdict): number => {
  switch (verdict.outcome) {
    case 'pass':
      return verdict.credit === undefined ? 1 : clamp01(verdict.credit);
    case 'partial':
      return verdict.credit === undefined ? 0.5 : clamp01(verdict.credit);
    case 'fail':
      return verdict.credit === undefined ? 0 : clamp01(verdict.credit);
    case 'not_applicable':
    default:
      return 0;
  }
};

const settingFor = (
  config: ResolvedScoringConfig,
  rule: ScoringRule,
): RuleSetting =>
  config.rules[rule.id] ?? {
    enabled: rule.defaultEnabled,
    severity: rule.defaultSeverity,
    weight: rule.defaultWeight,
  };

const bandFor = (
  score: number | null,
  bands: readonly ScoringBand[],
): ScoringBand | null => {
  if (score === null) {
    return null;
  }

  return (
    [...bands]
      .sort((a, b) => b.minScore - a.minScore)
      .find((band) => score >= band.minScore) ?? null
  );
};

const SEVERITY_RANK: Record<string, number> = {
  blocking: 0,
  critical: 1,
  major: 2,
  minor: 3,
  advisory: 4,
};

const collectReasons = (trace: readonly RuleTraceEntry[]): string[] =>
  trace
    .filter(
      (entry) =>
        entry.contributed &&
        (entry.outcome === 'fail' || entry.outcome === 'partial'),
    )
    .sort((a, b) => {
      const bySeverity =
        (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);

      if (bySeverity !== 0) {
        return bySeverity;
      }

      return b.pointsPossible - b.pointsEarned - (a.pointsPossible - a.pointsEarned);
    })
    .slice(0, MAX_REASONS)
    .map((entry) => entry.explanation);

const summarise = (
  decision: GateDecision,
  score: number | null,
  band: ScoringBand | null,
  gateThreshold: number,
  blockingReason: string | null,
): string => {
  switch (decision) {
    case 'blocked':
      return blockingReason ?? 'This lead is blocked from outreach on compliance grounds.';
    case 'unscored':
      return 'Greenlight could not score this lead, so it has been let through and flagged for a human to look at.';
    case 'approved':
      return `Cleared to work — scored ${score ?? 0}/100${
        band === null ? '' : ` (${band.label})`
      }, at or above your ${gateThreshold} threshold.`;
    case 'gated':
    default:
      return `Held for review — scored ${score ?? 0}/100${
        band === null ? '' : ` (${band.label})`
      }, below your ${gateThreshold} threshold. Anyone can release it.`;
  }
};

const normaliseLead = (
  lead: unknown,
  degradations: Degradation[],
): LeadRecord => {
  if (!isPlainObject(lead)) {
    degradations.push({
      code: 'lead_malformed',
      message:
        'The lead record could not be read, so it was scored as if every field were empty. It has been let through and flagged.',
    });

    return { id: null, fields: {} };
  }

  const id = typeof lead['id'] === 'string' ? lead['id'] : null;
  const fields = lead['fields'];

  if (!isPlainObject(fields)) {
    degradations.push({
      code: 'lead_malformed',
      message:
        'The lead record had no readable fields, so it was scored as if every field were empty. It has been let through and flagged.',
    });

    return { id, fields: {} };
  }

  return { id, fields };
};

const evaluateRule = (
  rule: ScoringRule,
  config: ResolvedScoringConfig,
  lead: LeadRecord,
  now: Date | null,
  degradations: Degradation[],
): RuleTraceEntry => {
  const setting = settingFor(config, rule);
  const reader = createFieldReader(lead, config.fieldMapping);

  const base = {
    ruleId: rule.id,
    ruleName: rule.name,
    category: rule.category,
    question: rule.question,
    severity: setting.severity,
    weight: setting.weight,
  } as const;

  if (!setting.enabled) {
    return {
      ...base,
      outcome: 'skipped',
      credit: 0,
      pointsEarned: 0,
      pointsPossible: 0,
      contributed: false,
      explanation: `"${rule.name}" is switched off in your Greenlight settings, so it did not affect this score.`,
      observations: [],
    };
  }

  let verdict: RuleVerdict;

  try {
    verdict = rule.evaluate({ lead, config, now, read: reader });
  } catch (error) {
    // Fail-open level 2: a broken rule is reported, never fatal, and never
    // drags the lead's score down.
    const message = errorMessage(error);

    degradations.push({
      code: 'rule_errored',
      message: `The "${rule.name}" check could not run, so it was left out of this score.`,
      detail: `${rule.id}: ${message}`,
    });

    return {
      ...base,
      outcome: 'errored',
      credit: 0,
      pointsEarned: 0,
      pointsPossible: 0,
      contributed: false,
      explanation: `The "${rule.name}" check could not run and was left out of this score, so the lead was not penalised for it.`,
      remedy: 'Report this to your Greenlight administrator — it is a fault in the app, not in the lead.',
      observations: reader.observations(),
      error: message,
    };
  }

  const isScorable =
    verdict.outcome === 'pass' ||
    verdict.outcome === 'partial' ||
    verdict.outcome === 'fail';

  const contributed = isScorable && setting.severity !== 'advisory';
  const credit = creditFor(verdict);
  const pointsPossible = contributed ? setting.weight : 0;
  const pointsEarned = contributed ? roundTo(setting.weight * credit, 4) : 0;

  const entry: RuleTraceEntry = {
    ...base,
    outcome: verdict.outcome,
    credit,
    pointsEarned,
    pointsPossible,
    contributed,
    explanation: verdict.explanation,
    observations: reader.observations(),
  };

  return {
    ...entry,
    ...(verdict.remedy === undefined ? {} : { remedy: verdict.remedy }),
    ...(verdict.detail === undefined ? {} : { detail: verdict.detail }),
  };
};

const runScoring = (input: ScoreLeadInput): ScoringResult => {
  const degradations: Degradation[] = [];
  const rules = input.rules ?? ALL_RULES;

  const lead = normaliseLead(input.lead, degradations);

  let now: Date | null = null;

  if (isUsableDate(input.now)) {
    now = input.now;
  } else {
    degradations.push({
      code: 'now_malformed',
      message:
        'The run had no usable date, so any check that depends on how old the data is was skipped.',
    });
  }

  // The baseline is licence-delivered vocabulary and is threaded straight
  // through to config resolution — the engine never inspects it, and no rule
  // ever sees it as anything but the ordinary resolved lists. An absent
  // baseline resolves exactly as this call did before the parameter existed.
  const resolution = resolveConfig(input.config, rules, input.baseline);
  degradations.push(...resolution.degradations);

  const { config } = resolution;

  const trace = rules.map((rule) =>
    evaluateRule(rule, config, lead, now, degradations),
  );

  const contributing = trace.filter((entry) => entry.contributed);
  const totalWeight = roundTo(
    contributing.reduce((sum, entry) => sum + entry.pointsPossible, 0),
    4,
  );
  const earnedWeight = roundTo(
    contributing.reduce((sum, entry) => sum + entry.pointsEarned, 0),
    4,
  );

  let score: number | null = null;

  if (totalWeight > 0) {
    score = roundTo((earnedWeight / totalWeight) * 100, 1);
  } else {
    // Fail-open level 3: nothing could be scored. The lead is not held on a
    // technicality — it goes through, flagged.
    degradations.push({
      code: 'no_scorable_rules',
      message:
        'No Greenlight check was able to score this lead, so it was let through unscored and flagged for review.',
    });
  }

  const band = bandFor(score, config.bands);

  const blockingFailure = trace.find(
    (entry) => entry.severity === 'blocking' && entry.outcome === 'fail',
  );
  const criticalFailure = trace.find(
    (entry) => entry.severity === 'critical' && entry.outcome === 'fail',
  );

  let decision: GateDecision;

  if (blockingFailure !== undefined) {
    decision = 'blocked';
  } else if (score === null) {
    decision = 'unscored';
  } else if (criticalFailure !== undefined) {
    decision = 'gated';
  } else {
    decision = score >= config.gateThreshold ? 'approved' : 'gated';
  }

  const reasons = collectReasons(trace);

  return {
    score,
    band,
    decision,
    gateThreshold: config.gateThreshold,
    summary: summarise(
      decision,
      score,
      band,
      config.gateThreshold,
      blockingFailure?.explanation ?? null,
    ),
    reasons,
    trace,
    degradations,
    configSource: resolution.source,
    scoredAt: now === null ? null : now.toISOString(),
    leadId: lead.id ?? null,
    engineVersion: SCORING_ENGINE_VERSION,
    totalWeight,
    earnedWeight,
  };
};

/**
 * Score a lead and decide whether it is cleared to work.
 *
 * This is the entire public entry point. It never throws and always returns a
 * result — that guarantee is the product, not an implementation detail.
 */
export const scoreLead = (input: ScoreLeadInput): ScoringResult => {
  try {
    return runScoring(input);
  } catch (error) {
    // Fail-open level 4: the engine itself broke. The lead still passes.
    const leadId =
      isPlainObject(input?.lead) && typeof input.lead['id'] === 'string'
        ? input.lead['id']
        : null;

    return {
      score: null,
      band: null,
      decision: 'unscored',
      gateThreshold: 0,
      summary:
        'Greenlight hit an unexpected error and could not score this lead, so it has been let through and flagged for a human to look at.',
      reasons: ['Greenlight could not complete a scoring run for this lead.'],
      trace: [],
      degradations: [
        {
          code: 'engine_errored',
          message:
            'Greenlight hit an unexpected error while scoring. The lead was let through rather than held.',
          detail: errorMessage(error),
        },
      ],
      configSource: 'defaults',
      scoredAt: isUsableDate(input?.now) ? input.now.toISOString() : null,
      leadId,
      engineVersion: SCORING_ENGINE_VERSION,
      totalWeight: 0,
      earnedWeight: 0,
    };
  }
};
