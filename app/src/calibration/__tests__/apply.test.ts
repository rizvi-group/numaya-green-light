/**
 * The narrowing step between a verified payload and the scoring engine.
 *
 * Three separate promises are asserted here, and each one is the reason a
 * different part of `apply.ts` exists: an empty list must never become a
 * baseline, industry expansion must only ever add, and an unedited seeded list
 * must be recognised as the seed it is.
 */

import {
  expandIndustries,
  isUntouchedShippedList,
  toScoringBaseline,
} from 'src/calibration/apply';
import { type Calibration } from 'src/calibration/types';
import { DEFAULT_DECISION_MAKER_TITLES } from 'src/scoring/defaults';
import { describe, expect, it } from 'vitest';

const calibration = (overrides: Partial<Calibration> = {}): Calibration => ({
  schemaVersion: 1,
  calibrationVersion: 3,
  issuedAt: '2026-08-01T00:00:00.000Z',
  notes: null,
  decisionMakerTitles: [],
  influencerTitles: [],
  roleInboxLocalParts: [],
  placeholderValues: [],
  industrySynonyms: {},
  ...overrides,
});

/* -------------------------------------------------------------------------- */
/* toScoringBaseline                                                           */
/* -------------------------------------------------------------------------- */

describe('toScoringBaseline', () => {
  it('omits every empty list rather than carrying it', () => {
    // An empty list arriving as a baseline would replace twenty-five shipped
    // titles with none, i.e. would silently disable the heaviest rule in the
    // product. The key has to be *absent*, not empty.
    const baseline = toScoringBaseline(calibration());

    expect(Object.keys(baseline)).toHaveLength(0);
    expect('decisionMakerTitles' in baseline).toBe(false);
    expect('influencerTitles' in baseline).toBe(false);
    expect('roleInboxLocalParts' in baseline).toBe(false);
    expect('placeholderValues' in baseline).toBe(false);
    expect('industrySynonyms' in baseline).toBe(false);
  });

  it('omits an empty synonym table', () => {
    const baseline = toScoringBaseline(
      calibration({ decisionMakerTitles: ['ceo'], industrySynonyms: {} }),
    );

    expect('industrySynonyms' in baseline).toBe(false);
    expect(baseline.decisionMakerTitles).toEqual(['ceo']);
  });

  it('carries every non-empty list through unchanged', () => {
    const baseline = toScoringBaseline(
      calibration({
        decisionMakerTitles: ['geschäftsführer'],
        influencerTitles: ['projektleiter'],
        roleInboxLocalParts: ['kontakt'],
        placeholderValues: ['k.a.'],
        industrySynonyms: { construction: ['bau'] },
      }),
    );

    expect(baseline).toEqual({
      decisionMakerTitles: ['geschäftsführer'],
      influencerTitles: ['projektleiter'],
      roleInboxLocalParts: ['kontakt'],
      placeholderValues: ['k.a.'],
      industrySynonyms: { construction: ['bau'] },
    });
  });

  it('carries no threshold, weight, band or rule id', () => {
    const baseline = toScoringBaseline(
      calibration({ decisionMakerTitles: ['ceo'] }),
    );

    for (const key of ['gateThreshold', 'bands', 'rules', 'weights']) {
      expect(key in baseline).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* expandIndustries                                                            */
/* -------------------------------------------------------------------------- */

describe('expandIndustries', () => {
  const taxonomy = {
    construction: ['bau', 'bauwesen', 'bâtiment'],
    software: ['saas', 'software as a service'],
  };

  it('returns an empty list unchanged', () => {
    // Empty means "no opinion" and the industry rule reports not_applicable.
    // Expanding nothing into everything would turn a permissive install into one
    // that silently started filtering.
    expect(expandIndustries([], taxonomy)).toEqual([]);
  });

  it('leaves an unknown term in place', () => {
    expect(expandIndustries(['Aquaculture'], taxonomy)).toEqual(['aquaculture']);
  });

  it('pulls in the variants of a canonical', () => {
    const expanded = expandIndustries(['Construction'], taxonomy);

    expect(expanded).toContain('construction');
    expect(expanded).toContain('bau');
    expect(expanded).toContain('bauwesen');
    expect(expanded).toContain('bâtiment');
  });

  it('matches bidirectionally: a variant pulls in the canonical and its siblings', () => {
    // An admin has no way to know which term the pack treats as canonical and
    // should not have to.
    const expanded = expandIndustries(['Bauwesen'], taxonomy);

    expect(expanded).toContain('bauwesen');
    expect(expanded).toContain('construction');
    expect(expanded).toContain('bau');
    expect(expanded).toContain('bâtiment');
  });

  it('never removes a term the workspace typed', () => {
    const expanded = expandIndustries(
      ['Construction', 'Aquaculture', 'Widgets'],
      taxonomy,
    );

    for (const term of ['construction', 'aquaculture', 'widgets']) {
      expect(expanded).toContain(term);
    }
  });

  it('keeps the workspace’s own terms at the head of the list', () => {
    expect(expandIndustries(['Widgets', 'Construction'], taxonomy).slice(0, 2)).toEqual(
      ['widgets', 'construction'],
    );
  });

  it('does not expand a term through a second cluster', () => {
    // Not transitive: a variant pulls in its canonical's cluster and stops.
    // Without that stop, one badly authored cluster leaks across the taxonomy.
    const chained = { a: ['b'], b: ['c'] };

    expect(expandIndustries(['a'], chained)).toEqual(['a', 'b']);
  });

  it('returns the list untouched when the taxonomy is empty', () => {
    expect(expandIndustries(['Construction'], {})).toEqual(['Construction']);
  });

  it('de-duplicates rather than repeating a term reached twice', () => {
    const expanded = expandIndustries(['Construction', 'bau'], taxonomy);

    expect(new Set(expanded).size).toBe(expanded.length);
  });
});

/* -------------------------------------------------------------------------- */
/* isUntouchedShippedList                                                      */
/* -------------------------------------------------------------------------- */

describe('isUntouchedShippedList', () => {
  const shipped = DEFAULT_DECISION_MAKER_TITLES;

  it('recognises the same set in a different order', () => {
    // Reordering is what a JSON editor does for free; it is not an opinion about
    // which titles count.
    expect(isUntouchedShippedList([...shipped].reverse(), shipped)).toBe(true);
  });

  it('recognises the same set in a different case', () => {
    expect(
      isUntouchedShippedList(
        shipped.map((title) => title.toUpperCase()),
        shipped,
      ),
    ).toBe(true);
  });

  it('recognises the same set with surrounding whitespace', () => {
    expect(
      isUntouchedShippedList(
        shipped.map((title) => `  ${title} `),
        shipped,
      ),
    ).toBe(true);
  });

  it('rejects a list with one entry added', () => {
    expect(isUntouchedShippedList([...shipped, 'geschäftsführer'], shipped)).toBe(
      false,
    );
  });

  it('rejects a list with one entry removed', () => {
    expect(isUntouchedShippedList(shipped.slice(1), shipped)).toBe(false);
  });

  it('rejects a list with one entry swapped for another', () => {
    expect(
      isUntouchedShippedList([...shipped.slice(1), 'sócio'], shipped),
    ).toBe(false);
  });

  it('treats a duplicated entry as no edit at all', () => {
    // Set equality, not sequence equality — a duplicate carries no information
    // about which titles the admin considers decision-makers.
    expect(isUntouchedShippedList([...shipped, shipped[0] ?? ''], shipped)).toBe(
      true,
    );
  });
});
