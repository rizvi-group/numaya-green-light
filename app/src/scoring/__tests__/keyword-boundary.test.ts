import { describe, expect, it } from 'vitest';

import { containsKeyword, firstKeywordMatch } from 'src/scoring/rules/helpers';

/**
 * Regression tests for the keyword tokeniser's word boundary.
 *
 * ## Why this file exists
 *
 * `containsKeyword` used to bound its match with `[^a-z0-9]`. Any character
 * outside ASCII alphanumerics therefore counted as a *word separator*, which
 * meant every accented word silently split into fragments that could match a
 * keyword on their own.
 *
 * It was found live rather than by reasoning, on the first run with the
 * multilingual calibration pack loaded: a lead titled "Sócio Proprietário"
 * matched the decision-maker keyword `cio`, because the "ó" in front of it read
 * as a boundary. That particular verdict was still correct — a sócio *is* a
 * decision-maker — which is exactly what makes the bug dangerous: it was
 * invisible in the case that motivated looking at it.
 *
 * The case that is not invisible is `negócio`. "Gerente de Negócio" is a
 * mid-level manager, "negócio" ends in "cio", and the character before it is an
 * accent, so the old boundary promoted them to C-level and handed them the
 * twenty points that `contact.decision-maker` carries. That is the single
 * largest scoring error the rule set can make.
 *
 * The fix is `\p{L}\p{N}` with the `u` flag. For pure-ASCII input the two forms
 * are identical, which is why the entire pre-existing suite passed unchanged —
 * so the value of this file is precisely the non-ASCII half nothing else covers.
 */

describe('keyword boundaries are Unicode-aware', () => {
  it('does not match a keyword hidden behind an accent', () => {
    // The live failure. "ó" is a letter, not a separator.
    expect(containsKeyword('Sócio Proprietário', 'cio')).toBe(false);

    // The expensive form of the same bug: a manager promoted to C-level.
    expect(containsKeyword('Gerente de Negócio', 'cio')).toBe(false);
    expect(containsKeyword('Diretor de Negócio', 'cio')).toBe(false);
  });

  it('still matches an accented keyword against an accented title', () => {
    expect(containsKeyword('Sócio Proprietário', 'sócio')).toBe(true);
    expect(containsKeyword('Geschäftsführer', 'geschäftsführer')).toBe(true);
    expect(containsKeyword('Directeur Général', 'directeur général')).toBe(true);
    expect(containsKeyword('Amministratore Delegato', 'amministratore delegato')).toBe(
      true,
    );
    expect(containsKeyword('Właściciel', 'właściciel')).toBe(true);
  });

  it('leaves every ASCII case exactly as it was', () => {
    // The whole shipped English vocabulary lives here, so any change in this
    // block would be a change to how existing workspaces score.
    expect(containsKeyword('CIO', 'cio')).toBe(true);
    expect(containsKeyword('Group CIO, EMEA', 'cio')).toBe(true);
    expect(containsKeyword('Chief Information Officer', 'cio')).toBe(false);
    expect(containsKeyword('leadership', 'lead')).toBe(false);
    expect(containsKeyword('team lead', 'lead')).toBe(true);
    expect(containsKeyword('vps', 'vp')).toBe(false);
    expect(containsKeyword('VP Sales', 'vp')).toBe(true);
    expect(containsKeyword('Head of Revenue Operations', 'head of')).toBe(true);
  });

  it('treats punctuation and whitespace as boundaries, as before', () => {
    expect(containsKeyword('CEO/Founder', 'ceo')).toBe(true);
    expect(containsKeyword('Co-Founder', 'founder')).toBe(true);
    expect(containsKeyword('(Interim) CFO', 'cfo')).toBe(true);
  });

  it('firstKeywordMatch returns the entry that actually fired', () => {
    // The matched keyword is written into the trace and read by a human, so a
    // match reported against the wrong entry is a support ticket even when the
    // verdict is right.
    expect(
      firstKeywordMatch('Sócio Proprietário', ['cio', 'ceo', 'sócio', 'owner']),
    ).toBe('sócio');
  });
});
