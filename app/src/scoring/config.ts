/**
 * Configuration resolution.
 *
 * `resolveConfig` takes whatever came out of the CRM config record — including
 * `undefined`, `null`, a string, or an object with half its fields the wrong
 * type — and always returns a usable config plus a list of the fall-backs it
 * had to make. Nothing in here throws. Missing config falls back to seeded
 * defaults; malformed weights fall back to neutral weights.
 */

import { ENRICHED_FIELD_MAPPING_PATHS } from 'src/enrichment/field-specs';
import {
  DEFAULT_BANDS,
  DEFAULT_DECISION_MAKER_TITLES,
  DEFAULT_FIELD_MAPPING,
  DEFAULT_GATE_THRESHOLD,
  DEFAULT_ICP,
  DEFAULT_INFLUENCER_TITLES,
  DEFAULT_ROLE_INBOX_LOCAL_PARTS,
  DEFAULT_SHELF_LIFE_DAYS,
  PLACEHOLDER_VALUES,
} from 'src/scoring/defaults';
import { isPlainObject } from 'src/scoring/field-access';
import { ALL_RULES } from 'src/scoring/rules';
import {
  LEAD_FIELD_KEYS,
  RULE_SEVERITIES,
  type ConfigResolution,
  type Degradation,
  type DegradationCode,
  type FieldMapping,
  type IcpConfig,
  type IcpSizeBand,
  type LeadFieldKey,
  type ResolvedScoringConfig,
  type RuleSetting,
  type RuleSeverity,
  type ScoringBand,
  type ScoringConfigInput,
  type ScoringRule,
  type ScoringVocabularyBaseline,
} from 'src/scoring/types';

/**
 * Set equality over normalised strings.
 *
 * Exported because `src/calibration/apply.ts` needs exactly this comparison and
 * the dependency may only run in that direction — calibration imports scoring,
 * never the reverse. Duplicating ten lines across that boundary would be two
 * implementations of one rule, and the rule decides whether a workspace's
 * configuration is honoured.
 */
export const isSameStringSet = (
  left: readonly string[],
  right: readonly string[],
): boolean => {
  const leftSet = new Set(left.map((entry) => entry.trim().toLowerCase().replace(/\s+/g, ' ')));
  const rightSet = new Set(right.map((entry) => entry.trim().toLowerCase().replace(/\s+/g, ' ')));

  if (leftSet.size !== rightSet.size) {
    return false;
  }

  for (const entry of rightSet) {
    if (!leftSet.has(entry)) {
      return false;
    }
  }

  return true;
};

/**
 * Expand a workspace's ICP industries through a synonym taxonomy.
 *
 * Declared here rather than imported from `src/calibration/` for the dependency
 * reason above, and applied at resolution rather than inside
 * `icp-industry.rule.ts` so the rule stays a pure set-membership test. The rule
 * is untouched by this feature; it simply finds a longer list of acceptable
 * strings. See `src/calibration/apply.ts` for the full argument.
 */
export const expandIndustriesWithSynonyms = (
  industries: readonly string[],
  synonyms: Readonly<Record<string, readonly string[]>> | undefined,
): readonly string[] => {
  if (synonyms === undefined || industries.length === 0) {
    return industries;
  }

  const clusters = Object.entries(synonyms);

  if (clusters.length === 0) {
    return industries;
  }

  const variantToCanonical = new Map<string, string>();

  for (const [canonical, variants] of clusters) {
    const canonicalKey = normaliseTerm(canonical);
    variantToCanonical.set(canonicalKey, canonicalKey);

    for (const variant of variants) {
      const variantKey = normaliseTerm(variant);

      // A variant listed under two canonicals is a defect in the pack, and the
      // resolution has to be independent of object key order or the same pack
      // would behave differently in two builds. Two rules, in this order:
      // **a canonical always wins over a variant** (the unconditional `set`
      // above), and among competing variants the **first cluster wins**. Both
      // are order-independent given a fixed pack, which is the property that
      // matters.
      if (!variantToCanonical.has(variantKey)) {
        variantToCanonical.set(variantKey, canonicalKey);
      }
    }
  }

  // The workspace's own terms first and unmodified — expansion only ever adds.
  const expanded = new Set(industries.map(normaliseTerm));

  for (const industry of industries) {
    const canonical = variantToCanonical.get(normaliseTerm(industry));

    if (canonical === undefined) {
      continue;
    }

    expanded.add(canonical);

    for (const variant of synonyms[canonical] ?? []) {
      expanded.add(normaliseTerm(variant));
    }
  }

  return [...expanded];
};

const normaliseTerm = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Append Greenlight's own enriched-value paths to the end of every enrichable
 * key's candidate list.
 *
 * ## Why this lives here and not in the config record
 *
 * `greenlightEnrichment` is a column Greenlight ships, owns and writes, so
 * "where does an enriched industry live" has exactly one answer and it is not
 * the customer's to give. There is also nowhere in `GreenlightConfig` to say it:
 * the record exposes precisely two mapping settings (`decisionMakerFieldName`,
 * `optOutFieldNames`), so seeding these five paths would mean minting columns
 * for values no admin should ever edit — and a seeded value is a value that can
 * be cleared, which would put us straight back to enrichment writing data
 * nothing reads. Doing it here also covers the workspace with *no* config record
 * at all, where `resolveConfig` short-circuits to `buildDefaultConfig` and never
 * looks at a field mapping the record could have carried.
 *
 * ## Appended, not pinned
 *
 * `PINNED_FIELD_MAPPING_KEYS` below *rejects* a workspace's mapping outright.
 * That is right for `suppressed`, whose key names a Greenlight-only column, and
 * wrong here: `industry`, `region`, `employeeCount`, `jobTitle` and `seniority`
 * are genuine Layer 3 seams and a workspace must keep saying where its own
 * columns live. The treatment is therefore the weaker half of pinning — the
 * workspace owns the head of the list, Greenlight owns the tail:
 *
 *   - **Unconditional**, so a config typo cannot silently disconnect enrichment.
 *     That is the same safety property pinning buys, without the cost.
 *   - **Always last**, so `field-access.ts` — which takes the first candidate
 *     that yields a value — reaches it only when every human-held candidate is
 *     empty. Enrichment fills a hole; it never overwrites a person.
 *
 * `DEFAULT_FIELD_MAPPING` itself is deliberately left alone: `src/enrichment/
 * plan.ts` reads it to answer "has a human already answered this field", and an
 * enriched value visible there would read as human input and never refresh.
 */
const withEnrichedFallbacks = (mapping: FieldMapping): FieldMapping => {
  const next: Record<LeadFieldKey, readonly string[]> = { ...mapping };

  for (const [key, path] of Object.entries(ENRICHED_FIELD_MAPPING_PATHS)) {
    const leadKey = key as LeadFieldKey;
    const candidates = next[leadKey] ?? [];

    next[leadKey] = candidates.includes(path)
      ? candidates
      : [...candidates, path];
  }

  return next;
};

/**
 * The complete seeded configuration. Also what the install hook should write.
 *
 * The optional `baseline` supplies licence-delivered vocabulary in place of the
 * shipped lists. It is *only* consulted for the four vocabulary lists — bands,
 * weights, thresholds, shelf lives, the ICP and the field mapping are read from
 * the shipped constants unconditionally, and there is no argument here through
 * which a baseline could reach them.
 */
export const buildDefaultConfig = (
  rules: readonly ScoringRule[] = ALL_RULES,
  baseline?: ScoringVocabularyBaseline | null,
): ResolvedScoringConfig => ({
  icp: DEFAULT_ICP,
  rules: Object.fromEntries(
    rules.map((rule) => [
      rule.id,
      {
        enabled: rule.defaultEnabled,
        severity: rule.defaultSeverity,
        weight: rule.defaultWeight,
      } satisfies RuleSetting,
    ]),
  ),
  bands: DEFAULT_BANDS,
  gateThreshold: DEFAULT_GATE_THRESHOLD,
  defaultShelfLifeDays: DEFAULT_SHELF_LIFE_DAYS,
  fieldShelfLifeDays: {},
  decisionMakerTitles:
    baseline?.decisionMakerTitles ?? DEFAULT_DECISION_MAKER_TITLES,
  influencerTitles: baseline?.influencerTitles ?? DEFAULT_INFLUENCER_TITLES,
  roleInboxLocalParts:
    baseline?.roleInboxLocalParts ?? DEFAULT_ROLE_INBOX_LOCAL_PARTS,
  placeholderValues: baseline?.placeholderValues ?? PLACEHOLDER_VALUES,
  fieldMapping: withEnrichedFallbacks(DEFAULT_FIELD_MAPPING),
});

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const toStringList = (value: unknown): string[] | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }

  if (!Array.isArray(value)) {
    return null;
  }

  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const lowerAll = (values: readonly string[]): string[] =>
  values.map((value) => value.toLowerCase());

class DegradationLog {
  private readonly entries: Degradation[] = [];

  add(code: DegradationCode, message: string, detail?: string): void {
    this.entries.push(detail === undefined ? { code, message } : { code, message, detail });
  }

  get list(): readonly Degradation[] {
    return this.entries;
  }

  get count(): number {
    return this.entries.length;
  }
}

const resolveIcp = (raw: unknown, log: DegradationLog): IcpConfig => {
  if (raw === undefined || raw === null) {
    return DEFAULT_ICP;
  }

  if (!isPlainObject(raw)) {
    log.add(
      'icp_malformed',
      'Your ideal-customer-profile settings could not be read, so no industry, region or size filtering was applied.',
    );
    return DEFAULT_ICP;
  }

  const industries = toStringList(raw['industries']);
  const regions = toStringList(raw['regions']);

  if (raw['industries'] !== undefined && industries === null) {
    log.add(
      'icp_malformed',
      'Your ICP industry list could not be read, so every industry was accepted.',
    );
  }

  if (raw['regions'] !== undefined && regions === null) {
    log.add(
      'icp_malformed',
      'Your ICP region list could not be read, so every region was accepted.',
    );
  }

  const rawBands = raw['sizeBands'];
  let sizeBands: IcpSizeBand[] = [];

  if (rawBands !== undefined && rawBands !== null) {
    if (!Array.isArray(rawBands)) {
      log.add(
        'icp_malformed',
        'Your ICP company-size bands could not be read, so every company size was accepted.',
      );
    } else {
      sizeBands = rawBands.flatMap((entry): IcpSizeBand[] => {
        if (!isPlainObject(entry)) {
          return [];
        }

        const min = entry['minEmployees'];
        const max = entry['maxEmployees'];

        if (!isFiniteNumber(min) || min < 0) {
          return [];
        }

        const resolvedMax = isFiniteNumber(max) ? max : null;

        if (resolvedMax !== null && resolvedMax < min) {
          return [];
        }

        const label =
          typeof entry['label'] === 'string' && entry['label'].trim().length > 0
            ? entry['label'].trim()
            : `${min}-${resolvedMax ?? '∞'} employees`;

        return [{ label, minEmployees: min, maxEmployees: resolvedMax }];
      });

      if (sizeBands.length !== rawBands.length) {
        log.add(
          'icp_malformed',
          'Some ICP company-size bands were incomplete and were ignored.',
          `${rawBands.length - sizeBands.length} of ${rawBands.length} size bands dropped`,
        );
      }
    }
  }

  return {
    industries: industries ?? [],
    regions: regions ?? [],
    sizeBands,
  };
};

const readRuleOverrides = (
  raw: unknown,
  log: DegradationLog,
): Map<string, Record<string, unknown>> => {
  const overrides = new Map<string, Record<string, unknown>>();

  if (raw === undefined || raw === null) {
    return overrides;
  }

  // Accept both a keyed object and an array of { id, ... } records, because a
  // CRM config record can reasonably be modelled either way.
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isPlainObject(entry)) {
        continue;
      }

      const id = entry['id'] ?? entry['ruleId'];

      if (typeof id === 'string' && id.length > 0) {
        overrides.set(id, entry);
      }
    }

    return overrides;
  }

  if (!isPlainObject(raw)) {
    log.add(
      'rules_malformed',
      'Your rule settings could not be read, so every rule ran at its default setting.',
    );
    return overrides;
  }

  for (const [id, entry] of Object.entries(raw)) {
    if (isPlainObject(entry)) {
      overrides.set(id, entry);
      continue;
    }

    if (typeof entry === 'boolean') {
      overrides.set(id, { enabled: entry });
      continue;
    }

    log.add(
      'rule_setting_malformed',
      `The settings for rule "${id}" could not be read, so the rule ran at its default setting.`,
    );
  }

  return overrides;
};

const resolveRuleSettings = (
  raw: unknown,
  rules: readonly ScoringRule[],
  log: DegradationLog,
): Record<string, RuleSetting> => {
  const overrides = readRuleOverrides(raw, log);
  const settings: Record<string, RuleSetting> = {};

  for (const rule of rules) {
    const override = overrides.get(rule.id);

    let enabled = rule.defaultEnabled;
    let severity: RuleSeverity = rule.defaultSeverity;
    let weight = rule.defaultWeight;

    if (override !== undefined) {
      const rawEnabled = override['enabled'];

      if (typeof rawEnabled === 'boolean') {
        enabled = rawEnabled;
      } else if (rawEnabled !== undefined && rawEnabled !== null) {
        log.add(
          'rule_setting_malformed',
          `"${rule.name}" had an unreadable on/off setting, so it stayed at its default.`,
          `rule ${rule.id}`,
        );
      }

      const rawSeverity = override['severity'];

      if (
        typeof rawSeverity === 'string' &&
        (RULE_SEVERITIES as readonly string[]).includes(rawSeverity)
      ) {
        severity = rawSeverity as RuleSeverity;
      } else if (rawSeverity !== undefined && rawSeverity !== null) {
        log.add(
          'severity_malformed',
          `"${rule.name}" had an unrecognised severity, so its default severity was used.`,
          `rule ${rule.id}`,
        );
      }

      const rawWeight = override['weight'];

      if (isFiniteNumber(rawWeight) && rawWeight >= 0) {
        weight = rawWeight;
      } else if (rawWeight !== undefined && rawWeight !== null) {
        log.add(
          'weight_malformed',
          `"${rule.name}" had an unusable weight, so its default weight was used instead.`,
          `rule ${rule.id}`,
        );
      }
    }

    settings[rule.id] = { enabled, severity, weight };
  }

  // Neutral-weight fall-back: if nothing that can score carries any weight, the
  // score would be undefined. Give every rule the same voice instead.
  const scorable = rules.filter((rule) => {
    const setting = settings[rule.id];
    return setting !== undefined && setting.enabled && setting.severity !== 'advisory';
  });

  const totalWeight = scorable.reduce(
    (sum, rule) => sum + (settings[rule.id]?.weight ?? 0),
    0,
  );

  if (scorable.length > 0 && totalWeight <= 0) {
    log.add(
      'weight_malformed',
      'None of your enabled rules carried any weight, so every rule was given equal weight.',
    );

    for (const rule of scorable) {
      const current = settings[rule.id];

      if (current !== undefined) {
        settings[rule.id] = { ...current, weight: 1 };
      }
    }
  }

  return settings;
};

const resolveBands = (raw: unknown, log: DegradationLog): readonly ScoringBand[] => {
  if (raw === undefined || raw === null) {
    return DEFAULT_BANDS;
  }

  if (!Array.isArray(raw)) {
    log.add(
      'bands_malformed',
      'Your score bands could not be read, so the standard Excellent/Good/Fair/Poor bands were used.',
    );
    return DEFAULT_BANDS;
  }

  const bands = raw.flatMap((entry): ScoringBand[] => {
    if (!isPlainObject(entry)) {
      return [];
    }

    const minScore = entry['minScore'];

    if (!isFiniteNumber(minScore)) {
      return [];
    }

    const id =
      typeof entry['id'] === 'string' && entry['id'].trim().length > 0
        ? entry['id'].trim()
        : null;

    if (id === null) {
      return [];
    }

    const label =
      typeof entry['label'] === 'string' && entry['label'].trim().length > 0
        ? entry['label'].trim()
        : id;

    return [{ id, label, minScore: Math.min(100, Math.max(0, minScore)) }];
  });

  if (bands.length === 0) {
    log.add(
      'bands_malformed',
      'No usable score bands were configured, so the standard Excellent/Good/Fair/Poor bands were used.',
    );
    return DEFAULT_BANDS;
  }

  if (bands.length !== raw.length) {
    log.add(
      'bands_malformed',
      'Some score bands were incomplete and were ignored.',
      `${raw.length - bands.length} of ${raw.length} bands dropped`,
    );
  }

  return [...bands].sort((a, b) => b.minScore - a.minScore);
};

const resolveGateThreshold = (raw: unknown, log: DegradationLog): number => {
  if (raw === undefined || raw === null) {
    return DEFAULT_GATE_THRESHOLD;
  }

  if (!isFiniteNumber(raw) || raw < 0 || raw > 100) {
    log.add(
      'gate_threshold_malformed',
      `Your gate threshold was not a score between 0 and 100, so the default of ${DEFAULT_GATE_THRESHOLD} was used.`,
    );
    return DEFAULT_GATE_THRESHOLD;
  }

  return raw;
};

const resolveShelfLife = (raw: unknown, log: DegradationLog): number => {
  if (raw === undefined || raw === null) {
    return DEFAULT_SHELF_LIFE_DAYS;
  }

  if (!isFiniteNumber(raw) || raw <= 0) {
    log.add(
      'shelf_life_malformed',
      `Your data shelf life was not a positive number of days, so the default of ${DEFAULT_SHELF_LIFE_DAYS} days was used.`,
    );
    return DEFAULT_SHELF_LIFE_DAYS;
  }

  return raw;
};

const resolveFieldShelfLives = (
  raw: unknown,
  log: DegradationLog,
): Partial<Record<LeadFieldKey, number>> => {
  if (raw === undefined || raw === null) {
    return {};
  }

  if (!isPlainObject(raw)) {
    log.add(
      'shelf_life_malformed',
      'Your per-field shelf lives could not be read, so the single default shelf life was used for every field.',
    );
    return {};
  }

  const resolved: Partial<Record<LeadFieldKey, number>> = {};

  for (const key of LEAD_FIELD_KEYS) {
    const value = raw[key];

    if (value === undefined || value === null) {
      continue;
    }

    if (isFiniteNumber(value) && value > 0) {
      resolved[key] = value;
    } else {
      log.add(
        'shelf_life_malformed',
        `The shelf life for "${key}" was not a positive number of days, so the default shelf life was used.`,
      );
    }
  }

  return resolved;
};

/**
 * Resolve one vocabulary list against the three-layer precedence.
 *
 * `shipped` is the in-source constant and `baseline` is the licence-delivered
 * replacement for it, or `undefined` when there is none. The workspace's own
 * value still wins over both — with one carefully-bounded exception.
 *
 * ## The exception: an unedited seed is not a choice
 *
 * The post-install hook copies the shipped decision-maker list *into* the config
 * record so an admin can see and edit it. Every fresh install therefore holds an
 * "explicit" list that is really just the default, and treating it as a choice
 * would let it shadow calibration permanently — calibration would arrive, verify,
 * publish, and change nothing.
 *
 * So a stored list whose set of entries is exactly the shipped set is recognised
 * as an untouched seed and steps aside for the baseline. Adding or removing a
 * single entry makes it a genuine curation that nothing will override. The
 * comparison is exact set equality: no subset test, no size heuristic, nothing
 * that could mistake a real edit for a seed. And it only ever applies when a
 * baseline exists — with no calibration, the shipped list is what the seed
 * resolves to either way, so the branch is unreachable in an unlicensed install.
 */
const resolveTitleList = (
  raw: unknown,
  shipped: readonly string[],
  baseline: readonly string[] | undefined,
  label: string,
  log: DegradationLog,
): readonly string[] => {
  const fallback = baseline ?? shipped;

  if (raw === undefined || raw === null) {
    return fallback;
  }

  const list = toStringList(raw);

  if (list === null || list.length === 0) {
    log.add(
      'title_list_malformed',
      `Your ${label} list could not be read, so the built-in list was used.`,
    );
    return fallback;
  }

  if (baseline !== undefined && isSameStringSet(list, shipped)) {
    return baseline;
  }

  return lowerAll(list);
};

/**
 * Keys the customer's field mapping is not allowed to move.
 *
 * These are Greenlight's own suppression columns: the app ships them, owns them,
 * and knows exactly where they live. Every other key here is a genuine Layer 3
 * seam because the field belongs to the customer's schema — these two do not,
 * and a config blob able to point `suppressed` somewhere else is a config blob
 * able to switch the block list off by mistyping a column name. The workspace's
 * *own* opt-out columns remain fully mappable under `optedOut`, and the
 * compliance rule takes the union of the two.
 */
const PINNED_FIELD_MAPPING_KEYS: readonly LeadFieldKey[] = [
  'suppressed',
  'suppressionReason',
];

/**
 * The workspace's mapping, resolved and repaired — before the enriched tail is
 * appended. Split out so `withEnrichedFallbacks` runs on *every* return path,
 * including the two that bail out early on unreadable configuration.
 */
const readConfiguredFieldMapping = (
  raw: unknown,
  log: DegradationLog,
): FieldMapping => {
  const mapping: Record<LeadFieldKey, readonly string[]> = {
    ...DEFAULT_FIELD_MAPPING,
  };

  if (raw === undefined || raw === null) {
    return mapping;
  }

  if (!isPlainObject(raw)) {
    log.add(
      'field_mapping_malformed',
      'Your field mapping could not be read, so the default field names were used.',
    );
    return mapping;
  }

  for (const key of LEAD_FIELD_KEYS) {
    const value = raw[key];

    if (value === undefined || value === null) {
      continue;
    }

    if (PINNED_FIELD_MAPPING_KEYS.includes(key)) {
      log.add(
        'field_mapping_malformed',
        `"${key}" is one of Greenlight's own do-not-contact fields and cannot be remapped, so the mapping you supplied for it was ignored. Use "Opt-out fields" to add your own opt-out columns alongside it.`,
      );
      continue;
    }

    const paths = toStringList(value);

    if (paths === null || paths.length === 0) {
      log.add(
        'field_mapping_malformed',
        `The field mapping for "${key}" was unusable, so the default field names were used.`,
      );
      continue;
    }

    mapping[key] = paths;
  }

  return mapping;
};

const resolveFieldMapping = (raw: unknown, log: DegradationLog): FieldMapping =>
  withEnrichedFallbacks(readConfiguredFieldMapping(raw, log));

/**
 * Turn an untrusted config value into a usable configuration.
 *
 * Never throws. The returned `source` tells the caller whether the workspace's
 * own configuration was used as-is (`provided`), had to be patched
 * (`repaired`), or was absent entirely (`defaults`).
 *
 * ## The baseline argument
 *
 * `baseline` is licence-delivered vocabulary — see
 * `src/calibration/apply.ts`. It is a *fall-back* replacement, never an
 * override: it stands in for the shipped constants when the workspace has said
 * nothing, and it is invisible when the workspace has said something. Passing
 * `undefined` or `null` — the unlicensed, offline, stale and
 * signature-failing cases, which is to say every case where anything went wrong
 * — makes this function behave exactly as it did before the parameter existed.
 * `__tests__/config.test.ts` asserts that identity rather than asserting a
 * promise about it.
 *
 * The baseline never reaches `source`. A calibrated workspace with an otherwise
 * clean config record still reports `provided`, because calibration is not a
 * repair and an admin reading the trace should not see one.
 */
export const resolveConfig = (
  raw: ScoringConfigInput,
  rules: readonly ScoringRule[] = ALL_RULES,
  baseline?: ScoringVocabularyBaseline | null,
): ConfigResolution => {
  const log = new DegradationLog();
  const vocabulary = baseline ?? undefined;

  if (raw === undefined || raw === null) {
    return {
      config: buildDefaultConfig(rules, vocabulary),
      source: 'defaults',
      degradations: [
        {
          code: 'config_missing',
          message:
            'No Greenlight configuration was found, so this lead was scored with the built-in defaults.',
        },
      ],
    };
  }

  if (!isPlainObject(raw)) {
    return {
      config: buildDefaultConfig(rules, vocabulary),
      source: 'defaults',
      degradations: [
        {
          code: 'config_malformed',
          message:
            'The Greenlight configuration record could not be read, so this lead was scored with the built-in defaults.',
          detail: `expected an object, received ${Array.isArray(raw) ? 'array' : typeof raw}`,
        },
      ],
    };
  }

  const resolvedIcp = resolveIcp(raw['icp'], log);

  const config: ResolvedScoringConfig = {
    // Expansion is applied to the *resolved* ICP, so a workspace that listed
    // "SaaS" keeps "SaaS" at the head of the list and gains its cluster behind
    // it. An empty list is returned untouched — "no opinion" must not become
    // "an opinion about eighty industries".
    icp: {
      ...resolvedIcp,
      industries: expandIndustriesWithSynonyms(
        resolvedIcp.industries,
        vocabulary?.industrySynonyms,
      ),
    },
    rules: resolveRuleSettings(raw['rules'], rules, log),
    bands: resolveBands(raw['bands'], log),
    gateThreshold: resolveGateThreshold(raw['gateThreshold'], log),
    defaultShelfLifeDays: resolveShelfLife(raw['defaultShelfLifeDays'], log),
    fieldShelfLifeDays: resolveFieldShelfLives(raw['fieldShelfLifeDays'], log),
    decisionMakerTitles: lowerAll(
      resolveTitleList(
        raw['decisionMakerTitles'],
        DEFAULT_DECISION_MAKER_TITLES,
        vocabulary?.decisionMakerTitles,
        'decision-maker title',
        log,
      ),
    ),
    influencerTitles: lowerAll(
      resolveTitleList(
        raw['influencerTitles'],
        DEFAULT_INFLUENCER_TITLES,
        vocabulary?.influencerTitles,
        'influencer title',
        log,
      ),
    ),
    roleInboxLocalParts: lowerAll(
      resolveTitleList(
        raw['roleInboxLocalParts'],
        DEFAULT_ROLE_INBOX_LOCAL_PARTS,
        vocabulary?.roleInboxLocalParts,
        'shared-inbox',
        log,
      ),
    ),
    placeholderValues: lowerAll(
      resolveTitleList(
        raw['placeholderValues'],
        PLACEHOLDER_VALUES,
        vocabulary?.placeholderValues,
        'placeholder value',
        log,
      ),
    ),
    fieldMapping: resolveFieldMapping(raw['fieldMapping'], log),
  };

  return {
    config,
    source: log.count > 0 ? 'repaired' : 'provided',
    degradations: log.list,
  };
};
