/**
 * The adapter between the `GreenlightConfig` CRM record and the scoring engine.
 *
 * These are two different shapes on purpose and the gap has to live somewhere:
 *
 *   GreenlightConfig  is designed for a human with a record page. Bands are three
 *                     separate NUMBER fields because a typo inside a JSON blob
 *                     would silently gate a whole workspace; enable/severity and
 *                     weight are separate RAW_JSON maps because they are two
 *                     different decisions an admin makes at different times.
 *
 *   ResolvedScoringConfig  is designed for the engine. Bands are one sorted
 *                     array; every rule carries enabled + severity + weight
 *                     together.
 *
 * This file is the only place that knows both. Everything here is a pure
 * function of its input — no API client, no clock — so the whole
 * seed / read / merge story is unit-testable without a Twenty instance.
 */

import { buildDefaultConfig } from 'src/scoring';
import type { ResolvedScoringConfig } from 'src/scoring';

import { isPlainRecord } from 'src/logic-functions/greenlight-api';

/**
 * The `GreenlightConfig.leadObjectNameSingular` SELECT value for Person.
 *
 * Duplicated from `src/objects/greenlight-config.ts` rather than imported: that
 * module pulls in `twenty-sdk/define`, and a logic-function bundle has no
 * business carrying the whole manifest-authoring toolkit. The value is a SELECT
 * option and is as permanent as the field identifier itself.
 */
export const DEFAULT_LEAD_OBJECT_SELECT_VALUE = 'PERSON';

/** Lowercase API name matching the SELECT value above, for the audit trail. */
export const LEAD_OBJECT_SELECT_TO_NAME_SINGULAR: Readonly<
  Record<string, string>
> = {
  PERSON: 'person',
  COMPANY: 'company',
  OPPORTUNITY: 'opportunity',
};

/** Every field this app reads from or writes to the config record. */
export const GREENLIGHT_CONFIG_FIELD_NAMES = [
  'id',
  'createdAt',
  'name',
  'isGateEnabled',
  'icpIndustries',
  'icpRegions',
  'icpSizeBands',
  'ruleSettings',
  'scoreWeights',
  'bandExcellentThreshold',
  'bandGoodThreshold',
  'bandFairThreshold',
  'gateThreshold',
  'defaultShelfLifeDays',
  'fieldShelfLives',
  'leadObjectNameSingular',
  'decisionMakerFieldName',
  'decisionMakerMatchValues',
  'readyForOutreachFieldName',
  'readyForOutreachValue',
  'optOutFieldNames',
] as const;

/** GraphQL selection set for the fields above. */
export const greenlightConfigSelection = (): Record<string, boolean> =>
  Object.fromEntries(GREENLIGHT_CONFIG_FIELD_NAMES.map((name) => [name, true]));

export type GreenlightConfigSeed = Record<string, unknown>;

const bandMinScore = (
  config: ResolvedScoringConfig,
  bandId: string,
): number | undefined =>
  config.bands.find((band) => band.id === bandId)?.minScore;

/**
 * The record the post-install hook writes on a fresh install.
 *
 * Every value is set **explicitly** rather than left to the field manifest's
 * `defaultValue`, for three reasons:
 *
 *  1. The manifest defaults and the engine defaults disagree. The field
 *     manifests carry bands 80/60/40 and gate 40; `buildDefaultConfig()` — the
 *     thing that actually scores leads — carries 85/70/50 and gate 50. Whichever
 *     is "right", they must not differ, and the engine is the one that decides
 *     outcomes, so the engine wins. Leaving the record blank would ship a
 *     workspace whose visible configuration lies about its own behaviour.
 *     `decisionMakerMatchValues` has the same problem: 12 titles in the manifest,
 *     25 in the engine.
 *  2. `ruleSettings` and `scoreWeights` cannot come from a manifest default at
 *     all — they are keyed by the rule catalogue, which the engine owns and which
 *     grows every release.
 *  3. A `defaultValue` only applies at column creation. It is not a value a
 *     later read can distinguish from "the admin set it to that", so relying on
 *     it would make the upgrade-merge below unable to tell missing from chosen.
 *
 * The rule of thumb: if the engine has an opinion, seed it explicitly; the field
 * manifest `defaultValue` is then only a safety net for records created by hand.
 */
export const buildGreenlightConfigSeed = (): GreenlightConfigSeed => {
  const defaults = buildDefaultConfig();

  const ruleSettings: Record<string, { enabled: boolean; severity: string }> =
    {};
  const scoreWeights: Record<string, number> = {};

  for (const [ruleId, setting] of Object.entries(defaults.rules)) {
    ruleSettings[ruleId] = {
      enabled: setting.enabled,
      severity: setting.severity,
    };
    scoreWeights[ruleId] = setting.weight;
  }

  return {
    name: 'Default',
    isGateEnabled: true,

    icpIndustries: [...defaults.icp.industries],
    icpRegions: [...defaults.icp.regions],
    icpSizeBands: { bands: [...defaults.icp.sizeBands] },

    ruleSettings,
    scoreWeights,

    bandExcellentThreshold: bandMinScore(defaults, 'excellent') ?? 85,
    bandGoodThreshold: bandMinScore(defaults, 'good') ?? 70,
    bandFairThreshold: bandMinScore(defaults, 'fair') ?? 50,
    gateThreshold: defaults.gateThreshold,

    defaultShelfLifeDays: defaults.defaultShelfLifeDays,
    fieldShelfLives: { ...defaults.fieldShelfLifeDays },

    leadObjectNameSingular: DEFAULT_LEAD_OBJECT_SELECT_VALUE,
    decisionMakerFieldName: 'jobTitle',
    decisionMakerMatchValues: [...defaults.decisionMakerTitles],

    // Stock Twenty's Person has no stage field, so there is nothing honest to
    // point these at. Blank means "the release action only clears the gate".
    readyForOutreachFieldName: null,
    readyForOutreachValue: null,

    // Empty, not absent: the engine's default field mapping already probes
    // `optedOut` / `doNotContact` / `emailOptOut` / `unsubscribed`. This list is
    // for *extra* workspace-specific opt-out fields.
    optOutFieldNames: [],
  };
};

/* -------------------------------------------------------------------------- */
/* Upgrade merge                                                               */
/* -------------------------------------------------------------------------- */

const isMissing = (value: unknown): boolean =>
  value === undefined || value === null;

/**
 * Whether writing `seedValue` over a missing field would actually change
 * anything once Twenty has stored it.
 *
 * Found by running a real `app:install` upgrade rather than by a unit test, and
 * unit tests structurally cannot see it: **Twenty persists an empty `RAW_JSON`
 * as `null`.** So `fieldShelfLives`, seeded `{}`, reads back as `null`,
 * `isMissing` says missing, the patch writes `{}` again, and it reads back
 * `null` again — forever. Every single upgrade patched exactly one key and filed
 * an audit row claiming a merge that had not happened, which quietly makes the
 * upgrade trail untrustworthy for the merges that are real.
 *
 * A patch that cannot converge is not a merge, it is a loop with an audit trail.
 * An empty seed value written over a missing field is a no-op by definition, so
 * it is skipped and the key is left to the field manifest's own default.
 */
const isNoOpSeed = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.length === 0;
  }

  if (isPlainRecord(value)) {
    return Object.keys(value).length === 0;
  }

  return false;
};

/**
 * The patch an upgrade should apply to an existing config record.
 *
 * "Missing" means `null` or `undefined` only. An empty array, an empty object
 * and a zero are all *choices* a workspace made — a permissive ICP is the whole
 * point of the shipped default — and resetting them to seed values would be the
 * exact behaviour ARCHITECTURE.md's upgrade section forbids ("config merge, not
 * replace").
 *
 * The interesting case is `ruleSettings` / `scoreWeights`: a release that adds a
 * rule must make that rule appear in the workspace's config at its shipped
 * default, without disturbing a single existing entry. Both maps are therefore
 * merged key-by-key rather than compared wholesale.
 *
 * Returns an empty object when there is nothing to do, so the caller can skip
 * the mutation entirely — which is what makes re-running the hook a no-op.
 */
export const buildConfigUpgradePatch = (
  existing: unknown,
  seed: GreenlightConfigSeed = buildGreenlightConfigSeed(),
): Record<string, unknown> => {
  const record = isPlainRecord(existing) ? existing : {};
  const patch: Record<string, unknown> = {};

  for (const [key, seedValue] of Object.entries(seed)) {
    // `null` is the intended seeded value for these two, so a null on the
    // record is indistinguishable from the seed and must never be "repaired".
    if (seedValue === null) {
      continue;
    }

    if (key === 'ruleSettings' || key === 'scoreWeights') {
      continue;
    }

    if (isMissing(record[key]) && !isNoOpSeed(seedValue)) {
      patch[key] = seedValue;
    }
  }

  const ruleSettingsPatch = mergeKeyedMap(
    record['ruleSettings'],
    seed['ruleSettings'],
  );

  if (ruleSettingsPatch !== null) {
    patch['ruleSettings'] = ruleSettingsPatch;
  }

  const scoreWeightsPatch = mergeKeyedMap(
    record['scoreWeights'],
    seed['scoreWeights'],
  );

  if (scoreWeightsPatch !== null) {
    patch['scoreWeights'] = scoreWeightsPatch;
  }

  return patch;
};

/**
 * Merge shipped keys into a stored map without overwriting anything present.
 * Returns `null` when the stored map already covers every shipped key — the
 * signal that no write is needed.
 */
const mergeKeyedMap = (
  stored: unknown,
  shipped: unknown,
): Record<string, unknown> | null => {
  if (!isPlainRecord(shipped)) {
    return null;
  }

  if (!isPlainRecord(stored)) {
    // Absent or unreadable: replacing it with the shipped map loses nothing,
    // because there was nothing legible there to lose.
    return { ...shipped };
  }

  const merged: Record<string, unknown> = { ...stored };
  let added = false;

  for (const [key, value] of Object.entries(shipped)) {
    if (isMissing(merged[key])) {
      merged[key] = value;
      added = true;
    }
  }

  return added ? merged : null;
};

/* -------------------------------------------------------------------------- */
/* Record -> engine config                                                     */
/* -------------------------------------------------------------------------- */

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const asStringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const list = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return list;
};

/** `icpSizeBands` ships as `{ bands: [...] }`; tolerate a bare array too. */
const readSizeBands = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value;
  }

  if (isPlainRecord(value) && Array.isArray(value['bands'])) {
    return value['bands'];
  }

  return undefined;
};

/**
 * Recombine `ruleSettings` (enable + severity) and `scoreWeights` (weight) into
 * the single per-rule shape the engine reads.
 *
 * `isEnabled` is accepted as an alias for `enabled` because the field's own
 * description in `src/objects/greenlight-config.ts` documents that spelling.
 * The engine reads `enabled`; rather than let a hand-edited record silently do
 * nothing, both are honoured here. (The field description is stale — see the
 * report accompanying this change.)
 */
const readRules = (
  ruleSettings: unknown,
  scoreWeights: unknown,
): Record<string, unknown> | undefined => {
  const settings = isPlainRecord(ruleSettings) ? ruleSettings : undefined;
  const weights = isPlainRecord(scoreWeights) ? scoreWeights : undefined;

  if (settings === undefined && weights === undefined) {
    return undefined;
  }

  const ruleIds = new Set<string>([
    ...Object.keys(settings ?? {}),
    ...Object.keys(weights ?? {}),
  ]);

  const rules: Record<string, unknown> = {};

  for (const ruleId of ruleIds) {
    const setting = settings?.[ruleId];
    const merged: Record<string, unknown> = isPlainRecord(setting)
      ? { ...setting }
      : {};

    if (merged['enabled'] === undefined && merged['isEnabled'] !== undefined) {
      merged['enabled'] = merged['isEnabled'];
    }

    const weight = asFiniteNumber(weights?.[ruleId]);

    if (weight !== undefined) {
      merged['weight'] = weight;
    }

    rules[ruleId] = merged;
  }

  return rules;
};

/**
 * Rebuild the engine's band array from the three threshold fields.
 *
 * Returns `undefined` when no threshold is usable, which makes `resolveConfig`
 * fall back to the shipped bands without logging a degradation — the right
 * outcome, because "the admin never touched this" is not a fault.
 */
const readBands = (record: Record<string, unknown>): unknown => {
  const excellent = asFiniteNumber(record['bandExcellentThreshold']);
  const good = asFiniteNumber(record['bandGoodThreshold']);
  const fair = asFiniteNumber(record['bandFairThreshold']);

  if (excellent === undefined && good === undefined && fair === undefined) {
    return undefined;
  }

  const bands: { id: string; label: string; minScore: number }[] = [];

  if (excellent !== undefined) {
    bands.push({ id: 'excellent', label: 'Excellent', minScore: excellent });
  }

  if (good !== undefined) {
    bands.push({ id: 'good', label: 'Good', minScore: good });
  }

  if (fair !== undefined) {
    bands.push({ id: 'fair', label: 'Fair', minScore: fair });
  }

  // Poor is the floor and has no threshold field: it is whatever is left.
  bands.push({ id: 'poor', label: 'Poor', minScore: 0 });

  return bands;
};

/**
 * The Layer 3 field mapping, expressed as *additional* candidate paths in front
 * of the engine's defaults rather than as a replacement.
 *
 * Prepending matters: a workspace that points `decisionMakerFieldName` at a
 * custom field still wants `jobTitle` probed as a fallback for the Person
 * records where the custom field is blank. De-duplicated so that pointing the
 * setting at the default field name produces the default list unchanged rather
 * than a list that probes the same path twice.
 */
const prepend = (
  extra: readonly string[],
  defaults: readonly string[],
): string[] => [...new Set([...extra, ...defaults])];

const readFieldMapping = (
  record: Record<string, unknown>,
): Record<string, string[]> | undefined => {
  const mapping: Record<string, string[]> = {};

  const decisionMakerField = record['decisionMakerFieldName'];

  if (typeof decisionMakerField === 'string' && decisionMakerField.trim()) {
    mapping['jobTitle'] = prepend(
      [decisionMakerField.trim()],
      ['jobTitle', 'title', 'role', 'position'],
    );
  }

  const optOutFields = asStringList(record['optOutFieldNames']);

  if (optOutFields !== undefined && optOutFields.length > 0) {
    mapping['optedOut'] = prepend(optOutFields, [
      'optedOut',
      'doNotContact',
      'emailOptOut',
      'unsubscribed',
    ]);
  }

  return Object.keys(mapping).length > 0 ? mapping : undefined;
};

/**
 * Turn a `GreenlightConfig` record into the raw config `scoreLead` accepts.
 *
 * Deliberately lenient: anything unreadable is left out of the returned object
 * so `resolveConfig` supplies its own default. This function never throws and
 * never validates — validation is the engine's job and it already reports what
 * it had to repair.
 */
export const toScoringConfigInput = (record: unknown): unknown => {
  if (!isPlainRecord(record)) {
    return undefined;
  }

  const industries = asStringList(record['icpIndustries']);
  const regions = asStringList(record['icpRegions']);
  const sizeBands = readSizeBands(record['icpSizeBands']);

  const icp =
    industries !== undefined || regions !== undefined || sizeBands !== undefined
      ? {
          industries: industries ?? [],
          regions: regions ?? [],
          sizeBands: sizeBands ?? [],
        }
      : undefined;

  const decisionMakerTitles = asStringList(record['decisionMakerMatchValues']);

  return {
    icp,
    rules: readRules(record['ruleSettings'], record['scoreWeights']),
    bands: readBands(record),
    gateThreshold: asFiniteNumber(record['gateThreshold']),
    defaultShelfLifeDays: asFiniteNumber(record['defaultShelfLifeDays']),
    fieldShelfLifeDays: isPlainRecord(record['fieldShelfLives'])
      ? record['fieldShelfLives']
      : undefined,
    // Empty means "the admin cleared the list", which disables the
    // decision-maker rule on purpose. Only an unreadable value falls back.
    decisionMakerTitles,
    fieldMapping: readFieldMapping(record),
  };
};

/** Is the gate switched on? Absent or unreadable reads as on. */
export const isGateEnabled = (record: unknown): boolean =>
  !(isPlainRecord(record) && record['isGateEnabled'] === false);

/** Which object the workspace calls the lead, as a lowercase API name. */
export const readLeadObjectNameSingular = (record: unknown): string => {
  const raw = isPlainRecord(record) ? record['leadObjectNameSingular'] : null;

  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return LEAD_OBJECT_SELECT_TO_NAME_SINGULAR[
      DEFAULT_LEAD_OBJECT_SELECT_VALUE
    ] as string;
  }

  const normalised = raw.trim().toUpperCase();

  return LEAD_OBJECT_SELECT_TO_NAME_SINGULAR[normalised] ?? raw.trim();
};
