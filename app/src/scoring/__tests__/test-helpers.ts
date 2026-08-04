import { buildDefaultConfig } from 'src/scoring/config';
import { createFieldReader } from 'src/scoring/field-access';
import type {
  LeadRecord,
  ResolvedScoringConfig,
  RuleSeverity,
  RuleVerdict,
  ScoringRule,
} from 'src/scoring/types';

/** Fixed clock for every test. The engine never reads the real one. */
export const NOW = new Date('2026-08-02T12:00:00.000Z');

export const daysBefore = (days: number): Date =>
  new Date(NOW.getTime() - days * 86_400_000);

export const makeLead = (fields: Record<string, unknown>): LeadRecord => ({
  id: 'lead-1',
  fields,
});

/** Evaluate one rule in isolation, exactly as the engine would. */
export const evaluateRule = (
  rule: ScoringRule,
  fields: Record<string, unknown>,
  configOverrides: Partial<ResolvedScoringConfig> = {},
  now: Date | null = NOW,
): RuleVerdict => {
  const config: ResolvedScoringConfig = {
    ...buildDefaultConfig(),
    ...configOverrides,
  };
  const lead = makeLead(fields);

  return rule.evaluate({
    lead,
    config,
    now,
    read: createFieldReader(lead, config.fieldMapping),
  });
};

/** A rule with a fixed verdict, for testing the engine rather than the rules. */
export const stubRule = (
  id: string,
  weight: number,
  verdict: RuleVerdict,
  severity: RuleSeverity = 'major',
): ScoringRule => ({
  id,
  name: `Stub ${id}`,
  category: 'contact',
  question: `Question for ${id}?`,
  why: `Why ${id} exists.`,
  defaultEnabled: true,
  defaultSeverity: severity,
  defaultWeight: weight,
  reads: [],
  evaluate: () => verdict,
});

export const throwingRule = (
  id: string,
  weight: number,
  message = 'rule exploded',
): ScoringRule => ({
  ...stubRule(id, weight, { outcome: 'pass', explanation: 'never reached' }),
  evaluate: () => {
    throw new Error(message);
  },
});

/** A lead that passes every default rule. */
export const perfectLeadFields = {
  companyName: 'Northwind Traders',
  industry: 'Manufacturing',
  country: 'United Kingdom',
  employees: 250,
  name: { firstName: 'Ada', lastName: 'Lovelace' },
  jobTitle: 'Chief Technology Officer',
  emails: { primaryEmail: 'ada.lovelace@northwind.example', additionalEmails: [] },
  phones: { primaryPhoneNumber: '+44 20 7946 0958' },
  lastVerifiedAt: daysBefore(5).toISOString(),
  optedOut: false,
} as const;
