/**
 * Fail-open is the product's core promise: scoring always produces a result,
 * a lead is never lost and never silently dropped. These tests encode that.
 */

import { scoreLead } from 'src/scoring/engine';
import { ALL_RULES } from 'src/scoring/rules';
import { describe, expect, it } from 'vitest';
import type { LeadRecord, ScoringRule } from 'src/scoring/types';
import {
  makeLead,
  NOW,
  perfectLeadFields,
  stubRule,
  throwingRule,
} from 'src/scoring/__tests__/test-helpers';

const pass = { outcome: 'pass', explanation: 'Passed.' } as const;
const fail = { outcome: 'fail', explanation: 'Failed.' } as const;

const codes = (result: { degradations: readonly { code: string }[] }): string[] =>
  result.degradations.map((degradation) => degradation.code);

describe('missing configuration falls back to seeded defaults', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
  ])('scores with defaults when config is %s', (_label, config) => {
    const result = scoreLead({ lead: makeLead(perfectLeadFields), now: NOW, config });

    expect(result.configSource).toBe('defaults');
    expect(codes(result)).toContain('config_missing');
    expect(result.score).toBe(100);
    expect(result.decision).toBe('approved');
  });

  it.each([
    ['a string', 'not-a-config'],
    ['a number', 42],
    ['an array', [1, 2, 3]],
    ['a boolean', true],
  ])('scores with defaults when config is %s', (_label, config) => {
    const result = scoreLead({ lead: makeLead(perfectLeadFields), now: NOW, config });

    expect(result.configSource).toBe('defaults');
    expect(codes(result)).toContain('config_malformed');
    expect(result.score).toBe(100);
  });

  it('explains the fall-back in language an admin can act on', () => {
    const result = scoreLead({ lead: makeLead({}), now: NOW });

    expect(result.degradations[0]?.message).toContain('built-in defaults');
  });
});

describe('malformed weights fall back to neutral weights', () => {
  it.each([
    ['a string', 'heavy'],
    ['a negative number', -10],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an object', { value: 10 }],
  ])('keeps the rule default when the weight is %s', (_label, weight) => {
    const result = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: { rules: { a: { weight }, b: { weight: 50 } } },
      rules: [stubRule('a', 50, pass), stubRule('b', 50, fail)],
    });

    expect(codes(result)).toContain('weight_malformed');
    expect(result.configSource).toBe('repaired');
    expect(result.totalWeight).toBe(100);
    expect(result.score).toBe(50);
  });

  it('gives every rule an equal voice when no enabled rule carries weight', () => {
    const result = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: { rules: { a: { weight: 0 }, b: { weight: 0 } } },
      rules: [stubRule('a', 0, pass), stubRule('b', 0, fail)],
    });

    expect(codes(result)).toContain('weight_malformed');
    expect(result.totalWeight).toBe(2);
    expect(result.score).toBe(50);
    expect(result.decision).toBe('approved');
  });

  it('repairs an unusable severity and an unusable on/off switch', () => {
    const result = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: { rules: { a: { severity: 'catastrophic', enabled: 'yes' } } },
      rules: [stubRule('a', 10, pass)],
    });

    expect(codes(result)).toEqual(
      expect.arrayContaining(['severity_malformed', 'rule_setting_malformed']),
    );
    expect(result.trace[0]?.severity).toBe('major');
    expect(result.trace[0]?.outcome).toBe('pass');
  });
});

describe('a rule that throws is contained', () => {
  it('records the failure in the trace and keeps scoring', () => {
    const result = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: {},
      rules: [stubRule('good', 50, pass), throwingRule('broken', 50)],
    });

    const broken = result.trace.find((entry) => entry.ruleId === 'broken');

    expect(broken?.outcome).toBe('errored');
    expect(broken?.error).toBe('rule exploded');
    expect(broken?.contributed).toBe(false);
    expect(codes(result)).toContain('rule_errored');
  });

  it('never lets a broken rule drag the score down', () => {
    const withBrokenRule = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: {},
      rules: [stubRule('good', 50, pass), throwingRule('broken', 50)],
    });

    const withoutBrokenRule = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: {},
      rules: [stubRule('good', 50, pass)],
    });

    expect(withBrokenRule.score).toBe(withoutBrokenRule.score);
    expect(withBrokenRule.score).toBe(100);
    expect(withBrokenRule.decision).toBe('approved');
  });

  it('never blocks a lead because the blocking rule itself broke', () => {
    const result = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: { rules: { broken: { severity: 'blocking' } } },
      rules: [stubRule('good', 50, pass), throwingRule('broken', 50)],
    });

    expect(result.decision).not.toBe('blocked');
    expect(result.decision).toBe('approved');
  });

  it('tells the reader it was the app that failed, not the lead', () => {
    const result = scoreLead({
      lead: makeLead({}),
      now: NOW,
      config: {},
      rules: [throwingRule('broken', 50)],
    });

    const broken = result.trace[0];

    expect(broken?.explanation).toContain('could not run');
    expect(broken?.remedy).toContain('fault in the app');
  });
});

describe('nothing scorable still produces a result', () => {
  it('passes the lead through unscored when every rule throws', () => {
    const result = scoreLead({
      lead: makeLead(perfectLeadFields),
      now: NOW,
      config: {},
      rules: [throwingRule('a', 10), throwingRule('b', 10)],
    });

    expect(result.score).toBeNull();
    expect(result.band).toBeNull();
    expect(result.decision).toBe('unscored');
    expect(codes(result)).toContain('no_scorable_rules');
    expect(result.summary).toContain('let through');
  });

  it('passes the lead through unscored when every rule is switched off', () => {
    const result = scoreLead({
      lead: makeLead(perfectLeadFields),
      now: NOW,
      config: {
        rules: Object.fromEntries(
          ALL_RULES.map((rule) => [rule.id, { enabled: false }]),
        ),
      },
    });

    expect(result.decision).toBe('unscored');
    expect(result.trace).toHaveLength(ALL_RULES.length);
    expect(result.trace.every((entry) => entry.outcome === 'skipped')).toBe(true);
  });
});

describe('a malformed lead is scored rather than rejected', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'lead-42'],
    ['an object with no fields', { id: 'x' }],
  ])('still returns a result when the lead is %s', (_label, lead) => {
    const result = scoreLead({
      lead: lead as unknown as LeadRecord,
      now: NOW,
      config: {},
    });

    expect(codes(result)).toContain('lead_malformed');
    expect(result.decision).toBeDefined();
    expect(result.trace.length).toBeGreaterThan(0);
  });
});

describe('an unusable clock does not stop the run', () => {
  it('skips time-based rules and records why', () => {
    const result = scoreLead({
      lead: makeLead(perfectLeadFields),
      now: new Date('not a date'),
      config: {},
    });

    expect(codes(result)).toContain('now_malformed');
    expect(result.scoredAt).toBeNull();
    expect(
      result.trace.find((entry) => entry.ruleId === 'data.freshness')?.outcome,
    ).toBe('not_applicable');
    expect(result.score).toBe(100);
  });

  it.each([
    ['undefined', undefined],
    ['a string', '2026-08-02'],
    ['a number', 1_754_136_000_000],
  ])('tolerates a %s clock', (_label, now) => {
    const result = scoreLead({
      lead: makeLead(perfectLeadFields),
      now: now as unknown as Date,
      config: {},
    });

    expect(codes(result)).toContain('now_malformed');
    expect(result.score).not.toBeUndefined();
  });
});

describe('the engine boundary itself fails open', () => {
  it('returns an unscored result when the engine cannot run at all', () => {
    const hostileRules = {
      map: () => {
        throw new Error('catalogue exploded');
      },
    } as unknown as readonly ScoringRule[];

    const result = scoreLead({
      lead: makeLead(perfectLeadFields),
      now: NOW,
      rules: hostileRules,
    });

    expect(result.decision).toBe('unscored');
    expect(codes(result)).toContain('engine_errored');
    expect(result.degradations[0]?.detail).toContain('catalogue exploded');
    expect(result.leadId).toBe('lead-1');
    expect(result.scoredAt).toBe(NOW.toISOString());
  });

  it('never throws, whatever it is handed', () => {
    const junk: unknown[] = [
      undefined,
      null,
      0,
      '',
      'nonsense',
      [],
      {},
      { rules: 'not-rules' },
      { icp: 'nope' },
      { bands: 'nope' },
      { gateThreshold: 'high' },
      { fieldMapping: 7 },
      { defaultShelfLifeDays: -1 },
      { fieldShelfLifeDays: 'soon' },
      { decisionMakerTitles: 5 },
      Number.NaN,
      () => undefined,
    ];

    for (const config of junk) {
      for (const lead of junk) {
        expect(() =>
          scoreLead({ lead: lead as unknown as LeadRecord, now: NOW, config }),
        ).not.toThrow();
      }
    }
  });

  it('always returns a decision, a summary and a trace', () => {
    const result = scoreLead({
      lead: 'garbage' as unknown as LeadRecord,
      now: new Date('nope'),
      config: 'garbage',
    });

    expect(['approved', 'gated', 'blocked', 'unscored']).toContain(result.decision);
    expect(result.summary.length).toBeGreaterThan(10);
    expect(Array.isArray(result.trace)).toBe(true);
  });
});
