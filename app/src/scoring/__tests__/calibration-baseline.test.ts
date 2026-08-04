/**
 * The fail-open promise, proved rather than promised.
 *
 * Calibration's whole claim is that an unlicensed, offline, stale or
 * signature-failing install scores a lead byte-for-byte the way it did before
 * this feature existed, and that a calibrated one can only ever change *which
 * strings a rule matches*. Both halves are asserted here: the identity first,
 * then the exact and only three ways a baseline is allowed to show up.
 *
 * There is no import of `src/calibration/` in this file. The engine must not be
 * able to tell where a baseline came from, so the tests do not tell it either.
 */

import { resolveConfig } from 'src/scoring/config';
import {
  DEFAULT_BANDS,
  DEFAULT_DECISION_MAKER_TITLES,
  DEFAULT_GATE_THRESHOLD,
} from 'src/scoring/defaults';
import { scoreLead } from 'src/scoring/engine';
import { ALL_RULES } from 'src/scoring/rules';
import {
  type RuleTraceEntry,
  type ScoringResult,
  type ScoringVocabularyBaseline,
} from 'src/scoring/types';
import { makeLead, NOW, perfectLeadFields } from 'src/scoring/__tests__/test-helpers';
import { describe, expect, it } from 'vitest';

/** A workspace that has configured an ICP and a threshold and nothing else. */
const CONFIG_RECORD = {
  icp: {
    industries: ['Manufacturing'],
    regions: ['United Kingdom'],
    sizeBands: [{ label: 'Mid', minEmployees: 50, maxEmployees: 500 }],
  },
  gateThreshold: 60,
};

const REPRESENTATIVE_LEAD = makeLead({ ...perfectLeadFields });

const entryFor = (result: ScoringResult, ruleId: string): RuleTraceEntry => {
  const entry = result.trace.find((candidate) => candidate.ruleId === ruleId);

  if (entry === undefined) {
    throw new Error(`no trace entry for ${ruleId}`);
  }

  return entry;
};

const sameSet = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === new Set([...left, ...right].map((entry) => entry.toLowerCase())).size &&
  right.length === left.length;

/* -------------------------------------------------------------------------- */
/* The identity: no baseline changes nothing                                   */
/* -------------------------------------------------------------------------- */

describe('an absent baseline', () => {
  it('scores a lead identically to a build that never had the parameter', () => {
    const withoutParameter = scoreLead({
      lead: REPRESENTATIVE_LEAD,
      config: CONFIG_RECORD,
      now: NOW,
    });
    const withNull = scoreLead({
      lead: REPRESENTATIVE_LEAD,
      config: CONFIG_RECORD,
      now: NOW,
      baseline: null,
    });
    const withUndefined = scoreLead({
      lead: REPRESENTATIVE_LEAD,
      config: CONFIG_RECORD,
      now: NOW,
      baseline: undefined,
    });

    for (const result of [withNull, withUndefined]) {
      expect(result.score).toBe(withoutParameter.score);
      expect(result.decision).toBe(withoutParameter.decision);
      expect(result.band).toEqual(withoutParameter.band);
      expect(result.trace).toEqual(withoutParameter.trace);
      expect(result).toEqual(withoutParameter);
    }
  });

  it('resolves configuration identically', () => {
    // Asserted on the resolution rather than only on the score, because the
    // score could coincide while a list quietly differed.
    const withoutParameter = resolveConfig(CONFIG_RECORD, ALL_RULES);

    expect(resolveConfig(CONFIG_RECORD, ALL_RULES, null)).toEqual(withoutParameter);
    expect(resolveConfig(CONFIG_RECORD, ALL_RULES, undefined)).toEqual(
      withoutParameter,
    );
  });

  it('resolves an absent and a malformed config record identically too', () => {
    for (const raw of [undefined, null, 'not-an-object', []]) {
      expect(resolveConfig(raw, ALL_RULES, null)).toEqual(
        resolveConfig(raw, ALL_RULES),
      );
    }
  });

  it('leaves the shipped decision-maker list in place', () => {
    expect(resolveConfig({}, ALL_RULES, null).config.decisionMakerTitles).toEqual([
      ...DEFAULT_DECISION_MAKER_TITLES,
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Precedence                                                                  */
/* -------------------------------------------------------------------------- */

describe('a baseline as the fall-back layer', () => {
  const baseline: ScoringVocabularyBaseline = {
    decisionMakerTitles: ['geschäftsführer', 'sócio', 'ceo'],
    influencerTitles: ['projektleiter'],
  };

  it('replaces the shipped list when the record says nothing about titles', () => {
    const resolution = resolveConfig({ gateThreshold: 60 }, ALL_RULES, baseline);

    expect(resolution.config.decisionMakerTitles).toEqual([
      'geschäftsführer',
      'sócio',
      'ceo',
    ]);
    expect(resolution.config.influencerTitles).toEqual(['projektleiter']);
  });

  it('leaves a list the baseline has no opinion about on the shipped default', () => {
    const resolution = resolveConfig({}, ALL_RULES, baseline);

    expect(resolution.config.roleInboxLocalParts.length).toBeGreaterThan(0);
    expect(resolution.config.placeholderValues.length).toBeGreaterThan(0);
  });

  it('does not replace a list the workspace curated', () => {
    // Layer 1 is the customer's data. Calibration slots underneath it, never
    // over it.
    const resolution = resolveConfig(
      { decisionMakerTitles: ['Head of Procurement', 'Chief Widget Officer'] },
      ALL_RULES,
      baseline,
    );

    expect(resolution.config.decisionMakerTitles).toEqual([
      'head of procurement',
      'chief widget officer',
    ]);
  });

  it('does not replace a curated list that merely overlaps the shipped one', () => {
    const curated = [...DEFAULT_DECISION_MAKER_TITLES, 'head of procurement'];
    const resolution = resolveConfig(
      { decisionMakerTitles: curated },
      ALL_RULES,
      baseline,
    );

    expect(resolution.config.decisionMakerTitles).toEqual(curated.map((t) => t.toLowerCase()));
  });
});

/* -------------------------------------------------------------------------- */
/* The seeded-defaults exception                                               */
/* -------------------------------------------------------------------------- */

describe('the seeded-defaults exception', () => {
  /** What the installer wrote, after a JSON editor has been near it. */
  const seeded = [...DEFAULT_DECISION_MAKER_TITLES]
    .reverse()
    .map((title, index) => (index % 2 === 0 ? title.toUpperCase() : title));

  const baseline: ScoringVocabularyBaseline = {
    decisionMakerTitles: ['geschäftsführer', 'sócio'],
  };

  it('lets the baseline past an unedited seed, whatever its order and case', () => {
    // `buildGreenlightConfigSeed()` writes the shipped list into the config
    // record at install, so every fresh workspace has an "explicit" list that is
    // really just a copy. Treating that as a choice would let it shadow
    // calibration forever — calibration would arrive, verify, publish, and
    // change nothing.
    const resolution = resolveConfig(
      { decisionMakerTitles: seeded },
      ALL_RULES,
      baseline,
    );

    expect(resolution.config.decisionMakerTitles).toEqual([
      'geschäftsführer',
      'sócio',
    ]);
  });

  it('does not report an unedited seed as a repair', () => {
    expect(
      resolveConfig({ decisionMakerTitles: seeded }, ALL_RULES, baseline).source,
    ).toBe('provided');
  });

  it('stops letting the baseline past as soon as one title is added', () => {
    const resolution = resolveConfig(
      { decisionMakerTitles: [...seeded, 'Head of Procurement'] },
      ALL_RULES,
      baseline,
    );

    expect(resolution.config.decisionMakerTitles).toContain('head of procurement');
    expect(resolution.config.decisionMakerTitles).not.toEqual([
      'geschäftsführer',
      'sócio',
    ]);
  });

  it('stops letting the baseline past as soon as one title is removed', () => {
    const resolution = resolveConfig(
      { decisionMakerTitles: seeded.slice(1) },
      ALL_RULES,
      baseline,
    );

    expect(resolution.config.decisionMakerTitles).toHaveLength(seeded.length - 1);
  });

  it('is unreachable when there is no calibration', () => {
    // Without a baseline the seed resolves to the shipped set either way, so the
    // exception cannot change anything in an unlicensed install.
    const resolved = resolveConfig({ decisionMakerTitles: seeded }, ALL_RULES)
      .config.decisionMakerTitles;

    expect(sameSet(resolved, DEFAULT_DECISION_MAKER_TITLES)).toBe(true);
    expect(resolved).not.toContain('geschäftsführer');
  });
});

/* -------------------------------------------------------------------------- */
/* What a baseline can never touch                                             */
/* -------------------------------------------------------------------------- */

describe('the boundary a baseline cannot cross', () => {
  const hostile = {
    decisionMakerTitles: ['ceo'],
    gateThreshold: 5,
    bands: [{ id: 'everything', label: 'Everything', minScore: 0 }],
    rules: {
      'contact.decision-maker': {
        enabled: false,
        weight: 9_999,
        severity: 'blocking',
      },
    },
    defaultShelfLifeDays: 1,
    icp: { industries: ['anything at all'] },
    fieldMapping: { suppressed: ['somewhereElse'] },
  } as unknown as ScoringVocabularyBaseline;

  it('cannot move the gate threshold', () => {
    expect(
      resolveConfig(CONFIG_RECORD, ALL_RULES, hostile).config.gateThreshold,
    ).toBe(resolveConfig(CONFIG_RECORD, ALL_RULES).config.gateThreshold);

    expect(resolveConfig({}, ALL_RULES, hostile).config.gateThreshold).toBe(
      DEFAULT_GATE_THRESHOLD,
    );
  });

  it('cannot move the bands', () => {
    expect(resolveConfig({}, ALL_RULES, hostile).config.bands).toEqual(
      DEFAULT_BANDS,
    );
  });

  it('cannot change any rule’s weight, severity or enabled flag', () => {
    expect(resolveConfig(CONFIG_RECORD, ALL_RULES, hostile).config.rules).toEqual(
      resolveConfig(CONFIG_RECORD, ALL_RULES).config.rules,
    );
  });

  it('cannot change the shelf lives, the ICP or the field mapping', () => {
    const withHostile = resolveConfig(CONFIG_RECORD, ALL_RULES, hostile).config;
    const without = resolveConfig(CONFIG_RECORD, ALL_RULES).config;

    expect(withHostile.defaultShelfLifeDays).toBe(without.defaultShelfLifeDays);
    expect(withHostile.fieldShelfLifeDays).toEqual(without.fieldShelfLifeDays);
    expect(withHostile.icp).toEqual(without.icp);
    expect(withHostile.fieldMapping).toEqual(without.fieldMapping);
  });

  it('changes nothing but the vocabulary lists, end to end', () => {
    const withHostile = resolveConfig({}, ALL_RULES, hostile).config;
    const without = resolveConfig({}, ALL_RULES).config;

    expect({ ...withHostile, decisionMakerTitles: [] }).toEqual({
      ...without,
      decisionMakerTitles: [],
    });
  });
});

/* -------------------------------------------------------------------------- */
/* End to end: the score actually moves                                        */
/* -------------------------------------------------------------------------- */

describe('a German decision-maker', () => {
  const lead = makeLead({ ...perfectLeadFields, jobTitle: 'Geschäftsführer' });

  const score = (baseline?: ScoringVocabularyBaseline | null): ScoringResult =>
    scoreLead({ lead, config: { gateThreshold: 60 }, now: NOW, baseline });

  it('fails the decision-maker rule on shipped defaults', () => {
    // The twenty-five shipped English titles are exactly what a fork gets, and
    // this is the lead they mis-score.
    expect(entryFor(score(), 'contact.decision-maker').outcome).toBe('fail');
  });

  it('passes it once calibration supplies the title', () => {
    const entry = entryFor(
      score({ decisionMakerTitles: [...DEFAULT_DECISION_MAKER_TITLES, 'geschäftsführer'] }),
      'contact.decision-maker',
    );

    expect(entry.outcome).toBe('pass');
    expect(entry.pointsEarned).toBe(entry.pointsPossible);
  });

  it('scores strictly higher with the calibration than without it', () => {
    const before = score().score;
    const after = score({
      decisionMakerTitles: [...DEFAULT_DECISION_MAKER_TITLES, 'geschäftsführer'],
    }).score;

    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(after as number).toBeGreaterThan(before as number);
  });

  it('leaves every other rule’s outcome exactly where it was', () => {
    const before = score();
    const after = score({
      decisionMakerTitles: [...DEFAULT_DECISION_MAKER_TITLES, 'geschäftsführer'],
    });

    for (const entry of before.trace) {
      if (entry.ruleId === 'contact.decision-maker') {
        continue;
      }

      expect(entryFor(after, entry.ruleId).outcome, entry.ruleId).toBe(
        entry.outcome,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* End to end: ICP expansion                                                   */
/* -------------------------------------------------------------------------- */

describe('a German industry against an English ICP', () => {
  const lead = makeLead({ ...perfectLeadFields, industry: 'Bauwesen' });
  const config = { icp: { industries: ['Construction'] } };

  const score = (baseline?: ScoringVocabularyBaseline | null): ScoringResult =>
    scoreLead({ lead, config, now: NOW, baseline });

  it('fails the industry rule without a synonym taxonomy', () => {
    expect(entryFor(score(), 'icp.industry').outcome).toBe('fail');
  });

  it('passes once the taxonomy connects the two terms', () => {
    // The rule is untouched by this feature — it simply finds a longer list of
    // acceptable strings, because expansion happens at config resolution.
    const entry = entryFor(
      score({ industrySynonyms: { construction: ['bau', 'bauwesen'] } }),
      'icp.industry',
    );

    expect(entry.outcome).toBe('pass');
  });

  it('keeps the workspace’s own term in the resolved list', () => {
    const resolution = resolveConfig(config, ALL_RULES, {
      industrySynonyms: { construction: ['bau', 'bauwesen'] },
    });

    expect(resolution.config.icp.industries).toContain('construction');
    expect(resolution.config.icp.industries).toContain('bauwesen');
  });

  it('does not start filtering a workspace that listed no industries', () => {
    const resolution = resolveConfig({}, ALL_RULES, {
      industrySynonyms: { construction: ['bau', 'bauwesen'] },
    });

    expect(resolution.config.icp.industries).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Calibration is not a repair                                                 */
/* -------------------------------------------------------------------------- */

describe('configSource', () => {
  it('stays provided when a baseline is applied to a clean record', () => {
    // An admin reading the trace should not see a repair they did not cause.
    const baseline: ScoringVocabularyBaseline = {
      decisionMakerTitles: ['geschäftsführer'],
      industrySynonyms: { manufacturing: ['fertigung'] },
    };

    expect(resolveConfig(CONFIG_RECORD, ALL_RULES, baseline).source).toBe(
      'provided',
    );
    expect(
      resolveConfig(CONFIG_RECORD, ALL_RULES, baseline).degradations,
    ).toHaveLength(0);
    expect(
      scoreLead({
        lead: REPRESENTATIVE_LEAD,
        config: CONFIG_RECORD,
        now: NOW,
        baseline,
      }).configSource,
    ).toBe('provided');
  });

  it('still reports defaults when there is no config record at all', () => {
    expect(
      resolveConfig(undefined, ALL_RULES, { decisionMakerTitles: ['ceo'] }).source,
    ).toBe('defaults');
  });
});
