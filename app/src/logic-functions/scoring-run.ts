/**
 * The Person scoring run — everything the two database-event registrations share.
 *
 * Kept out of the `define*` files so it can be exercised against a fake API
 * client. The only impure things it touches are the client it is handed and the
 * `now` it is passed; there is no `new Date()` and no `new CoreApiClient()`
 * anywhere below.
 *
 * ## Not retriggering ourselves
 *
 * Writing `greenlightScore` back to a Person emits `person.updated`, which is
 * the event that made us score in the first place. Three independent guards stop
 * that becoming a loop, in order of how much they can be trusted:
 *
 *  1. **The trigger allow-list** (`SCORING_TRIGGER_PERSON_FIELDS`, declared in
 *     `score-person-updated.logic-function.ts`). Twenty only dispatches an update
 *     event to a function whose `databaseEventTriggerSettings.updatedFields`
 *     names a field that actually changed. None of Greenlight's three fields is
 *     on that list, so the platform never delivers our own write back to us.
 *     This guard runs outside our process and is the one doing the real work.
 *
 *  2. **The authored-write check** (`isGreenlightAuthoredWrite`). If an event
 *     arrives anyway — a bulk edit that touched a scoring field *and* a
 *     Greenlight field, a future SDK that treats `updatedFields` as advisory —
 *     and every field it reports is one we own, the run exits before any read or
 *     write. Cheap, and it does not depend on the platform honouring anything.
 *
 *  3. **The outcome fingerprint** (`fingerprintOutcome`). Even if both guards
 *     above were bypassed, the second pass over an unchanged lead produces an
 *     identical fingerprint to the one already stored on the record, so nothing
 *     is written and the chain terminates after exactly one extra iteration.
 *     This is also what makes a retried event idempotent: no second audit row,
 *     no second write.
 *
 * The allow-list in guard 1 does carry three Greenlight-named fields —
 * `greenlightSuppressed`, `greenlightSuppressionReason` and
 * `greenlightEnrichment`. All three are safe for the same structural reason:
 * this run never writes any of them, so its own write-back still wakes nothing.
 * Both exceptions, and the bounded enrichment cycle the third one does close,
 * are argued in full on `SCORING_TRIGGER_PERSON_FIELDS` below.
 *
 * Guard 3 fingerprints the *outcome*, not the inputs, on purpose. The engine's
 * default field mapping reads `lastVerifiedAt` from `updatedAt`, which changes
 * on every write — an input hash would therefore differ on every pass and could
 * never terminate. The outcome is stable by construction.
 *
 * ## Not undoing a human override
 *
 * The guards above stop *our own* write from re-scoring a lead. They do nothing
 * about the other half of the contract with `release-lead.logic-function.ts`: a
 * rep releases a gated lead, then edits `jobTitle` seconds later, which is a
 * legitimate re-score that would re-gate the lead the human just released.
 *
 * The release writes a marker to app key-value storage. This run reads it before
 * writing a holding decision and pins the decision to `PASS` when one is present
 * — the score and the whole trace still update, only the decision is pinned. See
 * `pinReleasedDecision` for the exceptions and the failure directions.
 */

import {
  SCORING_ENGINE_VERSION,
  scoreLead,
  toLeadRecord,
  type GateDecision,
  type ScoringResult,
} from 'src/scoring';

import {
  NO_SEAL,
  resolveCalibration,
  sealedCalibrationBody,
  toScoringBaseline,
  type CalibrationReaderPort,
  type CalibrationSealPort,
} from 'src/calibration';
import {
  releaseMarkerKey,
  type ReleaseMarker,
} from 'src/gate/release-decision';
import { SUPPRESSION_SCORING_INPUT_FIELDS } from 'src/gate/suppression-decision';
import {
  describeError,
  isPlainRecord,
  logGreenlight,
  oldestByCreatedAt,
  readConnectionNodes,
  type GreenlightApiClient,
} from 'src/logic-functions/greenlight-api';
import {
  greenlightConfigSelection,
  isGateEnabled,
  readLeadObjectNameSingular,
  toScoringConfigInput,
} from 'src/logic-functions/greenlight-config-record';

/* -------------------------------------------------------------------------- */
/* Field vocabulary                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The Person fields **this run writes**. Nothing here may ever appear in a
 * `databaseEventTriggerSettings.updatedFields` list — see guard 1 above.
 *
 * "Managed" means written by the scoring run, not merely shipped by Greenlight.
 * The distinction started mattering when the app grew fields it *owns* but never
 * writes: the four `greenlightSuppress*` columns are Greenlight's own schema and
 * are human-maintained input, so two of them are on the trigger list below and
 * none of them belongs here. Adding one of them to this list would make guard 2
 * swallow the very event the feature depends on.
 */
export const GREENLIGHT_MANAGED_PERSON_FIELDS: readonly string[] = [
  'greenlightScore',
  'greenlightDecision',
  'greenlightTrace',
];

/**
 * Fields whose change can move the score, i.e. the ones worth re-scoring for.
 *
 * `updatedAt` is deliberately absent even though the freshness rule reads it:
 * it changes on *every* write, including ours, which would defeat guard 1
 * entirely. Freshness is re-evaluated whenever anything else changes, and a lead
 * that goes stale without being touched is a reporting problem, not an event.
 *
 * `company` and `companyId` are both listed because Twenty reports a relation
 * change under the foreign-key name in some versions and the relation name in
 * others; a name that never fires costs nothing.
 *
 * ## The suppression exception
 *
 * `SUPPRESSION_SCORING_INPUT_FIELDS` appends `greenlightSuppressed` and
 * `greenlightSuppressionReason`. These are the only Greenlight-named fields on
 * this list, and the exception is mandatory rather than convenient: suppression
 * is a *blocking* input to the compliance rule, so a change that does not
 * re-score leaves a person who has just asked us to stop sitting in the queue
 * still marked `PASS`. A block list nobody re-scores against is not a block list.
 *
 * The loop still terminates, and the argument is the same three guards, checked
 * against the new field:
 *
 *   1. **Guard 1 still holds because the two sets are disjoint.** The scoring run
 *      writes exactly `GREENLIGHT_MANAGED_PERSON_FIELDS`, and no name on that
 *      list is on this one. A suppression change wakes the scorer; the scorer's
 *      own write-back does not wake anything, because it touches none of these
 *      names. The cycle would only close if the run wrote a suppression field,
 *      which it never does — the two block-list actions are the only writers, and
 *      they are human-triggered. `scoring-run.test.ts` asserts both halves.
 *   2. **Guard 2 is unaffected.** `isGreenlightAuthoredWrite` tests membership of
 *      the managed list, not of this one, so an event carrying only suppression
 *      fields is correctly *not* treated as our own write and is scored.
 *   3. **Guard 3 is the backstop and gets stronger, not weaker.** Suppression
 *      moves the compliance rule's outcome, so the first run after a change has a
 *      genuinely different fingerprint and writes; any replay of that same event
 *      fingerprints identically and writes nothing.
 *
 * ## The enrichment exception
 *
 * `greenlightEnrichment` is on this list for the same kind of reason and it is
 * equally mandatory. `resolveFieldMapping` appends
 * `greenlightEnrichment.fields.<key>.parsedValue` to every enrichable key, so an
 * enriched value is a *scoring input*. Leaving it off meant enrichment could
 * only ever benefit a lead on its next unrelated edit — the enriched industry
 * sat on the record, read by nothing, until somebody happened to change a phone
 * number. That is enrichment being cosmetic, which is the bug this closes.
 *
 * The two sibling columns are deliberately **not** here. `greenlightEnrichedAt`
 * and `greenlightEnrichmentStatus` are written by the same mutation but no rule
 * reads either, so waking the scorer for them would buy a guaranteed-identical
 * fingerprint and nothing else.
 *
 * ### Why this terminates
 *
 * Unlike suppression, this one *does* close a cycle: enrichment's own trigger is
 * `greenlightDecision`, which is a field this run writes. The cycle is real,
 * bounded, and cannot reach a provider more than a fixed number of times.
 *
 *   1. **The common case never starts.** Guard 3 is checked before any write. If
 *      enrichment changed no value the mapping reads — it accepted nothing, or
 *      the field already had a human value ahead of the enriched path — the score,
 *      band, decision and every rule verdict are identical, the fingerprint
 *      matches the one stored on the record, and this run writes *nothing*.
 *      `greenlightDecision` never changes, so enrichment is never woken. The
 *      chain is one hop long.
 *   2. **When the score does move**, this run writes `greenlightDecision` and
 *      enrichment wakes. Its gap analysis then finds every enrichable field
 *      either freshly cached (the run that just fired filled it) or inside the
 *      unresolved back-off window (it asked and found nothing), requests nothing,
 *      and returns `no_gaps` **before any provider call and before any write**.
 *      No write means no `greenlightEnrichment` change, which means the scorer is
 *      not woken again. The chain is two hops long and costs one key-value read.
 *   3. **The pathological case still terminates.** Even if a later enrichment run
 *      did find a fresh gap, every hop strictly shrinks the set of unfilled
 *      enrichable fields — a field that is sourced becomes fresh, and a field that
 *      is not becomes unresolved — so the chain is bounded by the five entries in
 *      `ENRICHABLE_FIELD_SPECS`, and the monthly spend cap bounds it again from
 *      outside.
 *
 * Guard 2 stays correct throughout: `isGreenlightAuthoredWrite` tests membership
 * of `GREENLIGHT_MANAGED_PERSON_FIELDS`, which this run writes and enrichment
 * does not, so an enrichment write is correctly *not* mistaken for our own and
 * is scored. `__tests__/enrich-score-cycle.test.ts` drives the whole loop against
 * both runs and asserts it settles rather than trusting this comment.
 */
export const SCORING_TRIGGER_PERSON_FIELDS: readonly string[] = [
  'name',
  'emails',
  'phones',
  'jobTitle',
  'linkedinLink',
  'company',
  'companyId',
  // The enriched-value blob. See "The enrichment exception" above — this is a
  // scoring input, and the cycle it closes is bounded and proved by test.
  'greenlightEnrichment',
  ...SUPPRESSION_SCORING_INPUT_FIELDS,
];

/** `Person.greenlightDecision` / `GreenlightAuditLog.decision` SELECT values. */
export type DecisionValue = 'PASS' | 'GATE' | 'BLOCKED' | 'UNSCORED';

/** `GreenlightAuditLog.eventType` SELECT values used by the scoring path. */
type AuditEventType = 'SCORED' | 'GATED' | 'SKIPPED' | 'ERROR';

/* -------------------------------------------------------------------------- */
/* Guards                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * True when an update event carries nothing but fields Greenlight itself wrote.
 *
 * An empty or absent `updatedFields` returns false: "we do not know what
 * changed" must mean "score it", because the alternative is silently skipping a
 * real edit. Over-scoring is harmless — guard 3 makes the redundant run a no-op.
 */
export const isGreenlightAuthoredWrite = (
  updatedFields: unknown,
): boolean => {
  if (!Array.isArray(updatedFields) || updatedFields.length === 0) {
    return false;
  }

  return updatedFields.every(
    (field) =>
      typeof field === 'string' &&
      GREENLIGHT_MANAGED_PERSON_FIELDS.includes(field),
  );
};

/* -------------------------------------------------------------------------- */
/* Result -> CRM vocabulary                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Map the engine's four-valued decision onto the SELECT the schema ships.
 *
 * The mapping is now one-to-one: `greenlightDecision` carries a `BLOCKED` option
 * of its own (see `src/fields/greenlight-decision.field.ts`), so a compliance
 * stop is no longer indistinguishable from a low score. Before that option
 * existed `blocked` collapsed onto `GATE` and every consumer had to
 * reverse-engineer the difference out of `greenlightTrace`.
 *
 * When the gate is switched off, `gated` is downgraded to `PASS` per the
 * `isGateEnabled` field's contract ("nothing is held for review"). `blocked` is
 * **not** downgraded: that state only arises from a compliance stop such as an
 * opt-out, and quietly marking an opted-out contact as ready to call is not a
 * behaviour any switch on a settings page should be able to buy.
 */
export const toDecisionValue = (
  decision: GateDecision,
  gateEnabled: boolean,
): DecisionValue => {
  switch (decision) {
    case 'approved':
      return 'PASS';
    case 'gated':
      return gateEnabled ? 'GATE' : 'PASS';
    case 'blocked':
      return 'BLOCKED';
    default:
      return 'UNSCORED';
  }
};

/** The decision values that mean "this lead is being held from a rep". */
const HOLDING_DECISIONS: readonly DecisionValue[] = ['GATE', 'BLOCKED'];

const KNOWN_BAND_VALUES: readonly string[] = [
  'EXCELLENT',
  'GOOD',
  'FAIR',
  'POOR',
];

/**
 * Band ids are configurable, so an unrecognised one has to degrade rather than
 * be written into a SELECT that would reject it.
 */
export const toBandValue = (result: ScoringResult): string => {
  const id = result.band?.id;

  if (typeof id !== 'string') {
    return 'UNSCORED';
  }

  const value = id.trim().toUpperCase();

  return KNOWN_BAND_VALUES.includes(value) ? value : 'UNSCORED';
};

export const toAuditEventType = (
  decision: DecisionValue,
  result: ScoringResult,
): AuditEventType => {
  if (result.decision === 'unscored') {
    return 'SKIPPED';
  }

  // GATED covers both holding states. The audit log's `eventType` vocabulary is
  // about what happened to the lead — it was held — and the row's `decision`
  // column already says which of the two states it was held in.
  return HOLDING_DECISIONS.includes(decision) ? 'GATED' : 'SCORED';
};

/* -------------------------------------------------------------------------- */
/* Fingerprint + trace id                                                      */
/* -------------------------------------------------------------------------- */

/** FNV-1a, 32-bit. Short, dependency-free, and stable across Node versions. */
const hash32 = (input: string): string => {
  let hash = 0x811c9dc5;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, '0');
};

/**
 * A stable digest of everything about a run that a human would call "the
 * outcome": the score, the decision, the band, and the verdict of every rule.
 *
 * Explicitly excludes `scoredAt`, the trace prose and the degradation list, so
 * re-scoring an untouched lead a day later produces the same fingerprint and
 * writes nothing.
 */
export const fingerprintOutcome = (
  result: ScoringResult,
  decisionValue: string,
): string => {
  const parts = [
    result.engineVersion,
    decisionValue,
    result.score === null ? 'null' : result.score.toFixed(1),
    result.band?.id ?? 'none',
    result.gateThreshold.toString(),
    ...result.trace.map(
      (entry) => `${entry.ruleId}:${entry.outcome}:${entry.credit.toFixed(3)}`,
    ),
  ];

  return hash32(parts.join('|'));
};

/**
 * Deterministic per (lead, outcome). A retry that re-writes the same decision
 * reuses the id, so duplicate audit rows are recognisable as one run rather than
 * looking like the gate flip-flopped.
 */
export const buildTraceId = (
  leadRecordId: string,
  fingerprint: string,
): string => `gl-${hash32(leadRecordId)}-${fingerprint}`;

/** The fingerprint already stored on the Person, if any. */
export const readStoredFingerprint = (trace: unknown): string | null => {
  if (!isPlainRecord(trace)) {
    return null;
  }

  const value = trace['fingerprint'];

  return typeof value === 'string' && value.length > 0 ? value : null;
};

/* -------------------------------------------------------------------------- */
/* Display helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Person.name is a FULL_NAME composite. Fall back to email, then to the id. */
export const readLeadDisplayName = (person: unknown): string => {
  if (!isPlainRecord(person)) {
    return 'Unknown lead';
  }

  const name = person['name'];

  if (isPlainRecord(name)) {
    const parts = [name['firstName'], name['lastName']]
      .filter((part): part is string => typeof part === 'string')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    if (parts.length > 0) {
      return parts.join(' ');
    }
  }

  if (typeof name === 'string' && name.trim().length > 0) {
    return name.trim();
  }

  const emails = person['emails'];

  if (isPlainRecord(emails)) {
    const primary = emails['primaryEmail'];

    if (typeof primary === 'string' && primary.trim().length > 0) {
      return primary.trim();
    }
  }

  const id = person['id'];

  return typeof id === 'string' ? id : 'Unknown lead';
};

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The slice of app key-value storage this run needs, as a port.
 *
 * `kv` is only importable from `twenty-sdk/logic-function`, and this module is
 * deliberately SDK-free so it can be driven by a fake in tests — the same reason
 * `GreenlightApiClient` exists. `src/logic-functions/release-marker-store.ts`
 * holds the one real implementation.
 *
 * It is a *required* input rather than an optional one on purpose. A run without
 * a store silently re-gates every released lead, which is exactly the bug this
 * port exists to close; making it required means the compiler, not a reviewer,
 * catches a registration that forgot to wire it.
 */
export interface ReleaseMarkerStore {
  get(key: string): Promise<ReleaseMarker | null>;
  delete(key: string): Promise<void>;
}

/**
 * A config record the caller has already read, so the run does not read it again.
 *
 * Wrapped in an object rather than passed as `Record | null` because `null` is a
 * *legitimate answer* here — it means "this workspace has no config record, score
 * on the engine's defaults" — and would otherwise be indistinguishable from "the
 * caller did not supply one". The wrapper makes absent and empty different types
 * instead of different values.
 *
 * It exists for the backfill (`src/logic-functions/backfill-run.ts`), which scores
 * thirty records per cron tick against one config that cannot change between
 * them. Reading it per record would treble the run's share of the rate limit —
 * 30 requests a minute buying thirty identical answers — and would be the single
 * largest cost in a bulk pass.
 *
 * Optional on purpose: the two event registrations pass nothing and keep the
 * exact behaviour they had, which is what makes this an additive change rather
 * than a rewrite of the hot path.
 */
export interface PreloadedConfig {
  readonly record: Record<string, unknown> | null;
}

export interface ScoringRunInput {
  readonly client: GreenlightApiClient;
  /** The `DatabaseEventPayload` as delivered, untyped on purpose. */
  readonly event: unknown;
  readonly now: Date;
  readonly markers: ReleaseMarkerStore;
  /** Omitted by the event registrations; supplied by the bulk backfill. */
  readonly config?: PreloadedConfig;
  /**
   * Read-only access to the licence-delivered calibration cache.
   *
   * Optional, and its absence means "shipped defaults" — the same outcome as an
   * unlicensed workspace, an expired cache, or a payload whose signature did not
   * verify. That is what makes this additive: every existing caller that does
   * not pass it keeps its exact previous behaviour, and the compiler does not
   * have to be trusted on the point because there is nothing to break.
   */
  readonly calibration?: CalibrationReaderPort | null;
  /**
   * Checks that the cached calibration belongs to this workspace's licence key.
   *
   * Defaults to `NO_SEAL`, which accepts nothing — so a caller that wires the
   * reader but forgets the seal gets shipped defaults rather than an unchecked
   * cache. See `src/calibration/seal.ts` for what the seal does and does not
   * prove.
   */
  readonly calibrationSeal?: CalibrationSealPort;
}

export type ScoringRunOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'unchanged'; leadRecordId: string; fingerprint: string }
  | {
      status: 'scored';
      leadRecordId: string;
      traceId: string;
      decision: string;
      score: number | null;
    }
  | { status: 'failed'; leadRecordId: string | null; error: string };

const readEventRecord = (event: unknown): Record<string, unknown> | null => {
  if (!isPlainRecord(event)) {
    return null;
  }

  const properties = event['properties'];

  if (!isPlainRecord(properties)) {
    return null;
  }

  const after = properties['after'];

  return isPlainRecord(after) ? after : null;
};

const readEventUpdatedFields = (event: unknown): unknown => {
  if (!isPlainRecord(event)) {
    return undefined;
  }

  const properties = event['properties'];

  return isPlainRecord(properties) ? properties['updatedFields'] : undefined;
};

const readRecordId = (
  event: unknown,
  record: Record<string, unknown> | null,
): string | null => {
  if (isPlainRecord(event) && typeof event['recordId'] === 'string') {
    return event['recordId'];
  }

  if (record !== null && typeof record['id'] === 'string') {
    return record['id'];
  }

  return null;
};

/** Load the single config record. Absent or unreadable yields `null`. */
export const loadConfigRecord = async (
  client: GreenlightApiClient,
): Promise<Record<string, unknown> | null> => {
  const response = await client.query({
    greenlightConfigs: { edges: { node: greenlightConfigSelection() } },
  });

  return oldestByCreatedAt(readConnectionNodes(response, 'greenlightConfigs'));
};

/**
 * Best-effort company hydration.
 *
 * `event.properties.after` carries the Person's own columns and the company
 * foreign key, but not the company's name — and "which company does this lead
 * work for" is a rule worth 10 points. One extra read buys it. If the read
 * fails for any reason the lead is scored without it, because a lead scored
 * slightly low is recoverable and a lead not scored at all is not.
 *
 * The company selection must stay in lockstep with `backfillPersonSelection`'s
 * `company` entry: a record scored here and the same record scored by the
 * backfill must see the same fields, or the same lead scores differently
 * depending on which path touched it. `industry`, `country` and `employeeCount`
 * are the firmographics the ICP rules and the exclusion gate read through the
 * `company.*` field-mapping candidates — a Twenty workspace keeps them on
 * Company, so without them in the selection those rules can never see values
 * the record actually holds. On a schema without the columns the selection
 * degrades exactly as `id`/`name` would: Twenty does not validate selection
 * sets, and the absent columns come back `null`.
 */
const hydrateCompany = async (
  client: GreenlightApiClient,
  person: Record<string, unknown>,
): Promise<Record<string, unknown>> => {
  const companyId = person['companyId'];

  if (typeof companyId !== 'string' || companyId.length === 0) {
    return person;
  }

  if (isPlainRecord(person['company'])) {
    return person;
  }

  try {
    const response = await client.query({
      companies: {
        __args: { filter: { id: { eq: companyId } } },
        edges: {
          node: {
            id: true,
            name: true,
            industry: true,
            country: true,
            employeeCount: true,
          },
        },
      },
    });

    const [company] = readConnectionNodes(response, 'companies');

    return company === undefined ? person : { ...person, company };
  } catch (error) {
    logGreenlight('company_hydration_failed', {
      companyId,
      error: describeError(error),
    });

    return person;
  }
};

/* -------------------------------------------------------------------------- */
/* The human override                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The object name the release marker is keyed on.
 *
 * Hard-coded rather than taken from the config's `leadObjectNameSingular`
 * because the override can only ever write a `person` key —
 * `SUPPORTED_LEAD_OBJECTS` in `release-decision.ts` has one entry, and both
 * scoring registrations are bound to `person.*` events. Deriving the key from
 * configuration would mean a workspace that renamed its lead object silently
 * looked up a key the release side never writes, which is the same silent
 * self-undoing override this whole mechanism exists to prevent.
 */
const RELEASE_MARKER_OBJECT = 'person';

/**
 * A compliance stop, using the exact discriminator `src/scoring/engine.ts` uses
 * to choose `blocked` — checked from the trace as well as the decision so a
 * blocking failure is still recognised if the engine ever reports the two
 * inconsistently.
 */
const hasBlockingFailure = (result: ScoringResult): boolean =>
  result.decision === 'blocked' ||
  result.trace.some(
    (entry) => entry.severity === 'blocking' && entry.outcome === 'fail',
  );

interface ReleasePin {
  /** The decision to actually write. */
  readonly decision: DecisionValue;
  /** Non-null only when a marker was honoured and the decision was pinned. */
  readonly honoured: ReleaseMarker | null;
}

/**
 * Honour a human release when re-scoring would otherwise hold the lead again.
 *
 * The contract with `release-lead.logic-function.ts`: if a release marker
 * exists, the score and the trace still update freely, but `greenlightDecision`
 * stays at `PASS`. Three things are worth being explicit about.
 *
 * **A newly blocking compliance failure outranks the release.** The marker is
 * deleted and the lead is re-held. "Newly" needs no timestamp comparison: the
 * override refuses to release a compliance-blocked lead at all
 * (`ALLOW_COMPLIANCE_OVERRIDE === false`) and writes no marker when it refuses,
 * so any marker that exists was written for a lead that was *not* blocked at
 * release time. A blocking failure seen now is therefore newer by construction.
 *
 * **A failed key-value read re-gates rather than releases.** Falling back to
 * "no marker" means a released lead can be wrongly held for a moment — an
 * annoyance a human fixes by releasing it again, with the whole trail recording
 * what happened. The opposite fallback, treating an unreadable store as "a
 * marker probably exists", would let a storage outage quietly release leads the
 * gate is holding, including leads held on compliance grounds. That is not
 * recoverable by a human, because nobody knows it happened. The failure is
 * logged rather than swallowed, under `release_marker_read_failed`.
 *
 * **A failed delete is self-correcting.** If the marker survives a re-gating
 * compliance failure, the *next* run re-evaluates the same blocking rule and
 * re-holds the lead again — a stale marker only ever wins once the compliance
 * failure has genuinely gone away, which is the state a release should win in.
 */
const pinReleasedDecision = async (
  markers: ReleaseMarkerStore,
  leadRecordId: string,
  decisionValue: DecisionValue,
  result: ScoringResult,
): Promise<ReleasePin> => {
  if (!HOLDING_DECISIONS.includes(decisionValue)) {
    // Nothing is being held, so there is nothing to pin and no reason to spend
    // a read. A marker left behind by an earlier release is harmless: it is only
    // ever consulted on a run that would hold the lead.
    return { decision: decisionValue, honoured: null };
  }

  const key = releaseMarkerKey(RELEASE_MARKER_OBJECT, leadRecordId);

  let marker: ReleaseMarker | null = null;

  try {
    marker = await markers.get(key);
  } catch (error) {
    logGreenlight('release_marker_read_failed', {
      leadRecordId,
      decision: decisionValue,
      error: describeError(error),
    });

    return { decision: decisionValue, honoured: null };
  }

  if (marker === null) {
    return { decision: decisionValue, honoured: null };
  }

  if (hasBlockingFailure(result)) {
    try {
      await markers.delete(key);
    } catch (error) {
      logGreenlight('release_marker_delete_failed', {
        leadRecordId,
        error: describeError(error),
      });
    }

    logGreenlight('release_marker_overruled', {
      leadRecordId,
      decision: decisionValue,
      releasedAt: marker.releasedAt,
    });

    return { decision: decisionValue, honoured: null };
  }

  return { decision: 'PASS', honoured: marker };
};

const buildTracePayload = (
  result: ScoringResult,
  traceId: string,
  fingerprint: string,
  decisionValue: string,
  bandValue: string,
  releaseOverride: Record<string, unknown> | null,
  /**
   * Which calibration produced this score, or `null` for shipped defaults.
   *
   * Recorded on the lead itself rather than only in the admin panel, because
   * "why did this lead score 68 last week and 82 today" is a question asked
   * about one record months later, and the panel only ever shows *now*. It is
   * the version number and nothing else — the payload is a few hundred
   * kilobytes of word lists and does not belong on every Person row.
   */
  calibrationVersion: number | null,
): Record<string, unknown> => ({
  calibration:
    calibrationVersion === null
      ? { source: 'shipped_defaults' }
      : { source: 'licensed', version: calibrationVersion },
  traceId,
  fingerprint,
  engineVersion: result.engineVersion,
  scoredAt: result.scoredAt,
  score: result.score,
  band: bandValue,
  decision: decisionValue,
  gateThreshold: result.gateThreshold,
  summary: result.summary,
  reasons: [...result.reasons],
  configSource: result.configSource,
  degradations: result.degradations.map((entry) => ({ ...entry })),
  rules: result.trace.map((entry) => ({ ...entry })),
  // Present only on a pinned run. Without it the trace would show a lead
  // scoring 12 against a threshold of 40 sitting at PASS with nothing on the
  // record explaining why, which is the same silence the marker exists to fix.
  ...(releaseOverride === null ? {} : { releaseOverride }),
});

/**
 * Score one Person event end to end.
 *
 * Never throws. Every failure path returns a `failed` outcome after making a
 * best-effort attempt to leave the lead flagged `UNSCORED` with an ERROR audit
 * row — ARCHITECTURE.md's golden rule is that a lead is never blocked from
 * reaching a rep, so a broken run must leave a visible, explained record rather
 * than a silent gap.
 */
/**
 * Read the cached calibration and reduce it to the vocabulary baseline the
 * engine accepts.
 *
 * Never throws and never blocks: a store that errors, a cache that is absent
 * (which is also what a lapsed entitlement leaves behind — the nightly run
 * clears it), and a payload that has aged past 72 hours all return `null`,
 * which resolves to the in-source defaults. There is no branch here that can
 * stop a lead being scored, and there is deliberately no way to write one — the
 * port has no method but `read`.
 *
 * No licence state is consulted. That is not an omission: see
 * `src/calibration/state.ts`, "Why there is no entitlement check here".
 */
interface AppliedCalibration {
  readonly baseline: ReturnType<typeof toScoringBaseline>;
  readonly version: number;
}

/**
 * Return the entry only if its seal verifies under this workspace's licence key.
 *
 * A failure is logged once and reported as `null`, i.e. as "no calibration",
 * which is the shipped-defaults path. It is deliberately not an error: a cache
 * that fails its seal is most often a licence key that was changed, and a rep
 * scoring a lead is not the person to tell about it. The nightly run rewrites a
 * correctly-sealed entry and the condition clears itself.
 */
const verifySeal = async (
  stored: Awaited<ReturnType<CalibrationReaderPort['read']>>,
  seal: CalibrationSealPort,
): Promise<typeof stored> => {
  if (stored === null) {
    return null;
  }

  const canonical = sealedCalibrationBody(stored);

  if (canonical === null) {
    return null;
  }

  const sealed = await seal.verify(canonical, stored.sealTag);

  if (!sealed) {
    logGreenlight('calibration_cache_seal_mismatch', {
      calibrationVersion: stored.calibration.calibrationVersion,
      keyId: stored.keyId,
    });

    return null;
  }

  return stored;
};

const readCalibrationBaseline = async (
  calibration: CalibrationReaderPort | null | undefined,
  seal: CalibrationSealPort,
  now: Date,
): Promise<AppliedCalibration | null> => {
  if (calibration === null || calibration === undefined) {
    return null;
  }

  try {
    const stored = await calibration.read();

    // The seal is checked before the freshness ladder, not after. A cache
    // lifted from another workspace should be refused on the grounds that it is
    // not ours, whatever its age — and checking age first would mean a stolen
    // cache and an expired one produce the same reason in the log, which is the
    // one distinction worth keeping here.
    const cached = await verifySeal(stored, seal);

    const resolved = resolveCalibration({ cached, now });

    return resolved.calibration === null
      ? null
      : {
          baseline: toScoringBaseline(resolved.calibration),
          version: resolved.calibration.calibrationVersion,
        };
  } catch (error) {
    logGreenlight('calibration_read_failed', { error: describeError(error) });

    return null;
  }
};

export const runPersonScoring = async ({
  client,
  event,
  now,
  markers,
  config,
  calibration,
  calibrationSeal = NO_SEAL,
}: ScoringRunInput): Promise<ScoringRunOutcome> => {
  const person = readEventRecord(event);
  const leadRecordId = readRecordId(event, person);

  // Guard 2. Runs before anything else so a Greenlight-authored write costs one
  // array scan, not two API round trips.
  if (isGreenlightAuthoredWrite(readEventUpdatedFields(event))) {
    return { status: 'skipped', reason: 'greenlight_authored_write' };
  }

  if (person === null || leadRecordId === null) {
    logGreenlight('event_unreadable', { leadRecordId });

    return { status: 'skipped', reason: 'event_unreadable' };
  }

  try {
    // A supplied config is used as-is, including a supplied `null`. Only an
    // absent wrapper triggers the read — see `PreloadedConfig`.
    const configRecord =
      config === undefined ? await loadConfigRecord(client) : config.record;
    const gateEnabled = isGateEnabled(configRecord);
    const leadObjectNameSingular = readLeadObjectNameSingular(configRecord);

    const hydrated = await hydrateCompany(client, person);

    const applied = await readCalibrationBaseline(
      calibration,
      calibrationSeal,
      now,
    );

    // `scoreLead` never throws and repairs anything unusable in the config, so
    // a missing record needs no special case here — it becomes `configSource:
    // 'defaults'` and a degradation entry in the trace. A `null` baseline is
    // likewise not a special case: it is what the parameter means when there is
    // no calibration, and it scores identically to the build that predates it.
    const result = scoreLead({
      lead: toLeadRecord(hydrated),
      now,
      config: toScoringConfigInput(configRecord),
      baseline: applied?.baseline ?? null,
    });

    const engineDecision = toDecisionValue(result.decision, gateEnabled);
    const pin = await pinReleasedDecision(
      markers,
      leadRecordId,
      engineDecision,
      result,
    );
    const decisionValue = pin.decision;
    const bandValue = toBandValue(result);

    // The fingerprint is taken over the decision actually written, not the one
    // the engine proposed. That keeps guard 3 honest in both directions: the
    // first pinned run differs from the stored GATE fingerprint and writes, and
    // every identical pinned run afterwards matches and writes nothing. A
    // fingerprint over `engineDecision` would record a decision the record does
    // not carry.
    const fingerprint = fingerprintOutcome(result, decisionValue);

    // Guard 3.
    if (readStoredFingerprint(person['greenlightTrace']) === fingerprint) {
      return { status: 'unchanged', leadRecordId, fingerprint };
    }

    const traceId = buildTraceId(leadRecordId, fingerprint);
    const leadDisplayName = readLeadDisplayName(person);
    const eventType = toAuditEventType(decisionValue, result);
    const tracePayload = buildTracePayload(
      result,
      traceId,
      fingerprint,
      decisionValue,
      bandValue,
      pin.honoured === null
        ? null
        : {
            engineDecision,
            releasedAt: pin.honoured.releasedAt,
            releasedBy: pin.honoured.releasedBy,
            reasonCode: pin.honoured.reasonCode,
          },
      applied?.version ?? null,
    );
    // A pinned run is still a SYSTEM action — the system honouring a human
    // decision taken earlier — so `actorType` stays SYSTEM and the human's
    // fingerprints go in the reason, where the audit log already looks for them.
    const overrideReason =
      pin.honoured === null
        ? ''
        : `RELEASE_MARKER_HONOURED — engine decision ${engineDecision} held at PASS by the release recorded ${pin.honoured.releasedAt} (${pin.honoured.releasedBy}, ${pin.honoured.reasonCode})`;

    // Audit row first, Person second — and the order is load-bearing.
    //
    // If the audit write succeeds and the Person write fails, the next event
    // re-scores, finds the stored fingerprint still absent, and writes both
    // again: the trail over-records. If the order were reversed, the Person
    // would carry the new fingerprint, guard 3 would suppress every subsequent
    // run, and the decision would never be recorded at all. An append-only
    // trail is allowed to repeat itself; it is not allowed to lose an entry.
    await client.mutation({
      createGreenlightAuditLog: {
        __args: {
          data: {
            name: `${eventType} · ${leadDisplayName} · ${result.score ?? '—'}`,
            eventType,
            occurredAt: now.toISOString(),
            leadObjectNameSingular,
            leadRecordId,
            leadDisplayName,
            actorType: 'SYSTEM',
            actorDisplayName: `Greenlight engine ${SCORING_ENGINE_VERSION}`,
            ruleTrace: tracePayload,
            score: result.score,
            band: bandValue,
            decision: decisionValue,
            overrideReason,
            traceId,
          },
        },
        id: true,
      },
    });

    await client.mutation({
      updatePerson: {
        __args: {
          id: leadRecordId,
          data: {
            greenlightScore: result.score,
            greenlightDecision: decisionValue,
            greenlightTrace: tracePayload,
          },
        },
        id: true,
      },
    });

    logGreenlight('lead_scored', {
      leadRecordId,
      traceId,
      score: result.score,
      band: bandValue,
      decision: decisionValue,
      engineDecision,
      releasePinned: pin.honoured !== null,
      configSource: result.configSource,
      calibrationVersion: applied?.version ?? null,
      degradations: result.degradations.length,
    });

    return {
      status: 'scored',
      leadRecordId,
      traceId,
      decision: decisionValue,
      score: result.score,
    };
  } catch (error) {
    const message = describeError(error);

    logGreenlight('scoring_failed', { leadRecordId, error: message });

    await flagUnscored(client, leadRecordId, person, now, message);

    return { status: 'failed', leadRecordId, error: message };
  }
};

/**
 * Last-ditch fail-open write. Each half is independently guarded: a lead left
 * with no flag is bad, a logic function that throws out to the platform because
 * its error handler also failed is worse.
 */
const flagUnscored = async (
  client: GreenlightApiClient,
  leadRecordId: string,
  person: Record<string, unknown>,
  now: Date,
  error: string,
): Promise<void> => {
  const traceId = buildTraceId(leadRecordId, hash32(error));
  const leadDisplayName = readLeadDisplayName(person);

  const tracePayload = {
    traceId,
    // No fingerprint: an errored run must not suppress the next attempt.
    engineVersion: SCORING_ENGINE_VERSION,
    scoredAt: now.toISOString(),
    score: null,
    band: 'UNSCORED',
    decision: 'UNSCORED',
    summary:
      'Greenlight could not score this lead. It has been passed through unscored and flagged for review.',
    reasons: [error],
    rules: [],
  };

  try {
    await client.mutation({
      createGreenlightAuditLog: {
        __args: {
          data: {
            name: `ERROR · ${leadDisplayName} · —`,
            eventType: 'ERROR',
            occurredAt: now.toISOString(),
            leadObjectNameSingular: 'person',
            leadRecordId,
            leadDisplayName,
            actorType: 'SYSTEM',
            actorDisplayName: `Greenlight engine ${SCORING_ENGINE_VERSION}`,
            ruleTrace: tracePayload,
            score: null,
            band: 'UNSCORED',
            decision: 'UNSCORED',
            overrideReason: '',
            traceId,
          },
        },
        id: true,
      },
    });
  } catch (auditError) {
    logGreenlight('fail_open_audit_write_failed', {
      leadRecordId,
      error: describeError(auditError),
    });
  }

  try {
    await client.mutation({
      updatePerson: {
        __args: {
          id: leadRecordId,
          data: {
            greenlightDecision: 'UNSCORED',
            greenlightTrace: tracePayload,
          },
        },
        id: true,
      },
    });
  } catch (updateError) {
    logGreenlight('fail_open_person_write_failed', {
      leadRecordId,
      error: describeError(updateError),
    });
  }
};
