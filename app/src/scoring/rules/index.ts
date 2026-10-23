/**
 * The rule catalogue.
 *
 * Adding a rule is a local change: write a `ScoringRule` in its own file, add
 * it to `ALL_RULES`, and it inherits default settings, config plumbing,
 * weighting, tracing and fail-open error handling for free. Removing one is
 * equally local — a config record referencing a rule that no longer exists is
 * ignored rather than fatal.
 */

import { companyIdentifiedRule } from 'src/scoring/rules/company-identified.rule';
import { complianceOptOutRule } from 'src/scoring/rules/compliance-opt-out.rule';
import { contactDecisionMakerRule } from 'src/scoring/rules/contact-decision-maker.rule';
import { contactEmailValidRule } from 'src/scoring/rules/contact-email-valid.rule';
import { contactNamedPersonRule } from 'src/scoring/rules/contact-named-person.rule';
import { contactPhoneValidRule } from 'src/scoring/rules/contact-phone-valid.rule';
import { contactSharedInboxRule } from 'src/scoring/rules/contact-shared-inbox.rule';
import { dataFreshnessRule } from 'src/scoring/rules/data-freshness.rule';
import { icpCompanySizeRule } from 'src/scoring/rules/icp-company-size.rule';
import { icpIndustryRule } from 'src/scoring/rules/icp-industry.rule';
import { icpRegionRule } from 'src/scoring/rules/icp-region.rule';
import { industryExcludedRule } from 'src/scoring/rules/industry-excluded.rule';
import type { RuleCatalogueEntry, ScoringRule } from 'src/scoring/types';

export const ALL_RULES: readonly ScoringRule[] = [
  complianceOptOutRule,
  icpIndustryRule,
  industryExcludedRule,
  icpRegionRule,
  icpCompanySizeRule,
  companyIdentifiedRule,
  contactNamedPersonRule,
  contactDecisionMakerRule,
  contactEmailValidRule,
  contactSharedInboxRule,
  contactPhoneValidRule,
  dataFreshnessRule,
];

export {
  companyIdentifiedRule,
  complianceOptOutRule,
  contactDecisionMakerRule,
  contactEmailValidRule,
  contactNamedPersonRule,
  contactPhoneValidRule,
  contactSharedInboxRule,
  dataFreshnessRule,
  icpCompanySizeRule,
  icpIndustryRule,
  icpRegionRule,
  industryExcludedRule,
};

/**
 * The published rule catalogue — "each rule: what it checks, why, what fixes
 * it". The same text belongs in the docs and in the in-app help.
 */
export const describeRuleCatalogue = (
  rules: readonly ScoringRule[] = ALL_RULES,
): readonly RuleCatalogueEntry[] =>
  rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    category: rule.category,
    question: rule.question,
    why: rule.why,
    reads: rule.reads,
    defaultEnabled: rule.defaultEnabled,
    defaultSeverity: rule.defaultSeverity,
    defaultWeight: rule.defaultWeight,
  }));
