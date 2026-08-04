/**
 * Numaya Greenlight — the decision half of the human override.
 *
 * Everything in this file is pure: no SDK import, no network, no clock read.
 * The logic function is a thin shell that fetches state, calls `decideRelease`,
 * and executes whatever it is told. That split exists because the override is
 * the GDPR Art. 22 load-bearing part of the product — the rules about what may
 * and may not be released have to be exhaustively testable without a live
 * Twenty workspace.
 *
 * Naming note: the engine's four decision states (`approved` / `gated` /
 * `blocked` / `unscored`, see `src/scoring/types.ts`) now map one-to-one onto
 * the `greenlightDecision` SELECT field on Person, which ships four options
 * (`PASS` / `GATE` / `BLOCKED` / `UNSCORED`). A compliance stop is therefore
 * readable straight off the field. Records scored before the `BLOCKED` option
 * existed still read `GATE`, so `isComplianceBlocked` survives as a fallback —
 * see the comment on `blockedFromLead` for exactly when each one answers.
 */

/* -------------------------------------------------------------------------- */
/* The compliance question                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Whether a lead that the engine marked `blocked` may be released by a human.
 *
 * **True — product decision, 2026-08-02.** The opt-out register is maintained by
 * the sales team inside Twenty, and the business trusts the person maintaining
 * it to also be the person who corrects it. An earlier iteration refused this
 * and required the contact to re-consent by email; that was withdrawn, because
 * Twenty sends no email and building an outbound provider to gate a correction
 * the sales team is trusted to make anyway is disproportionate.
 *
 * What this restores: the golden rule in `ARCHITECTURE.md` and the promise in
 * `PRODUCT_SPEC.md` that a human can always release a held lead, with no
 * exception carved out for compliance.
 *
 * What it costs, stated plainly rather than buried:
 *
 *   1. A released compliance block leaves the record in a **contradictory
 *      state** — `greenlightDecision` says the lead is cleared while the
 *      suppression fields still say do-not-contact. The audit row is the only
 *      thing that explains it. Prefer clearing the suppression itself ("Allow
 *      contact again") when the block was recorded in error: that re-scores the
 *      lead and clears the gate through the data, which reads far better in a
 *      DPA conversation than an override sitting on top of a live opt-out.
 *   2. Under GDPR Art. 21(3) an objection to direct marketing is absolute, and
 *      "a salesperson approved it" is not a lawful basis on its own. This
 *      setting assumes the release reflects a real-world correction — the
 *      contact never opted out, or asked to be added back — not a decision to
 *      market to someone who said stop. That assumption is the customer's to
 *      hold, and every release is audited with who, when and why so it can be
 *      evidenced.
 *
 * Setting this back to `false` re-refuses compliance releases; the refusal
 * branch and its tests are the only readers.
 */
export const ALLOW_COMPLIANCE_OVERRIDE = true;

/* -------------------------------------------------------------------------- */
/* Reasons                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The override reason is a **mandatory choice from a closed list**, plus an
 * optional free-text note.
 *
 * `ARCHITECTURE.md` leaves this as "reason/none". Neither extreme works:
 *
 *   - Optional reason. The whole Art. 22 argument is that a human applied
 *     judgement. An override with no recorded reason is indistinguishable in
 *     the audit trail from an automated release, so it evidences nothing.
 *
 *   - Mandatory free text. A required text box gets "ok" typed into it, which
 *     is worse than nothing: it manufactures the appearance of a reasoned
 *     decision without the substance, and it is unanalysable in aggregate. It
 *     is also a data-protection liability in its own right — an uncontrolled
 *     free-text field on an append-only log that nobody ever deletes is exactly
 *     where a rep eventually types something that should never have been
 *     recorded about a person.
 *
 * A required pick from five categories is a real judgement, cheap to make,
 * impossible to fake into meaninglessness, and analysable: 200 releases tagged
 * `ICP_TOO_NARROW` are not 200 judgement calls, they are one misconfigured ICP,
 * and the queue can say so. The optional note carries the specifics when there
 * are any.
 */
export const RELEASE_REASONS = [
  {
    code: 'ICP_TOO_NARROW',
    label: 'Scoring rules are too narrow for this lead',
    hint: 'The lead is fine; the ICP or rule configuration is what is wrong.',
  },
  {
    code: 'DATA_INCOMPLETE',
    label: 'Lead data is incomplete but I know this is a good lead',
    hint: 'Missing fields dragged the score down. You have the context the record does not.',
  },
  {
    code: 'KNOWN_ACCOUNT',
    label: 'Existing relationship or inbound request',
    hint: 'They asked us to get in touch, or there is a live thread already.',
  },
  {
    code: 'STRATEGIC_EXCEPTION',
    label: 'Deliberate exception I am accounting for',
    hint: 'The gate is right and you are overriding it anyway, on purpose.',
  },
  {
    code: 'TESTING',
    label: 'Testing Greenlight',
    hint: 'Keeps test releases out of the real override statistics.',
  },
] as const;

export type ReleaseReasonCode = (typeof RELEASE_REASONS)[number]['code'];

export const RELEASE_REASON_CODES: readonly ReleaseReasonCode[] =
  RELEASE_REASONS.map((reason) => reason.code);

/** Free-text notes are capped: an audit field is not a place to write an essay. */
export const MAX_REASON_NOTE_LENGTH = 500;

const findReason = (code: string) =>
  RELEASE_REASONS.find((reason) => reason.code === code) ?? null;

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

export interface ReleaseRequest {
  readonly leadObjectNameSingular: string;
  readonly recordId: string;
  readonly reasonCode: ReleaseReasonCode;
  /** Empty string when the reviewer did not add one. */
  readonly reasonNote: string;
}

export type ParseResult =
  | { readonly ok: true; readonly request: ReleaseRequest }
  | { readonly ok: false; readonly message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * v0.1 physically ships the score fields on Person only (`defineField` binds at
 * build time — see `greenlight-score.field.ts`). Accepting any other object name
 * would mean writing `greenlightDecision` to an object that does not have it.
 * The parameter exists so the Layer 3 seam is visible in the wire format, not
 * because it is configurable yet.
 */
export const SUPPORTED_LEAD_OBJECTS: readonly string[] = ['person'];

const asString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseReleaseRequest = (body: unknown): ParseResult => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, message: 'Release request body must be an object.' };
  }

  const raw = body as Record<string, unknown>;

  const recordId = asString(raw['recordId'])?.trim() ?? '';

  if (!UUID.test(recordId)) {
    return { ok: false, message: 'Release request needs a valid recordId.' };
  }

  const leadObjectNameSingular =
    asString(raw['leadObjectNameSingular'])?.trim() || 'person';

  if (!SUPPORTED_LEAD_OBJECTS.includes(leadObjectNameSingular)) {
    return {
      ok: false,
      message: `Greenlight v0.1 can only release leads on ${SUPPORTED_LEAD_OBJECTS.join(', ')}, not ${leadObjectNameSingular}.`,
    };
  }

  const reasonCode = asString(raw['reasonCode'])?.trim() ?? '';
  const reason = findReason(reasonCode);

  if (reason === null) {
    return {
      ok: false,
      message:
        'Choose why you are releasing this lead. A recorded reason is what makes the override a human decision rather than an automated one.',
    };
  }

  const reasonNote = (asString(raw['reasonNote']) ?? '')
    .trim()
    .slice(0, MAX_REASON_NOTE_LENGTH);

  return {
    ok: true,
    request: {
      leadObjectNameSingular,
      recordId,
      reasonCode: reason.code,
      reasonNote,
    },
  };
};

/** The audit-trail rendering of a reason: machine code first, prose after. */
export const formatOverrideReason = (
  reasonCode: ReleaseReasonCode,
  reasonNote: string,
): string => {
  const reason = findReason(reasonCode);
  const label = reason === null ? reasonCode : `${reason.code} · ${reason.label}`;

  return reasonNote === '' ? label : `${label} — ${reasonNote}`;
};

/* -------------------------------------------------------------------------- */
/* Current state of the lead                                                   */
/* -------------------------------------------------------------------------- */

/** Values of the `greenlightDecision` SELECT on Person. */
export const DECISION_PASS = 'PASS';
export const DECISION_GATE = 'GATE';
export const DECISION_BLOCKED = 'BLOCKED';
export const DECISION_UNSCORED = 'UNSCORED';

const KNOWN_DECISIONS: readonly string[] = [
  DECISION_PASS,
  DECISION_GATE,
  DECISION_BLOCKED,
  DECISION_UNSCORED,
];

/** `greenlightDecision` as stored, normalised. Null when it is not a value we ship. */
export const normaliseDecision = (raw: string | null): string | null => {
  const value = raw?.trim().toUpperCase() ?? '';

  return KNOWN_DECISIONS.includes(value) ? value : null;
};

/**
 * The decision an audit row should record as the state the lead was left in.
 *
 * A refused release leaves the lead exactly where it was, and "where it was"
 * is now a distinction worth keeping: a refusal against a `BLOCKED` record and
 * a refusal against a `GATE` record are different compliance stories. Anything
 * unrecognised degrades to `GATE` rather than being written through, because
 * this value goes into a SELECT that would reject an unknown option and lose
 * the row.
 */
export const auditDecisionValue = (
  currentDecision: string | null,
  shouldClearGate: boolean,
): string =>
  shouldClearGate
    ? DECISION_PASS
    : (normaliseDecision(currentDecision) ?? DECISION_GATE);

/** Values of the `band` SELECT on GreenlightAuditLog. */
export const BAND_UNSCORED = 'UNSCORED';

const KNOWN_BANDS: readonly string[] = [
  'EXCELLENT',
  'GOOD',
  'FAIR',
  'POOR',
  BAND_UNSCORED,
];

/**
 * The band an override's audit row should record.
 *
 * The release path used to write no band at all, so every `RELEASED` row took
 * the field's `UNSCORED` default while the `GATED` row for the same lead read
 * `POOR`. Two contradictory bands for one lead is not a compliance record, it is
 * a bug with a paper trail — a reviewer comparing the two rows cannot tell which
 * one is lying.
 *
 * The band is **read out of the trace the scoring run left on the record**, not
 * recomputed here. The engine's bands are configurable (`bandExcellentThreshold`
 * and friends on GreenlightConfig), so deriving a band from the score with the
 * shipped defaults would produce a *different* wrong answer in any workspace
 * that moved a threshold — and it would disagree with the `GATED` row all over
 * again. The trace carries the band that run actually chose, which is the only
 * value that can agree with the earlier row by construction.
 *
 * `UNSCORED` remains the answer when the trace is missing or unreadable, but it
 * now means what the option says: nothing here knows the band. That is the state
 * of a lead released before it was ever scored, which the queue does allow.
 */
export const auditBandValue = (trace: unknown): string => {
  if (!isRecord(trace)) {
    return BAND_UNSCORED;
  }

  const value = asString(trace['band'])?.trim().toUpperCase() ?? '';

  return KNOWN_BANDS.includes(value) ? value : BAND_UNSCORED;
};

export interface CurrentLeadState {
  readonly recordId: string;
  /** Denormalised into the audit row so the trail survives the record. */
  readonly displayName: string;
  /** Raw `greenlightDecision`. Null when the lead has never been scored. */
  readonly decision: string | null;
  readonly score: number | null;
  /** Raw `greenlightTrace`, whatever shape the engine wrote. */
  readonly trace: unknown;
}

/**
 * A human release, recorded outside the record so the scoring function can see
 * it. Written to app key-value storage by the override; see the contract note
 * on `RELEASE_MARKER_SCOPE` below.
 */
export interface ReleaseMarker {
  readonly leadObjectNameSingular: string;
  readonly recordId: string;
  /** ISO 8601. */
  readonly releasedAt: string;
  readonly releasedBy: string;
  readonly reasonCode: string;
}

export const releaseMarkerKey = (
  leadObjectNameSingular: string,
  recordId: string,
): string => `greenlight:release:${leadObjectNameSingular}:${recordId}`;

/**
 * Two releases of the same lead inside this window are the same release — a
 * double-click, or Twenty re-delivering the request. Mirrors the 5s event
 * de-duplication window ARCHITECTURE.md § "Idempotency & Retry Safety" already
 * assumes, with headroom for a slow round trip.
 *
 * This is a *narrow race* guard only. The authoritative double-release check is
 * the decision field itself: if the lead already reads PASS it is not held, so
 * there is nothing to release, whatever the marker says. The marker can be
 * stale — a lead released on Monday and legitimately re-gated on Tuesday after
 * its email was deleted must be releasable again on Tuesday.
 */
export const DUPLICATE_RELEASE_WINDOW_MS = 10_000;

/* -------------------------------------------------------------------------- */
/* Compliance block detection                                                  */
/* -------------------------------------------------------------------------- */

const entryIsBlocking = (entry: unknown): boolean => {
  if (!isRecord(entry)) {
    return false;
  }

  const severity = asString(entry['severity'])?.toLowerCase() ?? '';
  const outcome = asString(entry['outcome'])?.toLowerCase() ?? '';

  return severity === 'blocking' && outcome === 'fail';
};

const traceEntries = (trace: unknown): readonly unknown[] => {
  if (Array.isArray(trace)) {
    return trace;
  }

  if (!isRecord(trace)) {
    return [];
  }

  for (const key of ['rules', 'trace', 'entries']) {
    const candidate = trace[key];

    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
};

/**
 * Recover the engine's `blocked` state from the trace.
 *
 * **This is the legacy path.** `greenlightDecision` now ships a `BLOCKED`
 * option, so a lead scored by any current build states its compliance stop on
 * the field itself and never reaches this function. It is kept because nothing
 * backfills a SELECT option: every lead scored before the option existed still
 * reads `GATE`, and reading the trace is the only way to tell those apart. See
 * `blockedFromLead`.
 *
 * **It is the one place the queue depends on a shape the scoring function
 * writes, and it is deliberately forgiving about that shape**, because the trace
 * field's exact envelope is not pinned down anywhere in the spec. Accepted, in
 * order:
 *
 *   - a top-level `decision` of `blocked` (any case) on the trace object;
 *   - an array of rule-trace entries, or `{ rules: [...] }` / `{ trace: [...] }`
 *     / `{ entries: [...] }`, containing an entry with
 *     `severity: 'blocking'` and `outcome: 'fail'` — the exact discriminator
 *     `src/scoring/engine.ts` itself uses to choose `blocked`.
 *
 * If the trace is missing or unreadable the answer is `false`: an unreadable
 * trace must not silently turn every held lead into an unreleasable one. That
 * is the fail-open direction for *this* check, and it is the right one — the
 * compliance rule that produced the block also wrote an audit row, and a lead
 * whose trace we cannot read is a lead we cannot claim anything about.
 */
export const isComplianceBlocked = (trace: unknown): boolean => {
  if (isRecord(trace)) {
    const declared = asString(trace['decision'])?.toLowerCase() ?? '';

    if (declared === 'blocked') {
      return true;
    }
  }

  return traceEntries(trace).some(entryIsBlocking);
};

/**
 * Is this lead held on compliance grounds?
 *
 * Field first, trace second, and the order is the whole point:
 *
 *   - **The field** is the current, cheap, unambiguous answer for anything
 *     scored since `BLOCKED` shipped. One string comparison, no assumptions
 *     about a RAW_JSON envelope.
 *   - **The trace** answers for records scored before that, which still read
 *     `GATE` because adding a SELECT option does not rewrite existing rows.
 *     Dropping this fallback would quietly make every historic opt-out
 *     releasable by hand on the day the option was added — the exact failure the
 *     compliance refusal exists to prevent. It can go once a workspace has
 *     re-scored every lead, which is not something this code can know.
 */
const blockedFromLead = (lead: CurrentLeadState): boolean =>
  normaliseDecision(lead.decision) === DECISION_BLOCKED ||
  isComplianceBlocked(lead.trace);

/* -------------------------------------------------------------------------- */
/* The decision                                                                */
/* -------------------------------------------------------------------------- */

export type ReleaseOutcome =
  /** The gate was cleared and an audit row must be written. */
  | 'released'
  /** Already `PASS`. Not an error — the rep got what they wanted. */
  | 'already_released'
  /** `UNSCORED`: the engine failed open, the lead was never held. */
  | 'not_held'
  /** No decision at all: never scored, so never gated. */
  | 'not_scored'
  /** A second request inside the de-duplication window. */
  | 'duplicate_request'
  /** Compliance stop. See `ALLOW_COMPLIANCE_OVERRIDE`. */
  | 'refused_compliance_block';

export interface ReleaseDecision {
  readonly outcome: ReleaseOutcome;
  /** Shown to the reviewer. Written for a salesperson, not a developer. */
  readonly message: string;
  /** Whether `greenlightDecision` must be written to `PASS`. */
  readonly shouldClearGate: boolean;
  /** Whether a `GreenlightAuditLog` row must be appended. */
  readonly shouldWriteAuditRow: boolean;
  /** `RELEASED` for a real release, `SKIPPED` for a recorded refusal. */
  readonly auditEventType: 'RELEASED' | 'SKIPPED' | null;
  /** Rendered reason for the audit row. Empty when no row is written. */
  readonly overrideReason: string;
  /** Whether the release marker must be written for the scoring function. */
  readonly shouldWriteMarker: boolean;
}

export interface DecideReleaseInput {
  readonly request: ReleaseRequest;
  readonly lead: CurrentLeadState;
  /** Previous release of this lead, if app storage had one. */
  readonly marker: ReleaseMarker | null;
  /** The clock, passed in — this module never reads it. */
  readonly now: Date;
}

const noop = (
  outcome: ReleaseOutcome,
  message: string,
): ReleaseDecision => ({
  outcome,
  message,
  shouldClearGate: false,
  shouldWriteAuditRow: false,
  auditEventType: null,
  overrideReason: '',
  shouldWriteMarker: false,
});

const isWithinDuplicateWindow = (
  marker: ReleaseMarker | null,
  now: Date,
): boolean => {
  if (marker === null) {
    return false;
  }

  const releasedAt = Date.parse(marker.releasedAt);

  if (Number.isNaN(releasedAt)) {
    return false;
  }

  const elapsed = now.getTime() - releasedAt;

  return elapsed >= 0 && elapsed < DUPLICATE_RELEASE_WINDOW_MS;
};

/**
 * Decide what the override should do. Never throws.
 *
 * Order matters and is not arbitrary:
 *
 *   1. **Not held** beats everything. If the gate is already open there is
 *      nothing to release, so we neither write the record nor append an audit
 *      row — a rep double-clicking must not manufacture history. This is the
 *      "safe against releasing something already approved" guarantee, and it is
 *      checked against the record's own field rather than against any cached
 *      marker, because the field is the only authoritative statement of whether
 *      the lead is held right now.
 *   2. **Compliance** beats the reviewer. Read from `greenlightDecision` when it
 *      says `BLOCKED`, and from the trace otherwise so pre-`BLOCKED` records
 *      still refuse (`blockedFromLead`). Checked before the duplicate window so
 *      that every attempt against a blocked lead is recorded, including repeat
 *      attempts — repeated attempts to release an opt-out are exactly the
 *      pattern a DPO would want to see.
 *   3. **Duplicate window** catches the narrow double-submit race that the
 *      field check cannot see, because both requests read `GATE` before either
 *      wrote `PASS`.
 */
export const decideRelease = (input: DecideReleaseInput): ReleaseDecision => {
  const { request, lead, marker, now } = input;

  const decision = lead.decision?.trim().toUpperCase() ?? null;

  if (decision === null || decision === '') {
    return noop(
      'not_scored',
      'This lead has no Greenlight decision yet, so it is not being held. Nothing to release.',
    );
  }

  if (decision === DECISION_PASS) {
    return noop(
      'already_released',
      'This lead has already cleared the gate. No change made, and no second audit entry written.',
    );
  }

  if (decision === DECISION_UNSCORED) {
    return noop(
      'not_held',
      'Greenlight could not score this lead, so it was let through unscored rather than held. There is no gate to clear.',
    );
  }

  if (decision !== DECISION_GATE && decision !== DECISION_BLOCKED) {
    return noop(
      'not_held',
      `This lead is in an unrecognised Greenlight state (${decision}), so the override left it alone.`,
    );
  }

  const blocked = blockedFromLead(lead);

  if (blocked && !ALLOW_COMPLIANCE_OVERRIDE) {
    return {
      outcome: 'refused_compliance_block',
      message:
        'This lead is held on compliance grounds — the record carries a recorded opt-out. That is the contact\'s own instruction, not a scoring judgement, so it cannot be overridden here. Correct the opt-out data on the record if it is wrong; the lead will re-score and clear itself.',
      shouldClearGate: false,
      // The refusal *is* recorded. An attempt to release an opted-out contact
      // is a compliance-relevant human action even though nothing changed.
      shouldWriteAuditRow: true,
      auditEventType: 'SKIPPED',
      overrideReason: `REFUSED_COMPLIANCE_BLOCK — release attempted with reason ${formatOverrideReason(
        request.reasonCode,
        request.reasonNote,
      )}`,
      shouldWriteMarker: false,
    };
  }

  if (isWithinDuplicateWindow(marker, now)) {
    return noop(
      'duplicate_request',
      'This lead was released moments ago. Treating this as a duplicate submission and leaving the audit trail alone.',
    );
  }

  return {
    outcome: 'released',
    message: 'Released. The lead is cleared to work and the override is on record.',
    shouldClearGate: true,
    shouldWriteAuditRow: true,
    auditEventType: 'RELEASED',
    overrideReason: formatOverrideReason(request.reasonCode, request.reasonNote),
    shouldWriteMarker: true,
  };
};

/** One-line summary used as the audit row's record label. */
export const buildAuditSummary = (
  eventType: 'RELEASED' | 'SKIPPED',
  lead: CurrentLeadState,
): string => {
  const name = lead.displayName.trim() === '' ? 'Unnamed lead' : lead.displayName;
  const score = lead.score === null ? 'unscored' : String(lead.score);

  return `${eventType} · ${name} · ${score}`;
};
