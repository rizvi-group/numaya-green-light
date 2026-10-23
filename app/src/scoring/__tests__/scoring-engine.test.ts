import { scoreLead } from 'src/scoring/engine';
import { toLeadRecord } from 'src/scoring/field-access';
import { ALL_RULES, companyIdentifiedRule } from 'src/scoring/rules';
import { describe, expect, it } from 'vitest';
import {
  makeLead,
  NOW,
  perfectLeadFields,
  stubRule,
} from 'src/scoring/__tests__/test-helpers';

const pass = { outcome: 'pass', explanation: 'Passed.' } as const;
const fail = { outcome: 'fail', explanation: 'Failed.' } as const;
const notApplicable = {
  outcome: 'not_applicable',
  explanation: 'Nothing to judge.',
} as const;

/** A single rule whose partial credit dials the final score to an exact value. */
const dialRules = (targetScore: number) => [
  stubRule('dial', 1000, {
    outcome: 'partial',
    credit: targetScore / 100,
    explanation: `Dialled to ${targetScore}.`,
  }),
];

describe('weighted combination', () => {
  it('combines rule results by configured weight', () => {
    const result = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: {},
      rules: [stubRule('a', 30, pass), stubRule('b', 70, fail)],
    });

    expect(result.totalWeight).toBe(100);
    expect(result.earnedWeight).toBe(30);
    expect(result.score).toBe(30);
  });

  it('scales partial credit by weight', () => {
    const result = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: {},
      rules: [
        stubRule('a', 40, { outcome: 'partial', credit: 0.25, explanation: 'Half-ish.' }),
        stubRule('b', 60, pass),
      ],
    });

    expect(result.earnedWeight).toBe(70);
    expect(result.score).toBe(70);
  });

  it('honours weights supplied by configuration over rule defaults', () => {
    const result = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: { rules: { a: { weight: 90 }, b: { weight: 10 } } },
      rules: [stubRule('a', 1, pass), stubRule('b', 1, fail)],
    });

    expect(result.score).toBe(90);
    expect(result.configSource).toBe('provided');
  });

  it('excludes not-applicable rules from the denominator', () => {
    const result = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: {},
      rules: [stubRule('a', 50, pass), stubRule('b', 50, notApplicable)],
    });

    expect(result.totalWeight).toBe(50);
    expect(result.score).toBe(100);
  });

  it('excludes disabled rules entirely', () => {
    const result = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: { rules: { b: { enabled: false } } },
      rules: [stubRule('a', 50, pass), stubRule('b', 50, fail)],
    });

    expect(result.score).toBe(100);
    expect(result.trace.find((entry) => entry.ruleId === 'b')?.outcome).toBe('skipped');
    expect(result.trace.find((entry) => entry.ruleId === 'b')?.contributed).toBe(false);
  });

  it('reports advisory rules in the trace without scoring them', () => {
    const result = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: {},
      rules: [stubRule('a', 50, pass), stubRule('advice', 50, fail, 'advisory')],
    });

    expect(result.score).toBe(100);

    const advisory = result.trace.find((entry) => entry.ruleId === 'advice');

    expect(advisory?.outcome).toBe('fail');
    expect(advisory?.contributed).toBe(false);
    expect(advisory?.pointsPossible).toBe(0);
  });
});

describe('bands', () => {
  it.each([
    [100, 'excellent'],
    [85, 'excellent'],
    [84.9, 'good'],
    [70, 'good'],
    [69.9, 'fair'],
    [50, 'fair'],
    [49.9, 'poor'],
    [0, 'poor'],
  ])('maps a score of %s to the %s band', (score, bandId) => {
    const result = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: {},
      rules: dialRules(score),
    });

    expect(result.score).toBe(score);
    expect(result.band?.id).toBe(bandId);
  });

  it('uses configured bands when they are supplied', () => {
    const result = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: {
        bands: [
          { id: 'hot', label: 'Hot', minScore: 60 },
          { id: 'cold', label: 'Cold', minScore: 0 },
        ],
      },
      rules: dialRules(60),
    });

    expect(result.band?.id).toBe('hot');
  });
});

describe('gate threshold', () => {
  it('approves a score exactly on the threshold', () => {
    const result = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: { gateThreshold: 50 },
      rules: dialRules(50),
    });

    expect(result.decision).toBe('approved');
  });

  it('gates the smallest possible step below the threshold', () => {
    const result = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: { gateThreshold: 50 },
      rules: dialRules(49.9),
    });

    expect(result.decision).toBe('gated');
    expect(result.summary).toContain('Held for review');
  });

  it('approves everything at a threshold of 0', () => {
    const result = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: { gateThreshold: 0 },
      rules: dialRules(0),
    });

    expect(result.decision).toBe('approved');
  });

  it('gates everything short of a threshold of 100', () => {
    expect(
      scoreLead({
        lead: makeLead({}),
        now: NOW,
        config: { gateThreshold: 100 },
        rules: dialRules(99.9),
      }).decision,
    ).toBe('gated');

    expect(
      scoreLead({
        lead: makeLead({}),
        now: NOW,
        config: { gateThreshold: 100 },
        rules: dialRules(100),
      }).decision,
    ).toBe('approved');
  });
});

describe('severity escalation', () => {
  it('blocks on a failed blocking rule whatever the score says', () => {
    const result = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: { gateThreshold: 10 },
      rules: [stubRule('good', 900, pass), stubRule('optout', 1, fail, 'blocking')],
    });

    expect(result.score).toBeGreaterThan(90);
    expect(result.decision).toBe('blocked');
    expect(result.summary).toBe('Failed.');
  });

  it('gates on a failed critical rule even above the threshold', () => {
    const result = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: { gateThreshold: 10 },
      rules: [stubRule('good', 900, pass), stubRule('email', 1, fail, 'critical')],
    });

    expect(result.score).toBeGreaterThan(90);
    expect(result.decision).toBe('gated');
  });

  it('does not escalate when the critical rule passes', () => {
    const result = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: { gateThreshold: 10 },
      rules: [stubRule('good', 900, pass), stubRule('email', 1, pass, 'critical')],
    });

    expect(result.decision).toBe('approved');
  });
});

describe('trace', () => {
  it('records one entry per rule with its arithmetic and explanation', () => {
    const result = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: {},
      rules: [stubRule('a', 30, pass), stubRule('b', 70, fail)],
    });

    expect(result.trace).toHaveLength(2);

    const entryA = result.trace[0];

    expect(entryA).toMatchObject({
      ruleId: 'a',
      outcome: 'pass',
      credit: 1,
      weight: 30,
      pointsEarned: 30,
      pointsPossible: 30,
      contributed: true,
    });
    expect(entryA?.question).toContain('?');
  });

  it('records which fields a rule consulted and what it saw', () => {
    const result = scoreLead({
      lead: makeLead({ companyName: 'Northwind Traders' }),
      now: NOW,
      config: {},
      rules: [companyIdentifiedRule],
    });

    const observation = result.trace[0]?.observations[0];

    expect(observation?.key).toBe('companyName');
    expect(observation?.mappedTo).toBe('companyName');
    expect(observation?.present).toBe(true);
    expect(observation?.display).toBe('Northwind Traders');
  });

  it('records the mapped field as missing when nothing resolves', () => {
    const result = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: {},
      rules: [companyIdentifiedRule],
    });

    const observation = result.trace[0]?.observations[0];

    expect(observation?.present).toBe(false);
    expect(observation?.mappedTo).toBeNull();
    expect(observation?.display).toBe('(not set)');
    expect(observation?.candidates.length).toBeGreaterThan(1);
  });

  it('surfaces the worst reasons first and caps the headline list', () => {
    const result = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: {},
      rules: [
        stubRule('minor-miss', 10, { outcome: 'fail', explanation: 'Minor miss.' }, 'minor'),
        stubRule('critical-miss', 10, { outcome: 'fail', explanation: 'Critical miss.' }, 'critical'),
        stubRule('major-miss', 10, { outcome: 'fail', explanation: 'Major miss.' }, 'major'),
        stubRule('ok', 10, pass),
        stubRule('f1', 1, { outcome: 'fail', explanation: 'Filler one.' }, 'minor'),
        stubRule('f2', 1, { outcome: 'fail', explanation: 'Filler two.' }, 'minor'),
        stubRule('f3', 1, { outcome: 'fail', explanation: 'Filler three.' }, 'minor'),
      ],
    });

    expect(result.reasons[0]).toBe('Critical miss.');
    expect(result.reasons[1]).toBe('Major miss.');
    expect(result.reasons).toHaveLength(5);
  });
});

describe('determinism and provenance', () => {
  it('echoes the supplied clock rather than reading its own', () => {
    const result = scoreLead({
      lead: makeLead(perfectLeadFields),
      now: NOW,
      config: {},
    });

    expect(result.scoredAt).toBe(NOW.toISOString());
    expect(result.engineVersion).toBeTruthy();
    expect(result.leadId).toBe('lead-1');
  });

  it('produces identical output for identical input', () => {
    const input = {
      lead: makeLead(perfectLeadFields),
      now: NOW,
      config: {},
    };

    expect(JSON.stringify(scoreLead(input))).toBe(JSON.stringify(scoreLead(input)));
  });
});

describe('the default catalogue end to end', () => {
  it('clears a complete, fresh, decision-maker lead', () => {
    const result = scoreLead({
      lead: makeLead(perfectLeadFields),
      now: NOW,
      config: {},
    });

    expect(result.score).toBe(100);
    expect(result.band?.id).toBe('excellent');
    expect(result.decision).toBe('approved');
    expect(result.reasons).toHaveLength(0);
    expect(result.trace).toHaveLength(ALL_RULES.length);
  });

  it('gates an empty lead and explains why', () => {
    const result = scoreLead({ lead: makeLead({}), now: NOW, config: {} });

    expect(result.decision).toBe('gated');
    expect(result.score).toBeLessThan(50);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.trace.every((entry) => entry.explanation.length > 0)).toBe(true);
  });

  it('blocks an opted-out lead however good it otherwise looks', () => {
    const result = scoreLead({
      lead: makeLead({ ...perfectLeadFields, optedOut: true }),
      now: NOW,
      config: {},
    });

    expect(result.decision).toBe('blocked');
    expect(result.summary).toContain('opted out');
  });

  /* -------------------------------------------------------------------------- */
  /* The excluded-industry gate                                                  */
  /* -------------------------------------------------------------------------- */

  describe('the excluded-industry gate', () => {
    it('blocks an EXCLUDED lead however good it otherwise looks', () => {
      const result = scoreLead({
        lead: makeLead({ ...perfectLeadFields, industry: 'EXCLUDED' }),
        now: NOW,
        config: {},
      });

      expect(result.decision).toBe('blocked');
      // Weight 0: the gate decides the outcome without touching the score.
      expect(result.score).toBe(100);
      expect(result.summary).toContain('EXCLUDED');
    });

    it('lets a GOVERNMENT_EDUCATION lead pass end to end', () => {
      const result = scoreLead({
        lead: makeLead({
          ...perfectLeadFields,
          industry: 'GOVERNMENT_EDUCATION',
        }),
        now: NOW,
        config: { icp: { industries: ['GOVERNMENT_EDUCATION'] } },
      });

      expect(result.decision).toBe('approved');
      expect(result.score).toBe(100);

      const gate = result.trace.find(
        (entry) => entry.ruleId === 'icp.industry-excluded',
      );

      expect(gate?.outcome).toBe('pass');
      expect(gate?.pointsPossible).toBe(0);
    });

    it('leaves an industry-less lead unblocked — unknown is not excluded', () => {
      const result = scoreLead({
        lead: makeLead({ ...perfectLeadFields, industry: undefined }),
        now: NOW,
        config: {},
      });

      expect(result.decision).toBe('approved');

      const gate = result.trace.find(
        (entry) => entry.ruleId === 'icp.industry-excluded',
      );

      expect(gate?.outcome).toBe('not_applicable');
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Company-held firmographics, through the default mapping                     */
  /* -------------------------------------------------------------------------- */

  describe('company-held firmographics', () => {
    /** A Twenty-shaped lead: country and headcount live on Company, not Person. */
    const companyLead = (company: Record<string, unknown>) =>
      toLeadRecord({
        id: 'company-fields-1',
        companyName: 'Northwind Traders',
        industry: 'Manufacturing',
        name: { firstName: 'Ada', lastName: 'Lovelace' },
        jobTitle: 'Chief Technology Officer',
        emails: { primaryEmail: 'ada.lovelace@northwind.example', additionalEmails: [] },
        phones: { primaryPhoneNumber: '+44 20 7946 0958' },
        lastVerifiedAt: NOW.toISOString(),
        optedOut: false,
        company,
      });

    const icp = {
      industries: ['Manufacturing'],
      regions: ['AU'],
      sizeBands: [{ label: 'Mid-market', minEmployees: 50, maxEmployees: 500 }],
    };

    it('reads region and size off the company record when the lead holds nothing', () => {
      const result = scoreLead({
        lead: companyLead({ name: 'Northwind Traders', country: 'AU', employeeCount: 120 }),
        now: NOW,
        config: { icp },
      });

      const region = result.trace.find((entry) => entry.ruleId === 'icp.region');
      const size = result.trace.find(
        (entry) => entry.ruleId === 'icp.company-size',
      );

      expect(region?.outcome).toBe('pass');
      expect(region?.observations[0]?.mappedTo).toBe('company.country');
      expect(size?.outcome).toBe('pass');
      expect(size?.observations[0]?.mappedTo).toBe('company.employeeCount');
    });

    it('lets a human-held value on the lead win over the company record', () => {
      // Candidate order is load-bearing: `field-access.ts` takes the first
      // candidate that yields a value, so `country` must outrank
      // `company.country`. The company says AU, the lead says NZ, and the ICP
      // only sells into AU — the honest verdict is a miss on NZ.
      const lead = companyLead({
        name: 'Northwind Traders',
        country: 'AU',
        employeeCount: 120,
      });

      const result = scoreLead({
        lead: { ...lead, fields: { ...lead.fields, country: 'NZ' } },
        now: NOW,
        config: { icp },
      });

      const region = result.trace.find((entry) => entry.ruleId === 'icp.region');

      expect(region?.outcome).toBe('fail');
      expect(region?.observations[0]?.mappedTo).toBe('country');
    });

    it('blocks on an EXCLUDED tag that arrives through the company relation', () => {
      // No industry on the lead itself — the tag lives on the company, which
      // is exactly the Twenty shape the mapping candidates exist for.
      const lead = companyLead({ name: 'Northwind Traders', industry: 'EXCLUDED' });

      const result = scoreLead({
        lead: { ...lead, fields: { ...lead.fields, industry: undefined } },
        now: NOW,
        config: { icp },
      });

      expect(result.decision).toBe('blocked');
    });
  });

  /* -------------------------------------------------------------------------- */
  /* Enriched values, read by the real rules                                     */
  /* -------------------------------------------------------------------------- */

  describe('enriched values', () => {
    const enrichedIndustry = (value: string) => ({
      greenlightEnrichment: {
        version: 1,
        fields: {
          industry: {
            value,
            parsedValue: value,
            sourceUrl: 'https://example.com/about',
            retrievedAt: NOW.toISOString(),
            confidence: 0.8,
            verification: 'confirmed',
          },
        },
      },
    });

    const industryVerdict = (result: ReturnType<typeof scoreLead>) =>
      result.trace.find((entry) => entry.ruleId === 'icp.industry');

    it('resolves the enriched dotted path with no configuration at all', () => {
      const result = scoreLead({
        lead: toLeadRecord({
          id: 'enriched-1',
          companyName: 'Acme Pumps Ltd',
          ...enrichedIndustry('industrial manufacturing'),
        }),
        now: NOW,
        config: { icp: { industries: ['industrial manufacturing'] } },
      });

      const verdict = industryVerdict(result);

      expect(verdict?.outcome).toBe('pass');
      expect(verdict?.observations[0]?.mappedTo).toBe(
        'greenlightEnrichment.fields.industry.parsedValue',
      );
    });

    it('lets a human-entered value win over an enriched one', () => {
      const result = scoreLead({
        lead: toLeadRecord({
          id: 'enriched-2',
          companyName: 'Acme Pumps Ltd',
          industry: 'hospitality',
          ...enrichedIndustry('industrial manufacturing'),
        }),
        now: NOW,
        config: { icp: { industries: ['industrial manufacturing'] } },
      });

      const verdict = industryVerdict(result);

      // The human said hospitality. Enrichment only ever fills a hole.
      expect(verdict?.outcome).toBe('fail');
      expect(verdict?.observations[0]?.mappedTo).toBe('industry');
    });

    it('still reaches the enriched value behind a custom Layer 3 mapping', () => {
      const result = scoreLead({
        lead: toLeadRecord({
          id: 'enriched-3',
          companyName: 'Acme Pumps Ltd',
          ...enrichedIndustry('industrial manufacturing'),
        }),
        now: NOW,
        config: {
          icp: { industries: ['industrial manufacturing'] },
          fieldMapping: { industry: ['crm.sector'] },
        },
      });

      expect(industryVerdict(result)?.outcome).toBe('pass');
    });
  });

  it('reads a completely custom schema through the field mapping', () => {
    const result = scoreLead({
      lead: toLeadRecord({
        id: 'custom-1',
        crm: { org: { title: 'Northwind Traders' } },
      }),
      now: NOW,
      config: { fieldMapping: { companyName: ['crm.org.title'] } },
      rules: [companyIdentifiedRule],
    });

    expect(result.score).toBe(100);
    expect(result.leadId).toBe('custom-1');
    expect(result.trace[0]?.observations[0]?.mappedTo).toBe('crm.org.title');
  });
});
