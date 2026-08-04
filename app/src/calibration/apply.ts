/**
 * Turning a verified calibration into the *baseline* the scoring engine
 * resolves configuration against.
 *
 * ===========================================================================
 * ## Calibration is a baseline, never an override
 *
 * The precedence is, top wins:
 *
 *   1. the workspace's own explicit configuration  (`GreenlightConfig` record)
 *   2. licence-delivered calibration               (this module)
 *   3. the in-source shipped defaults              (`src/scoring/defaults.ts`)
 *
 * Layer 1 is the customer's data and calibration must not touch it. Layer 3 is
 * what an unlicensed install uses and must keep using. Calibration slots between
 * them: it replaces the *fall-back*, so a workspace that never expressed an
 * opinion about decision-maker titles gets 180 of them instead of 25, and a
 * workspace that curated its own list keeps exactly the list it curated.
 *
 * This is why nothing here is called from a rule. Rules stay pure and stay
 * ignorant: they read `config.decisionMakerTitles` exactly as they did before
 * this feature existed, and calibration arrives as data through the one config
 * resolution path that already existed. `src/scoring/` gains no import from
 * `src/calibration/` — the dependency runs the other way.
 *
 * ## The seeded-defaults problem, and why it needed solving
 *
 * `buildGreenlightConfigSeed()` writes the shipped title list *into the config
 * record* at install, so that an admin can see and edit it. That is good product
 * design and it quietly breaks the precedence above: after a fresh install every
 * workspace has an "explicit" decision-maker list, which is really just a copy of
 * the shipped defaults, and layer 1 would therefore shadow calibration forever.
 * Calibration would arrive, verify, publish — and change nothing.
 *
 * `isUntouchedShippedList` closes that. A stored list whose *set* of entries is
 * exactly the shipped set is a seed nobody has edited, not a choice, and
 * calibration is allowed past it. Add one title, remove one title, and it becomes
 * a real curation that calibration will not touch. Set comparison rather than
 * sequence comparison because a workspace that reordered the seeded list without
 * changing its contents has still not expressed an opinion about *which* titles
 * count, and reordering is exactly what a JSON editor does for free.
 *
 * The check is deliberately conservative in the direction that matters: a false
 * "untouched" costs the admin a list they did not ask to be replaced, so the
 * comparison is exact set equality and nothing looser — no subset test, no
 * fuzzy match, no size heuristic.
 * ===========================================================================
 */

import {
  expandIndustriesWithSynonyms,
  isSameStringSet,
} from 'src/scoring/config';
import { type Calibration } from 'src/calibration/types';

/**
 * The slice of a calibration that the config resolver consumes.
 *
 * A separate, narrower type from `Calibration` so `src/scoring/config.ts` can
 * depend on the *shape* of a baseline without depending on the calibration
 * module, its envelope, its cache or its verification. The scoring engine
 * should not be able to tell where its baseline came from.
 */
export interface ScoringBaseline {
  readonly decisionMakerTitles: readonly string[];
  readonly influencerTitles: readonly string[];
  readonly roleInboxLocalParts: readonly string[];
  readonly placeholderValues: readonly string[];
  /** Canonical industry term → equivalent free-text variants. */
  readonly industrySynonyms: Readonly<Record<string, readonly string[]>>;
}

/**
 * Narrow a verified calibration to the baseline.
 *
 * Empty lists are dropped, not carried: an empty list in the payload means "this
 * pack has no opinion here", and letting it through as a baseline would replace
 * twenty-five shipped titles with none — i.e. would silently disable the
 * highest-weighted rule in the product. Absent and empty must both mean "leave
 * the shipped default alone", and this is the single place that is enforced.
 */
export const toScoringBaseline = (
  calibration: Calibration,
): Partial<ScoringBaseline> => {
  const baseline: {
    -readonly [K in keyof ScoringBaseline]?: ScoringBaseline[K];
  } = {};

  if (calibration.decisionMakerTitles.length > 0) {
    baseline.decisionMakerTitles = calibration.decisionMakerTitles;
  }

  if (calibration.influencerTitles.length > 0) {
    baseline.influencerTitles = calibration.influencerTitles;
  }

  if (calibration.roleInboxLocalParts.length > 0) {
    baseline.roleInboxLocalParts = calibration.roleInboxLocalParts;
  }

  if (calibration.placeholderValues.length > 0) {
    baseline.placeholderValues = calibration.placeholderValues;
  }

  if (Object.keys(calibration.industrySynonyms).length > 0) {
    baseline.industrySynonyms = calibration.industrySynonyms;
  }

  return baseline;
};

/**
 * True when a stored list is an unedited copy of what the installer seeded.
 *
 * See "The seeded-defaults problem" above. The comparison itself lives in
 * `src/scoring/config.ts` because that is where the decision is *taken* — this
 * is the name the calibration side reads it under, so a reader here does not
 * have to guess which of two set comparisons governs their config.
 *
 * Both sides are normalised, because the seed round-trips through a `RAW_JSON`
 * column and the engine lower-cases every list it resolves; a case difference
 * across that boundary is storage noise, not an edit.
 */
export const isUntouchedShippedList = isSameStringSet;

/* -------------------------------------------------------------------------- */
/* Industry expansion                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Expanding a workspace's ICP industry list through the synonym taxonomy is
 * what turns the twenty-point industry rule from decorative into useful.
 *
 * `icp-industry.rule.ts` does exact normalised set membership against
 * `config.icp.industries` — correct, cheap, and completely defeated by real CRM
 * data, where one industry arrives as "SaaS", "Software as a Service", "B2B
 * Software", "Logiciel" and "Cloud Software" on five records imported from four
 * tools.
 *
 * Rather than teach the rule about synonyms — a logic change, and a taxonomy
 * lookup inside a pure comparison — the expansion happens once, at config
 * resolution, in `expandIndustriesWithSynonyms` in `src/scoring/config.ts`. The
 * rule is untouched and simply finds a longer list of acceptable strings. That
 * is the entire mechanism, and it is why this feature required no edit to any
 * rule.
 *
 * The properties that make it safe, asserted in `__tests__/apply.test.ts`:
 *
 * - It never expands an **empty** list. Empty means "no opinion" and the rule
 *   reports `not_applicable`; expanding nothing into everything would turn a
 *   permissive install into one that silently started filtering.
 * - It never **removes** a term. The workspace's own entries always survive, at
 *   the head of the list, whether or not the taxonomy recognises them.
 * - It matches **bidirectionally**: an admin may type the canonical term or any
 *   variant, because they have no way to know which the pack treats as
 *   canonical and should not have to.
 * - It is **not transitive**. A variant pulls in its canonical's cluster and
 *   stops; there is no closure step, so one bad cluster cannot leak across the
 *   taxonomy.
 */
export const expandIndustries = (
  industries: readonly string[],
  synonyms: Readonly<Record<string, readonly string[]>>,
): readonly string[] => expandIndustriesWithSynonyms(industries, synonyms);
