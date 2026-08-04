import {
  companyIdentifiedRule,
  complianceOptOutRule,
  contactDecisionMakerRule,
  contactEmailValidRule,
  contactNamedPersonRule,
  contactPhoneValidRule,
  contactSharedInboxRule,
  dataFreshnessRule,
  describeRuleCatalogue,
  icpCompanySizeRule,
  icpIndustryRule,
  icpRegionRule,
  ALL_RULES,
} from 'src/scoring/rules';
import { scoreLead } from 'src/scoring';
import { describe, expect, it } from 'vitest';
import {
  daysBefore,
  evaluateRule,
  makeLead,
  NOW,
  perfectLeadFields,
} from 'src/scoring/__tests__/test-helpers';

describe('rule catalogue', () => {
  it('has a unique id, a question and a why for every rule', () => {
    const ids = ALL_RULES.map((rule) => rule.id);

    expect(new Set(ids).size).toBe(ids.length);

    for (const rule of ALL_RULES) {
      expect(rule.question.length).toBeGreaterThan(10);
      expect(rule.why.length).toBeGreaterThan(30);
      expect(rule.defaultWeight).toBeGreaterThan(0);
    }
  });

  it('publishes the catalogue for docs and in-app help', () => {
    const catalogue = describeRuleCatalogue();

    expect(catalogue).toHaveLength(ALL_RULES.length);
    expect(catalogue[0]).toMatchObject({
      id: ALL_RULES[0]?.id,
      defaultSeverity: ALL_RULES[0]?.defaultSeverity,
    });
  });
});

describe('icp.industry', () => {
  const icp = { industries: ['Manufacturing', 'Logistics'], regions: [], sizeBands: [] };

  it('passes when the industry is on the target list, case-insensitively', () => {
    const verdict = evaluateRule(icpIndustryRule, { industry: 'manufacturing' }, { icp });

    expect(verdict.outcome).toBe('pass');
    expect(verdict.explanation).toContain('target industries');
  });

  it('fails when the industry is off the list', () => {
    const verdict = evaluateRule(icpIndustryRule, { industry: 'Hospitality' }, { icp });

    expect(verdict.outcome).toBe('fail');
    expect(verdict.explanation).toContain('Hospitality');
    expect(verdict.remedy).toBeDefined();
  });

  it('fails when no industry is recorded at all', () => {
    const verdict = evaluateRule(icpIndustryRule, {}, { icp });

    expect(verdict.outcome).toBe('fail');
    expect(verdict.explanation).toContain('no industry');
  });

  it('is not applicable while the ICP list is empty (permissive default)', () => {
    const verdict = evaluateRule(icpIndustryRule, { industry: 'Anything' });

    expect(verdict.outcome).toBe('not_applicable');
  });
});

describe('icp.region', () => {
  const icp = { industries: [], regions: ['United Kingdom', 'Ireland'], sizeBands: [] };

  it('passes for a covered region', () => {
    expect(
      evaluateRule(icpRegionRule, { country: 'United Kingdom' }, { icp }).outcome,
    ).toBe('pass');
  });

  it('fails for an uncovered region', () => {
    expect(evaluateRule(icpRegionRule, { country: 'Brazil' }, { icp }).outcome).toBe(
      'fail',
    );
  });

  it('fails when no region is recorded', () => {
    expect(evaluateRule(icpRegionRule, {}, { icp }).outcome).toBe('fail');
  });

  it('is not applicable while no regions are configured', () => {
    expect(evaluateRule(icpRegionRule, { country: 'Brazil' }).outcome).toBe(
      'not_applicable',
    );
  });
});

describe('icp.company-size', () => {
  const icp = {
    industries: [],
    regions: [],
    sizeBands: [
      { label: 'Mid-market', minEmployees: 50, maxEmployees: 500 },
      { label: 'Enterprise', minEmployees: 5000, maxEmployees: null },
    ],
  };

  it('passes inside a band', () => {
    const verdict = evaluateRule(icpCompanySizeRule, { employees: 250 }, { icp });

    expect(verdict.outcome).toBe('pass');
    expect(verdict.explanation).toContain('Mid-market');
  });

  it('treats band edges as inclusive', () => {
    expect(evaluateRule(icpCompanySizeRule, { employees: 50 }, { icp }).outcome).toBe(
      'pass',
    );
    expect(evaluateRule(icpCompanySizeRule, { employees: 500 }, { icp }).outcome).toBe(
      'pass',
    );
    expect(evaluateRule(icpCompanySizeRule, { employees: 49 }, { icp }).outcome).toBe(
      'fail',
    );
    expect(evaluateRule(icpCompanySizeRule, { employees: 501 }, { icp }).outcome).toBe(
      'fail',
    );
  });

  it('treats an open-ended band as unbounded above', () => {
    expect(
      evaluateRule(icpCompanySizeRule, { employees: 250_000 }, { icp }).outcome,
    ).toBe('pass');
  });

  it('fails when headcount is missing', () => {
    expect(evaluateRule(icpCompanySizeRule, {}, { icp }).outcome).toBe('fail');
  });

  it('is not applicable while no size bands are configured', () => {
    expect(evaluateRule(icpCompanySizeRule, { employees: 3 }).outcome).toBe(
      'not_applicable',
    );
  });
});

describe('company.identified', () => {
  it('passes with a real company name', () => {
    expect(
      evaluateRule(companyIdentifiedRule, { companyName: 'Northwind Traders' }).outcome,
    ).toBe('pass');
  });

  it('fails with no company', () => {
    expect(evaluateRule(companyIdentifiedRule, {}).outcome).toBe('fail');
  });

  it('fails on placeholder junk', () => {
    const verdict = evaluateRule(companyIdentifiedRule, { companyName: 'n/a' });

    expect(verdict.outcome).toBe('fail');
    expect(verdict.explanation).toContain('placeholder');
  });
});

describe('contact.named-person', () => {
  it('passes with a full name', () => {
    expect(
      evaluateRule(contactNamedPersonRule, {
        name: { firstName: 'Ada', lastName: 'Lovelace' },
      }).outcome,
    ).toBe('pass');
  });

  it('gives partial credit for a first name only', () => {
    const verdict = evaluateRule(contactNamedPersonRule, { name: 'Ada' });

    expect(verdict.outcome).toBe('partial');
    expect(verdict.credit).toBe(0.5);
  });

  it('fails with no name', () => {
    expect(evaluateRule(contactNamedPersonRule, {}).outcome).toBe('fail');
  });

  it('fails on a placeholder name', () => {
    expect(evaluateRule(contactNamedPersonRule, { name: 'unknown' }).outcome).toBe(
      'fail',
    );
  });
});

describe('contact.decision-maker', () => {
  it('passes for a title with buying authority', () => {
    const verdict = evaluateRule(contactDecisionMakerRule, {
      jobTitle: 'Chief Technology Officer',
    });

    expect(verdict.outcome).toBe('pass');
  });

  it('passes for a VP without matching unrelated words', () => {
    expect(
      evaluateRule(contactDecisionMakerRule, { jobTitle: 'VP of Engineering' }).outcome,
    ).toBe('pass');
    expect(
      evaluateRule(contactDecisionMakerRule, { jobTitle: 'Developer Advocate' }).outcome,
    ).toBe('fail');
  });

  it('gives partial credit to an influencer', () => {
    const verdict = evaluateRule(contactDecisionMakerRule, {
      jobTitle: 'Procurement Manager',
    });

    expect(verdict.outcome).toBe('partial');
    expect(verdict.credit).toBe(0.5);
  });

  it('fails for an individual contributor', () => {
    const verdict = evaluateRule(contactDecisionMakerRule, {
      jobTitle: 'Junior Accountant',
    });

    expect(verdict.outcome).toBe('fail');
    expect(verdict.remedy).toContain('budget authority');
  });

  it('fails when there is no title at all', () => {
    expect(evaluateRule(contactDecisionMakerRule, {}).outcome).toBe('fail');
  });

  it('honours a customised decision-maker list', () => {
    const verdict = evaluateRule(
      contactDecisionMakerRule,
      { jobTitle: 'Practice Lead' },
      { decisionMakerTitles: ['practice lead'] },
    );

    expect(verdict.outcome).toBe('pass');
  });
});

describe('contact.email-valid', () => {
  it('passes a well-formed address', () => {
    const verdict = evaluateRule(contactEmailValidRule, {
      emails: { primaryEmail: 'ada@northwind.example' },
    });

    expect(verdict.outcome).toBe('pass');
  });

  it('fails when there is no email', () => {
    expect(evaluateRule(contactEmailValidRule, {}).outcome).toBe('fail');
  });

  it.each([
    'ada@',
    '@northwind.example',
    'ada northwind.example',
    'ada@@northwind.example',
    'ada..lovelace@northwind.example',
    'ada@northwind',
  ])('fails malformed address %s', (address) => {
    expect(evaluateRule(contactEmailValidRule, { email: address }).outcome).toBe('fail');
  });
});

describe('contact.shared-inbox', () => {
  it('passes a personal mailbox', () => {
    expect(
      evaluateRule(contactSharedInboxRule, { email: 'ada.lovelace@northwind.example' })
        .outcome,
    ).toBe('pass');
  });

  it('fails a shared inbox', () => {
    const verdict = evaluateRule(contactSharedInboxRule, {
      email: 'info@northwind.example',
    });

    expect(verdict.outcome).toBe('fail');
    expect(verdict.explanation).toContain('shared');
  });

  it('sees through plus-addressing on a shared inbox', () => {
    expect(
      evaluateRule(contactSharedInboxRule, { email: 'sales+uk@northwind.example' })
        .outcome,
    ).toBe('fail');
  });

  it('defers to the email rule when the address is unusable', () => {
    expect(evaluateRule(contactSharedInboxRule, { email: 'nope' }).outcome).toBe(
      'not_applicable',
    );
  });
});

describe('contact.phone-valid', () => {
  it('passes an international number', () => {
    expect(
      evaluateRule(contactPhoneValidRule, {
        phones: { primaryPhoneNumber: '+44 20 7946 0958' },
      }).outcome,
    ).toBe('pass');
  });

  it('fails when absent', () => {
    expect(evaluateRule(contactPhoneValidRule, {}).outcome).toBe('fail');
  });

  it('fails a number that is too short or is prose', () => {
    expect(evaluateRule(contactPhoneValidRule, { phone: '12345' }).outcome).toBe('fail');
    expect(
      evaluateRule(contactPhoneValidRule, { phone: 'call the switchboard' }).outcome,
    ).toBe('fail');
  });
});

describe('data.freshness', () => {
  it('passes inside the shelf life', () => {
    const verdict = evaluateRule(dataFreshnessRule, {
      lastVerifiedAt: daysBefore(10).toISOString(),
    });

    expect(verdict.outcome).toBe('pass');
  });

  it('treats the shelf-life boundary itself as fresh', () => {
    expect(
      evaluateRule(dataFreshnessRule, { lastVerifiedAt: daysBefore(30).toISOString() })
        .outcome,
    ).toBe('pass');
    expect(
      evaluateRule(dataFreshnessRule, {
        lastVerifiedAt: daysBefore(30.0001).toISOString(),
      }).outcome,
    ).toBe('partial');
  });

  it('decays linearly between one and two shelf lives', () => {
    const verdict = evaluateRule(dataFreshnessRule, {
      lastVerifiedAt: daysBefore(45).toISOString(),
    });

    expect(verdict.outcome).toBe('partial');
    expect(verdict.credit).toBeCloseTo(0.5, 5);
  });

  it('fails at exactly twice the shelf life', () => {
    expect(
      evaluateRule(dataFreshnessRule, { lastVerifiedAt: daysBefore(60).toISOString() })
        .outcome,
    ).toBe('fail');
  });

  it('fails when nothing records a verification date', () => {
    expect(evaluateRule(dataFreshnessRule, {}).outcome).toBe('fail');
  });

  it('fails a verification date in the future', () => {
    const future = new Date(NOW.getTime() + 5 * 86_400_000).toISOString();
    const verdict = evaluateRule(dataFreshnessRule, { lastVerifiedAt: future });

    expect(verdict.outcome).toBe('fail');
    expect(verdict.explanation).toContain('future');
  });

  it('honours a per-field shelf life override', () => {
    const verdict = evaluateRule(
      dataFreshnessRule,
      { lastVerifiedAt: daysBefore(40).toISOString() },
      { fieldShelfLifeDays: { lastVerifiedAt: 90 } },
    );

    expect(verdict.outcome).toBe('pass');
  });

  it('opts out when the run has no usable clock', () => {
    expect(
      evaluateRule(dataFreshnessRule, { lastVerifiedAt: '2020-01-01' }, {}, null).outcome,
    ).toBe('not_applicable');
  });
});

describe('compliance.opt-out', () => {
  /* --- The four-way matrix: Greenlight's register x the customer's ---------- */

  it('fails when only Greenlight’s own suppression field is set', () => {
    const verdict = evaluateRule(complianceOptOutRule, {
      greenlightSuppressed: true,
    });

    expect(verdict.outcome).toBe('fail');
    expect(verdict.detail?.suppressedByGreenlight).toBe(true);
    expect(verdict.detail?.suppressedByCustomerField).toBe(false);
  });

  it('fails when only the customer’s own mapped opt-out field is set', () => {
    const verdict = evaluateRule(complianceOptOutRule, {
      greenlightSuppressed: false,
      optedOut: true,
    });

    expect(verdict.outcome).toBe('fail');
    expect(verdict.detail?.suppressedByGreenlight).toBe(false);
    expect(verdict.detail?.suppressedByCustomerField).toBe(true);
    expect(verdict.explanation).toContain('opted out');
  });

  it('fails when both say so, and says so', () => {
    const verdict = evaluateRule(complianceOptOutRule, {
      greenlightSuppressed: true,
      greenlightSuppressionReason: 'SPAM_COMPLAINT',
      optedOut: true,
    });

    expect(verdict.outcome).toBe('fail');
    expect(verdict.detail?.suppressedByGreenlight).toBe(true);
    expect(verdict.detail?.suppressedByCustomerField).toBe(true);
    expect(verdict.explanation).toContain('spam complaint');
  });

  it('passes when neither says so — and only when both were actually readable', () => {
    const verdict = evaluateRule(complianceOptOutRule, {
      greenlightSuppressed: false,
      optedOut: false,
    });

    expect(verdict.outcome).toBe('pass');
    expect(verdict.detail?.suppressionDataAvailable).toBe(true);
  });

  /* --- Union, not override -------------------------------------------------- */

  it('does not let a clear Greenlight field override the customer’s opt-out', () => {
    expect(
      evaluateRule(complianceOptOutRule, {
        greenlightSuppressed: false,
        unsubscribed: true,
      }).outcome,
    ).toBe('fail');
  });

  it('does not let a clear customer field override Greenlight’s suppression', () => {
    expect(
      evaluateRule(complianceOptOutRule, {
        greenlightSuppressed: true,
        optedOut: false,
      }).outcome,
    ).toBe('fail');
  });

  it('fails when any mapped opt-out field is set, not just the first', () => {
    expect(
      evaluateRule(complianceOptOutRule, { optedOut: false, unsubscribed: true }).outcome,
    ).toBe('fail');
  });

  it.each(['true', 'yes', 'unsubscribed', 'do_not_contact'])(
    'fails on the textual opt-out marker %s',
    (marker) => {
      expect(evaluateRule(complianceOptOutRule, { doNotContact: marker }).outcome).toBe(
        'fail',
      );
    },
  );

  /* --- A half-cleared record still blocks ----------------------------------- */

  it('treats a recorded reason as suppression even with the flag unticked', () => {
    const verdict = evaluateRule(complianceOptOutRule, {
      greenlightSuppressed: false,
      greenlightSuppressionReason: 'HARD_BOUNCE',
    });

    expect(verdict.outcome).toBe('fail');
    expect(verdict.explanation).toContain('hard bounce');
    expect(verdict.remedy).toContain('Allow contact again');
  });

  /* --- Unknown is not the same answer as clear ------------------------------ */

  it('is not applicable when no register exists anywhere, rather than passing', () => {
    const verdict = evaluateRule(complianceOptOutRule, {});

    expect(verdict.outcome).toBe('not_applicable');
    expect(verdict.detail?.suppressionDataAvailable).toBe(false);
  });

  it('pays out nothing for an unanswerable compliance check', () => {
    const unknown = scoreLead({
      lead: makeLead({}),
      now: NOW,
      rules: [complianceOptOutRule],
    });

    // No scorable rule at all, so the engine fails open rather than awarding the
    // 15 points to a workspace that records nothing about opt-outs.
    expect(unknown.score).toBeNull();
    expect(unknown.decision).toBe('unscored');
    expect(unknown.trace[0]?.pointsPossible).toBe(0);
    expect(unknown.trace[0]?.pointsEarned).toBe(0);
    expect(unknown.trace[0]?.contributed).toBe(false);
  });

  it('still pays out in full when Greenlight’s own register answers "no entry"', () => {
    const known = scoreLead({
      lead: makeLead({ greenlightSuppressed: false }),
      now: NOW,
      rules: [complianceOptOutRule],
    });

    expect(known.score).toBe(100);
    expect(known.trace[0]?.pointsEarned).toBe(15);
  });

  it('never blocks a lead just because the answer is unknown', () => {
    // Only a blocking *fail* produces `blocked`; `not_applicable` must not.
    const result = scoreLead({
      lead: makeLead({ ...perfectLeadFields, optedOut: undefined }),
      now: NOW,
    });

    expect(result.decision).not.toBe('blocked');
  });
});

describe('every rule explains itself in plain language', () => {
  it.each(ALL_RULES.map((rule) => [rule.id, rule] as const))(
    '%s returns a sentence for an empty lead',
    (_id, rule) => {
      const verdict = evaluateRule(rule, {});

      expect(verdict.explanation.length).toBeGreaterThan(20);
      expect(verdict.explanation.trim().endsWith('.')).toBe(true);
    },
  );
});
