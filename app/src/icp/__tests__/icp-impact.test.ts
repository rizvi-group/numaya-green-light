import { describe, expect, it } from 'vitest';

import { previewIcpImpact } from 'src/icp/icp-impact';
import type { IcpSelection } from 'src/icp/icp-proposal';

const NOW = new Date('2026-08-03T12:00:00.000Z');

/**
 * A lead the current configuration clears: named person, deliverable personal
 * address, a phone, a decision-maker title, a company, and recently updated.
 */
const strongLead = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: 'person-1',
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  name: { firstName: 'Jane', lastName: 'Roe' },
  emails: { primaryEmail: 'jane.roe@acme.com', additionalEmails: [] },
  phones: {
    primaryPhoneNumber: '5550100',
    primaryPhoneCallingCode: '+44',
    primaryPhoneCountryCode: 'GB',
    additionalPhones: [],
  },
  jobTitle: 'Chief Executive Officer',
  companyId: 'company-1',
  company: { id: 'company-1', name: 'Acme Manufacturing' },
  greenlightSuppressed: false,
  ...overrides,
});

/**
 * The same lead, plus the three fields the ICP rules read. They sit on the
 * Person record because that is where the engine's default field mapping looks
 * first — see `DEFAULT_FIELD_MAPPING`.
 */
const inProfileLead = (): Record<string, unknown> =>
  strongLead({
    id: 'person-2',
    industry: 'Manufacturing',
    country: 'Germany',
    employees: 120,
  });

const CONFIG = { id: 'config-1', gateThreshold: 70 };

const SELECTION: IcpSelection = {
  industries: ['Manufacturing'],
  regions: ['Germany'],
  sizeBands: [
    { label: '51–200 employees', minEmployees: 51, maxEmployees: 200 },
  ],
};

describe('previewIcpImpact', () => {
  it('reports an empty profile as nothing to preview', () => {
    const impact = previewIcpImpact({
      leads: [strongLead()],
      configRecord: CONFIG,
      selection: { industries: [], regions: [], sizeBands: [] },
      now: NOW,
      totalLeads: 1,
    });

    expect(impact.empty).toBe(true);
    expect(impact.newlyGated).toBe(0);
    expect(impact.readability.every((one) => !one.active)).toBe(true);
  });

  it('separates the lead that matches the profile from the one with no data', () => {
    const impact = previewIcpImpact({
      leads: [strongLead(), inProfileLead()],
      configRecord: CONFIG,
      selection: SELECTION,
      now: NOW,
      totalLeads: 2,
    });

    expect(impact.sampled).toBe(2);
    expect(impact.approvedBefore).toBe(2);
    // The lead with no industry, country or headcount now fails three rules it
    // was previously exempt from, and drops through the threshold.
    expect(impact.newlyGated).toBe(1);
    expect(impact.newlyApproved).toBe(0);
    expect(impact.unchanged).toBe(1);
    expect(impact.approvedAfter).toBe(1);
  });

  it('counts every lead exactly once across the transitions', () => {
    const impact = previewIcpImpact({
      leads: [strongLead(), inProfileLead(), strongLead({ id: 'person-3' })],
      configRecord: CONFIG,
      selection: SELECTION,
      now: NOW,
      totalLeads: 3,
    });

    expect(impact.newlyGated + impact.newlyApproved + impact.unchanged).toBe(
      impact.sampled,
    );
  });

  it('shows the average score falling, because the denominator grew', () => {
    const impact = previewIcpImpact({
      leads: [strongLead()],
      configRecord: CONFIG,
      selection: SELECTION,
      now: NOW,
      totalLeads: 1,
    });

    expect(impact.averageScoreBefore).not.toBeNull();
    expect(impact.averageScoreAfter).not.toBeNull();
    expect(impact.averageScoreAfter ?? 0).toBeLessThan(
      impact.averageScoreBefore ?? 0,
    );
  });

  it('reports which dimension could not be read at all, and where it looked', () => {
    const impact = previewIcpImpact({
      leads: [strongLead(), strongLead({ id: 'person-3' })],
      configRecord: CONFIG,
      selection: SELECTION,
      now: NOW,
      totalLeads: 2,
    });

    const industry = impact.readability.find(
      (one) => one.ruleId === 'icp.industry',
    );

    expect(industry).toMatchObject({
      active: true,
      readable: 0,
      unreadable: 2,
      matched: 0,
    });
    expect(industry?.candidates).toContain('industry');
  });

  it('reports the path that answered when a value is readable', () => {
    const impact = previewIcpImpact({
      leads: [inProfileLead()],
      configRecord: CONFIG,
      selection: SELECTION,
      now: NOW,
      totalLeads: 1,
    });

    const industry = impact.readability.find(
      (one) => one.ruleId === 'icp.industry',
    );

    expect(industry).toMatchObject({ readable: 1, matched: 1, unreadable: 0 });
    expect(industry?.resolvedPaths).toEqual(['industry']);
  });

  it('separates a lead that carries the wrong industry from one that carries none', () => {
    const impact = previewIcpImpact({
      leads: [
        strongLead({ id: 'person-4', industry: 'Hospitality' }),
        strongLead({ id: 'person-5' }),
      ],
      configRecord: CONFIG,
      selection: { industries: ['Manufacturing'], regions: [], sizeBands: [] },
      now: NOW,
      totalLeads: 2,
    });

    const industry = impact.readability.find(
      (one) => one.ruleId === 'icp.industry',
    );

    expect(industry).toMatchObject({
      readable: 1,
      mismatched: 1,
      unreadable: 1,
      matched: 0,
    });
  });

  it('names the leads that would start being held, with their scores', () => {
    const impact = previewIcpImpact({
      leads: [strongLead()],
      configRecord: CONFIG,
      selection: SELECTION,
      now: NOW,
      totalLeads: 1,
    });

    expect(impact.examples).toHaveLength(1);
    expect(impact.examples[0]).toMatchObject({
      leadId: 'person-1',
      display: 'Jane Roe',
    });
    expect(impact.examples[0]?.reason.length).toBeGreaterThan(0);
  });

  it('scales the sample to the workspace, and says nothing when it cannot', () => {
    const scaled = previewIcpImpact({
      leads: [strongLead(), inProfileLead()],
      configRecord: CONFIG,
      selection: SELECTION,
      now: NOW,
      totalLeads: 1200,
    });

    expect(scaled.estimatedNewlyGated).toBe(600);

    const uncountable = previewIcpImpact({
      leads: [strongLead()],
      configRecord: CONFIG,
      selection: SELECTION,
      now: NOW,
      totalLeads: null,
    });

    expect(uncountable.estimatedNewlyGated).toBeNull();
  });

  it('survives a sample of nonsense without throwing', () => {
    const impact = previewIcpImpact({
      leads: [null, 'nonsense', 42, {}],
      configRecord: CONFIG,
      selection: SELECTION,
      now: NOW,
      totalLeads: 4,
    });

    expect(impact.sampled).toBe(4);
    expect(impact.newlyGated + impact.newlyApproved + impact.unchanged).toBe(4);
  });

  it('does not change a lead that is blocked on compliance either way', () => {
    const impact = previewIcpImpact({
      leads: [strongLead({ id: 'person-6', greenlightSuppressed: true })],
      configRecord: CONFIG,
      selection: SELECTION,
      now: NOW,
      totalLeads: 1,
    });

    expect(impact.blocked).toBe(1);
    expect(impact.newlyGated).toBe(0);
    expect(impact.unchanged).toBe(1);
  });
});
