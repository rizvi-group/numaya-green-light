/**
 * Numaya Greenlight — does the Layer 3 field mapping name fields that exist?
 *
 * Pure, like `backfill-plan.ts` and `backfill-state.ts` beside it, and for the
 * same reason: the request shape below and the reading of what came back are the
 * two things most likely to be wrong against a real schema, and a pure module is
 * the only place they can be asserted without a workspace. The one piece of I/O
 * the check needs — actually asking Twenty — is issued by `backfill-run.ts`.
 *
 * ============================================================================
 * ## The defect this exists to make visible
 *
 * An admin maps logical keys to their own field names on the `GreenlightConfig`
 * record: `decisionMakerFieldName`, `readyForOutreachFieldName`,
 * `optOutFieldNames`. Those names reach exactly one place in a request — the
 * **selection set** (`configuredSelectionFields` in `backfill-plan.ts`).
 *
 * It was believed, and written down in this repository, that a name which does
 * not exist would fail the query and trip the backfill's retry ladder. That was
 * wrong. Proved against a live instance in `src/__live__/api-contract.live-test.ts`:
 *
 *   - Twenty **validates arguments** — `filter`, `orderBy`, a mutation's `data`.
 *     A field the object does not have is rejected outright.
 *   - Twenty **does not validate selection sets**. A column the object does not
 *     have is selected without complaint and comes back `null`.
 *
 * So a single mistyped character in a settings field does not fail anything. The
 * page succeeds, the column arrives `null`, and the engine scores the record as
 * though a human had deliberately left that field blank. The backfill runs to
 * completion, reports success, and every score in the workspace is quietly worse
 * than it should be. No error, no notice, nothing for an admin to find.
 *
 * That is the worst class of defect this product can have, because it makes the
 * scores wrong while the product looks healthy, and the scores are what
 * customers buy.
 *
 * ============================================================================
 * ## Why the probe is a filter and never a selection
 *
 * Probing by selection is the bug itself: `{ people { edges { node { nonesuch } } } }`
 * answers happily on every workspace in existence, so a probe built that way
 * reports every name as present and is worse than no probe at all. Two field
 * probes in this repository were written that way and both answered `true`
 * everywhere — `probeOpportunityOwner` in `pipeline-store.ts` and `probeField` in
 * `icp-run.ts`, the latter reporting an ICP derived from industry columns that
 * mostly do not exist.
 *
 * The technique that works is the one `icp-run.ts` was corrected to use: put the
 * name in the half of the query Twenty *does* check.
 *
 *     people(first: 1, filter: { <name>: { is: "NOT_NULL" } }) { edges { node { id } } }
 *
 * `NOT_NULL` over `NULL` only because it reads as the question being asked: is
 * there such a thing. The rows are never looked at.
 *
 * ============================================================================
 * ## Silence is the safe answer, and this module is built to prefer it
 *
 * A validation that can break scoring is worse than the bug it was written to
 * catch, so nothing here is allowed to guess. A name is reported missing on one
 * condition only: Twenty rejected the probe with a message that names *that*
 * field as one the object does not have. Every other outcome — a composite type,
 * a transport failure, a permission error, an empty response, a message this
 * module does not recognise — resolves to `inconclusive`, which says nothing to
 * anybody and leaves scoring exactly as it is today.
 *
 * The composite case is worth stating on its own, because it is the one that
 * would produce a *false accusation* rather than a missed one. A configured name
 * pointing at a composite (`CURRENCY`, `ADDRESS`, `LINKS`, `emails`, `phones`)
 * is rejected with *"Sub field 'is' not found for composite type: …"*. The field
 * plainly exists — the probe simply cannot ask about it this way — so that shape
 * is read as **present**. `icp-run.ts` makes the opposite trade for its own
 * candidates and is right to: it is choosing between candidate columns and
 * "no industry field answered" is a true thing to say about a currency-typed
 * industry. Here the output is a sentence telling an admin their configuration is
 * wrong, and telling them that about a field they can see on the record page is
 * the kind of mistake that gets a warning ignored forever afterwards.
 */

import { DEFAULT_FIELD_MAPPING } from 'src/scoring';

import { isPlainRecord } from 'src/logic-functions/greenlight-api';

/* -------------------------------------------------------------------------- */
/* Which settings carry a field name                                           */
/* -------------------------------------------------------------------------- */

/** The `GreenlightConfig` settings whose value is a field name on the lead. */
export type MappedFieldSource =
  | 'decisionMakerFieldName'
  | 'readyForOutreachFieldName'
  | 'optOutFieldNames';

interface MappedFieldSourceDescriptor {
  /** The setting's label on the record page, so the sentence is findable. */
  readonly label: string;
  /**
   * The engine's logical key this setting feeds, or `null` for a setting that
   * only widens the selection. Naming the key is half of what makes the notice
   * actionable: "this name is wrong" is a fault report, "this name is wrong *so
   * the decision-maker signal is being read as empty*" is a decision.
   */
  readonly logicalKey: keyof typeof DEFAULT_FIELD_MAPPING | null;
}

export const MAPPED_FIELD_SOURCES: Readonly<
  Record<MappedFieldSource, MappedFieldSourceDescriptor>
> = {
  decisionMakerFieldName: {
    label: 'Decision-maker field',
    logicalKey: 'jobTitle',
  },
  readyForOutreachFieldName: {
    label: 'Ready-for-outreach field',
    logicalKey: null,
  },
  optOutFieldNames: { label: 'Opt-out fields', logicalKey: 'optedOut' },
};

export interface MappedFieldName {
  readonly name: string;
  readonly source: MappedFieldSource;
}

/**
 * A plain GraphQL identifier, and nothing else, ever.
 *
 * Config values are admin-supplied text one query away from the schema, so a
 * name that is not an identifier is dropped rather than interpolated. Dropping
 * is also why the check below can be honest about its own coverage: a name this
 * regex rejects never reaches a request, so it cannot be silently read as
 * `null`, and there is nothing to report about it.
 */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const asFieldName = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return FIELD_NAME.test(trimmed) ? trimmed : null;
};

/**
 * Every field name the workspace has pointed Greenlight at, with the setting it
 * came from.
 *
 * The provenance is the point. `configuredSelectionFields` in `backfill-plan.ts`
 * needs only the strings and is derived from this, so the two can never disagree
 * about which names reach a request — but a notice that says *"‘jobTitl’ is not
 * a field"* without saying which box it was typed into leaves an admin hunting
 * through a record page, and a notice nobody can act on is furniture.
 *
 * De-duplicated by name: the same string in two settings is one column to probe,
 * and it keeps the first setting that mentioned it because that is the reading
 * order of the record page.
 */
export const mappedFieldNames = (
  configRecord: unknown,
): MappedFieldName[] => {
  if (!isPlainRecord(configRecord)) {
    return [];
  }

  const found: MappedFieldName[] = [];
  const seen = new Set<string>();

  const add = (value: unknown, source: MappedFieldSource): void => {
    const name = asFieldName(value);

    if (name === null || seen.has(name)) {
      return;
    }

    seen.add(name);
    found.push({ name, source });
  };

  add(configRecord['decisionMakerFieldName'], 'decisionMakerFieldName');
  add(configRecord['readyForOutreachFieldName'], 'readyForOutreachFieldName');

  const optOutFields = configRecord['optOutFieldNames'];

  if (Array.isArray(optOutFields)) {
    for (const value of optOutFields) {
      add(value, 'optOutFieldNames');
    }
  }

  return found;
};

/* -------------------------------------------------------------------------- */
/* The probe                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How many names one check is allowed to ask about.
 *
 * `optOutFieldNames` is a free-text array an admin can paste anything into, and a
 * check that scaled with it would let a fifty-entry list turn one click on Start
 * into fifty requests against a 100-a-minute ceiling the backfill's own chunk
 * arithmetic already spends 62 of. A workspace configuring more than eight
 * mapped columns is not the shape this product is sold in, and the names past
 * the limit are simply not asked about — they are reported as unchecked in the
 * log rather than quietly assumed correct.
 *
 * Eight is comfortably above the realistic ceiling: one decision-maker field,
 * one ready-for-outreach field and up to six workspace opt-out columns.
 */
export const FIELD_MAPPING_PROBE_LIMIT = 8;

/**
 * The cheapest question that means "does this column exist", as a request.
 *
 * `first: 1` and a selection of nothing but `id`: the answer is carried entirely
 * by whether Twenty accepted the argument, so fetching a row is incidental and
 * fetching a wide one would be waste.
 */
export const buildFieldExistenceProbe = (
  connection: string,
  fieldName: string,
): Record<string, unknown> => ({
  [connection]: {
    __args: { first: 1, filter: { [fieldName]: { is: 'NOT_NULL' } } },
    edges: { node: { id: true } },
  },
});

/**
 * `absent` is the only verdict that ever reaches an admin. The other two are
 * both silence, and are kept apart only so the log can say which kind it was.
 */
export type FieldProbeVerdict = 'present' | 'absent' | 'inconclusive';

/**
 * Did the response actually answer, or did it merely come back?
 *
 * A rejected request normally throws out of the client, but a transport that
 * returns `{ errors, data: null }` without throwing would make every probe look
 * like a success. Requiring the connection to be present costs nothing and
 * closes that path — and because an unrecognised shape resolves to
 * `inconclusive` rather than `absent`, closing it errs towards saying nothing.
 */
export const probeAnswered = (
  connection: string,
  response: unknown,
): boolean =>
  isPlainRecord(response) && isPlainRecord(response[connection]);

/**
 * Twenty's way of saying "that object has no such field", in the two spellings
 * this app has actually seen come back.
 *
 * The first is the one that cost this repository months of wrong pipeline
 * criteria: `Object taskTarget doesn't have any "opportunityId" field.` The
 * second is the standard GraphQL rejection for a filter input that has no such
 * member. Both are matched only in company with the field's own name, so a
 * message about some *other* field — a nested error, a batched response — can
 * never be read as a verdict on this one.
 */
const ABSENT_PHRASES: readonly RegExp[] = [
  /does(?:n['’]t| not) have any/i,
  /is not defined by type/i,
  /unknown field/i,
];

/**
 * The field exists; the probe simply may not ask about it this way. See the
 * header: reporting a visible column as missing is the failure mode that gets
 * every future notice ignored, so this shape is read as present.
 */
const COMPOSITE_PHRASE = /sub ?field .* (?:not found|is not defined)/i;

/**
 * Read a rejection. Anything unrecognised is `inconclusive`, on purpose.
 *
 * This is where fail-open is actually implemented, so it is worth being blunt
 * about the trade: a Twenty release that reworded its errors turns this check
 * off — every probe becomes `inconclusive`, nothing is reported, and scoring
 * behaves precisely as it does today. It does not turn the check into a source
 * of false accusations, and it cannot stop a backfill. The live contract test is
 * what would notice the rewording; this function is what makes the rewording
 * survivable in the meantime.
 */
export const classifyProbeRejection = (
  fieldName: string,
  message: string,
): FieldProbeVerdict => {
  if (COMPOSITE_PHRASE.test(message)) {
    return 'present';
  }

  if (!message.includes(fieldName)) {
    return 'inconclusive';
  }

  return ABSENT_PHRASES.some((phrase) => phrase.test(message))
    ? 'absent'
    : 'inconclusive';
};

/* -------------------------------------------------------------------------- */
/* What an admin is told                                                       */
/* -------------------------------------------------------------------------- */

export interface MappingFinding {
  readonly name: string;
  readonly source: MappedFieldSource;
}

export interface FieldMappingCheckResult {
  /** Names Twenty explicitly said the object does not have. */
  readonly missing: readonly MappingFinding[];
  /** How many names were asked about. */
  readonly probed: number;
  /** Asked, but the answer could not be trusted either way. */
  readonly inconclusive: number;
  /** Past `FIELD_MAPPING_PROBE_LIMIT`, or the check never ran. */
  readonly unchecked: number;
}

export const EMPTY_FIELD_MAPPING_CHECK: FieldMappingCheckResult = {
  missing: [],
  probed: 0,
  inconclusive: 0,
  unchecked: 0,
};

/** The candidates the engine still reads when a configured name is not there. */
const fallbacksFor = (finding: MappingFinding): readonly string[] => {
  const key = MAPPED_FIELD_SOURCES[finding.source].logicalKey;

  if (key === null) {
    return [];
  }

  return DEFAULT_FIELD_MAPPING[key].filter((path) => path !== finding.name);
};

/** "a, b and c" — an English list, because this is a sentence a human reads. */
const asList = (values: readonly string[]): string => {
  if (values.length <= 1) {
    return values[0] ?? '';
  }

  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`;
};

/**
 * What this particular name being absent actually costs.
 *
 * Precision here is the whole requirement. "Invalid config" is useless, and so
 * is overstating it: the Layer 3 mapping *prepends* a configured name to the
 * engine's shipped candidates rather than replacing them (see `readFieldMapping`
 * in `greenlight-config-record.ts`), so a mistyped decision-maker field does not
 * blank the signal for every lead — it blanks it for the leads whose seniority
 * lives only in the workspace's own column. Saying "no lead has a job title"
 * would be a bigger claim than the code makes, and an admin who checks one
 * record and finds it scored fine will stop believing the next notice too.
 */
const consequenceOf = (finding: MappingFinding): string => {
  const fallbacks = fallbacksFor(finding);

  switch (finding.source) {
    case 'decisionMakerFieldName':
      return fallbacks.length === 0
        ? 'the decision-maker rule has nothing left to read, so seniority scores nothing on any lead'
        : `Greenlight falls back to ${asList(fallbacks)}, so a lead whose seniority is recorded only in that column is scored as though it had no job title`;

    case 'optOutFieldNames':
      return fallbacks.length === 0
        ? 'nothing is left for the compliance rule to read, so no lead can be recognised as opted out'
        : `Greenlight falls back to ${asList(fallbacks)}, so a lead who has opted out only in that column is not recognised as opted out and can be released for outreach`;

    case 'readyForOutreachFieldName':
    default:
      return 'no rule reads that setting in this release, so no score changes — but the setting is not pointing at anything, and it will matter as soon as one does';
  }
};

/**
 * The paragraph the admin reads, or `null` when there is nothing to say.
 *
 * One paragraph rather than a list because the panel renders this string as
 * prose, and a bullet list that arrives as a run-on line is worse than a
 * sentence written to be one. It leads with the consequence, names each field
 * and the box it was typed into, and ends with the two things to do — because a
 * notice that stops at "something is wrong" makes the reader do the work of
 * working out whether it matters.
 *
 * It never suggests the admin made a mistake. A field can vanish from a
 * workspace long after somebody typed its name correctly, and the sentence is
 * true either way.
 */
export const describeFieldMappingFindings = (
  missing: readonly MappingFinding[],
  objectLabel: string,
): string | null => {
  if (missing.length === 0) {
    return null;
  }

  const head =
    missing.length === 1
      ? `Greenlight’s field mapping names a field ${objectLabel} does not have, so this backfill reads it as empty on every lead.`
      : `Greenlight’s field mapping names ${missing.length} fields ${objectLabel} does not have, so this backfill reads them as empty on every lead.`;

  const lines = missing.map(
    (finding) =>
      `“${finding.name}” (${MAPPED_FIELD_SOURCES[finding.source].label}) is not a field on ${objectLabel} — ${consequenceOf(finding)}.`,
  );

  return [
    head,
    ...lines,
    'Correct the name on the Greenlight Configuration record, then run a backfill over all records to re-score what this run has already done.',
  ].join(' ');
};

/** The audit row's name — what the log shows before anybody opens the row. */
export const fieldMappingAuditName = (
  missing: readonly MappingFinding[],
  objectLabel: string,
): string =>
  missing.length === 1 && missing[0] !== undefined
    ? `ERROR · Greenlight field mapping · “${missing[0].name}” is not a field on ${objectLabel}`
    : `ERROR · Greenlight field mapping · ${missing.length} configured names are not fields on ${objectLabel}`;

/**
 * The structured half of the audit row, so the trail carries the facts and not
 * only the sentence. Same split as everywhere else here: `name` is for reading,
 * `ruleTrace` is for answering questions later.
 */
export const fieldMappingAuditDetail = (
  result: FieldMappingCheckResult,
  objectNameSingular: string,
): Record<string, unknown> => ({
  action: 'field_mapping_check',
  leadObjectNameSingular: objectNameSingular,
  missing: result.missing.map((finding) => ({
    name: finding.name,
    setting: finding.source,
    settingLabel: MAPPED_FIELD_SOURCES[finding.source].label,
    logicalKey: MAPPED_FIELD_SOURCES[finding.source].logicalKey,
    remainingCandidates: fallbacksFor(finding),
  })),
  probed: result.probed,
  inconclusive: result.inconclusive,
  unchecked: result.unchecked,
});
