/**
 * Numaya Greenlight — the decision half of the suppression / block list.
 *
 * Everything in this file is pure: no SDK import, no network, no clock read.
 * The two logic functions are thin shells that fetch state, call `decideSuppress`
 * or `decideUnsuppress`, and execute whatever they are told. Same split, and the
 * same reason, as `src/gate/release-decision.ts`: this is the part a regulator
 * would read, so it has to be exhaustively testable without a live workspace.
 *
 * ## Why Greenlight owns this data at all
 *
 * Twenty does no email management. There is no unsubscribe handling, no bounce
 * tracking and no do-not-contact list anywhere in the product. Greenlight's
 * compliance rule used to read an opt-out flag purely through the customer's
 * Layer 3 field mapping (`optOutFieldNames`), and on a stock workspace that
 * mapping resolves to nothing at all — so the rule returned `pass`, awarded its
 * full 15 points, and could never once fire. The one compliance check in the
 * product was decorative on a default install.
 *
 * The four `greenlightSuppress*` fields on Person are the fix. They are the
 * register Twenty does not have, they are Greenlight's own, and — unlike the
 * score fields — they are UI-editable, because they are human-maintained data
 * rather than engine output.
 *
 * ## Union, not override
 *
 * A customer who already has an opt-out column keeps it working. The compliance
 * rule reads Greenlight's field *and* the customer's mapping and any source
 * saying "suppressed" wins. Nothing in this file assumes Greenlight's field is
 * the only one; it is only the only one Greenlight can write.
 */

/* -------------------------------------------------------------------------- */
/* The Person fields this feature owns                                         */
/* -------------------------------------------------------------------------- */

/**
 * The suppression columns on the lead-bearing object.
 *
 * Declared here rather than in `scoring-run.ts` because both the scoring side
 * (which must re-score when they change) and the two action logic functions
 * (which write them) need the same strings, and a drift between the two is an
 * infinite loop or a silently ignored block, neither of which shows up in a
 * type error.
 */
export const SUPPRESSION_FIELD_SUPPRESSED = 'greenlightSuppressed';
export const SUPPRESSION_FIELD_REASON = 'greenlightSuppressionReason';
export const SUPPRESSION_FIELD_SUPPRESSED_AT = 'greenlightSuppressedAt';
export const SUPPRESSION_FIELD_NOTE = 'greenlightSuppressionNote';

export const SUPPRESSION_PERSON_FIELDS: readonly string[] = [
  SUPPRESSION_FIELD_SUPPRESSED,
  SUPPRESSION_FIELD_REASON,
  SUPPRESSION_FIELD_SUPPRESSED_AT,
  SUPPRESSION_FIELD_NOTE,
];

/**
 * The subset whose change can move the score, i.e. the ones the re-score trigger
 * listens on.
 *
 * `greenlightSuppressedAt` and `greenlightSuppressionNote` are excluded: neither
 * is read by any rule, both are always written in the same mutation as the flag,
 * and every name on a trigger allow-list is another chance for a write loop.
 */
export const SUPPRESSION_SCORING_INPUT_FIELDS: readonly string[] = [
  SUPPRESSION_FIELD_SUPPRESSED,
  SUPPRESSION_FIELD_REASON,
];

/* -------------------------------------------------------------------------- */
/* Why someone is suppressed                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The closed list of suppression reasons.
 *
 * Closed rather than free text for the same reason the release override's reason
 * list is closed (see `release-decision.ts`), plus one this list has and that one
 * does not: these categories carry different *legal* weight. "Unsubscribed" and
 * "legal or erasure request" are both do-not-contact, but only one of them
 * survives a change of marketing platform, and only one of them makes lifting the
 * suppression a decision somebody senior should be making. A free-text column
 * cannot be filtered, counted or escalated on.
 *
 * The list is deliberately the union of the three sources of suppression a
 * mailing operation actually has — the contact's own instruction (unsubscribed,
 * spam complaint, legal request), the mail system's verdict (hard bounce), and a
 * human's or an import's judgement (manual block, imported do-not-contact list).
 *
 * Appending to this list is safe: SELECT option identity derives from the option
 * `value`, not from `position`. Editing or removing a `code` is not.
 */
export const SUPPRESSION_REASONS = [
  {
    code: 'UNSUBSCRIBED',
    label: 'Unsubscribed',
    hint: 'They used an unsubscribe link, replied STOP, or asked a rep to stop emailing them.',
  },
  {
    code: 'HARD_BOUNCE',
    label: 'Hard bounce',
    hint: 'The mailbox does not exist. Sending again damages the sending domain.',
  },
  {
    code: 'SPAM_COMPLAINT',
    label: 'Spam complaint',
    hint: 'They reported a message as spam. The most expensive signal on this list.',
  },
  {
    code: 'MANUAL_BLOCK',
    label: 'Manual block',
    hint: 'A person decided not to contact this record. Say why in the note.',
  },
  {
    code: 'LEGAL_REQUEST',
    label: 'Legal or erasure request',
    hint: 'A GDPR erasure or objection request, or anything counsel has told us to honour.',
  },
  {
    code: 'IMPORTED_DNC',
    label: 'Imported do-not-contact list',
    hint: 'Came in on a suppression file — a previous CRM, a partner list, a TPS-style register.',
  },
] as const;

export type SuppressionReasonCode = (typeof SUPPRESSION_REASONS)[number]['code'];

export const SUPPRESSION_REASON_CODES: readonly SuppressionReasonCode[] =
  SUPPRESSION_REASONS.map((reason) => reason.code);

const findSuppressionReason = (code: string) =>
  SUPPRESSION_REASONS.find((reason) => reason.code === code) ?? null;

export const suppressionReasonLabel = (code: string | null): string => {
  if (code === null || code.trim() === '') {
    return 'no reason recorded';
  }

  return findSuppressionReason(code.trim().toUpperCase())?.label ?? code.trim();
};

/* -------------------------------------------------------------------------- */
/* Why a suppression is being lifted                                           */
/* -------------------------------------------------------------------------- */

/**
 * The closed list of *removal* reasons — a separate vocabulary on purpose.
 *
 * Removing a suppression re-enables contact with somebody who is on record
 * asking not to be contacted. There is no reason on the list above that is also
 * a good reason to undo it, so sharing one list would let a rep lift a spam
 * complaint by picking "spam complaint", which reads in the audit trail as
 * nonsense a year later.
 *
 * Every entry here is a claim that the *suppression itself* was wrong or has
 * been superseded. That is the only honest ground for removal.
 */
export const UNSUPPRESSION_REASONS = [
  {
    code: 'RECORDED_IN_ERROR',
    label: 'The suppression was recorded in error',
    hint: 'Nobody asked us to stop; the flag was set by mistake or by a bad import.',
  },
  {
    code: 'CONSENT_RENEWED',
    label: 'They have opted back in',
    hint: 'They asked to start hearing from us again. Say where that is evidenced.',
  },
  {
    code: 'WRONG_PERSON',
    label: 'It was applied to the wrong record',
    hint: 'A duplicate or a namesake was suppressed instead of the person who asked.',
  },
  {
    code: 'BOUNCE_RESOLVED',
    label: 'The bounce was a mail-server fault and is fixed',
    hint: 'Only for hard bounces. Never for an unsubscribe or a complaint.',
  },
  {
    code: 'TESTING',
    label: 'Testing Greenlight',
    hint: 'Keeps test removals out of the real compliance statistics.',
  },
] as const;

export type UnsuppressionReasonCode =
  (typeof UNSUPPRESSION_REASONS)[number]['code'];

export const UNSUPPRESSION_REASON_CODES: readonly UnsuppressionReasonCode[] =
  UNSUPPRESSION_REASONS.map((reason) => reason.code);

const findUnsuppressionReason = (code: string) =>
  UNSUPPRESSION_REASONS.find((reason) => reason.code === code) ?? null;

/* -------------------------------------------------------------------------- */
/* Notes                                                                       */
/* -------------------------------------------------------------------------- */

export const MAX_SUPPRESSION_NOTE_LENGTH = 500;

/**
 * A removal note is **mandatory**, and a suppression note is not.
 *
 * This is the opposite of the release override's policy, and deliberately so.
 * The argument against mandatory free text is that a high-frequency action
 * collects the word "ok"; releasing a gated lead is a daily action and the
 * closed reason list carries the meaning. Lifting a do-not-contact entry is
 * rare, individually consequential, and the one thing a DPO will ask to see the
 * working for. Friction is the point.
 */
export const MIN_UNSUPPRESSION_NOTE_LENGTH = 10;

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

/** Mirrors `SUPPORTED_LEAD_OBJECTS` in `release-decision.ts`, and for the same reason. */
export const SUPPRESSION_SUPPORTED_LEAD_OBJECTS: readonly string[] = ['person'];

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const asString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

export interface SuppressRequest {
  readonly leadObjectNameSingular: string;
  readonly recordId: string;
  readonly reasonCode: SuppressionReasonCode;
  /** Empty string when nothing was added. */
  readonly note: string;
}

export interface UnsuppressRequest {
  readonly leadObjectNameSingular: string;
  readonly recordId: string;
  readonly reasonCode: UnsuppressionReasonCode;
  /** Never empty — see `MIN_UNSUPPRESSION_NOTE_LENGTH`. */
  readonly note: string;
  /** The reviewer ticked "I understand this re-enables contact". */
  readonly acknowledged: true;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly request: T }
  | { readonly ok: false; readonly message: string };

interface CommonFields {
  readonly leadObjectNameSingular: string;
  readonly recordId: string;
  readonly note: string;
}

const parseCommon = (body: unknown): ParseResult<CommonFields> => {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, message: 'Request body must be an object.' };
  }

  const raw = body as Record<string, unknown>;
  const recordId = asString(raw['recordId'])?.trim() ?? '';

  if (!UUID.test(recordId)) {
    return { ok: false, message: 'This request needs a valid recordId.' };
  }

  const leadObjectNameSingular =
    asString(raw['leadObjectNameSingular'])?.trim() || 'person';

  if (!SUPPRESSION_SUPPORTED_LEAD_OBJECTS.includes(leadObjectNameSingular)) {
    return {
      ok: false,
      message: `Greenlight v0.1 keeps its block list on ${SUPPRESSION_SUPPORTED_LEAD_OBJECTS.join(
        ', ',
      )}, not ${leadObjectNameSingular}.`,
    };
  }

  const note = (asString(raw['note']) ?? '')
    .trim()
    .slice(0, MAX_SUPPRESSION_NOTE_LENGTH);

  return { ok: true, request: { leadObjectNameSingular, recordId, note } };
};

export const parseSuppressRequest = (
  body: unknown,
): ParseResult<SuppressRequest> => {
  const common = parseCommon(body);

  if (!common.ok) {
    return common;
  }

  const raw = body as Record<string, unknown>;
  const reason = findSuppressionReason(
    asString(raw['reasonCode'])?.trim().toUpperCase() ?? '',
  );

  if (reason === null) {
    return {
      ok: false,
      message:
        'Choose why this person must not be contacted. A block list with no recorded reasons cannot be audited, cleaned up, or defended.',
    };
  }

  return {
    ok: true,
    request: { ...common.request, reasonCode: reason.code },
  };
};

export const parseUnsuppressRequest = (
  body: unknown,
): ParseResult<UnsuppressRequest> => {
  const common = parseCommon(body);

  if (!common.ok) {
    return common;
  }

  const raw = body as Record<string, unknown>;
  const reason = findUnsuppressionReason(
    asString(raw['reasonCode'])?.trim().toUpperCase() ?? '',
  );

  if (reason === null) {
    return {
      ok: false,
      message:
        'Choose why this suppression should be lifted. Every reason on the list is a claim that the suppression itself was wrong or has been superseded — if none of them is true, do not lift it.',
    };
  }

  if (common.request.note.length < MIN_UNSUPPRESSION_NOTE_LENGTH) {
    return {
      ok: false,
      message: `Write down what happened, in at least ${MIN_UNSUPPRESSION_NOTE_LENGTH} characters. Removing someone from the block list re-enables contact with a person who asked us to stop, and the note is the only place the evidence for that lives.`,
    };
  }

  if (raw['acknowledged'] !== true) {
    return {
      ok: false,
      message:
        'Confirm that you understand this re-enables contact with this person.',
    };
  }

  return {
    ok: true,
    request: {
      ...common.request,
      reasonCode: reason.code,
      acknowledged: true,
    },
  };
};

/* -------------------------------------------------------------------------- */
/* Current state                                                               */
/* -------------------------------------------------------------------------- */

export interface CurrentSuppressionState {
  readonly recordId: string;
  /** Denormalised into the audit row so the trail survives the record. */
  readonly displayName: string;
  readonly suppressed: boolean;
  /** Raw `greenlightSuppressionReason`. Null when nothing is recorded. */
  readonly reasonCode: string | null;
  /** Raw `greenlightSuppressedAt` as stored. Null when nothing is recorded. */
  readonly suppressedAt: string | null;
  readonly note: string;
  /** Raw `greenlightDecision`, for the audit row's decision column. */
  readonly decision: string | null;
  readonly score: number | null;
  /**
   * Raw `greenlightTrace`, read only for the audit row's band column — see
   * `auditBandValue` in `release-decision.ts`. Optional because nothing in this
   * module's decision logic reads it: a suppression is decided from the flag and
   * the reason, never from a score, and a caller that cannot supply a trace must
   * still be able to suppress somebody.
   */
  readonly trace?: unknown;
}

/**
 * Is this record on the block list *as far as Greenlight's own fields go*?
 *
 * A recorded reason with the flag cleared counts as suppressed, and that is not
 * a bug. Half-clearing — untick the box, leave `SPAM_COMPLAINT` sitting in the
 * reason column — is the realistic hand-edit, and reading it as "not suppressed"
 * would silently re-enable outreach to somebody whose record still states, in
 * writing, why we stopped. The compliance rule takes the same view; see
 * `src/scoring/rules/compliance-opt-out.rule.ts`.
 */
export const isSuppressedState = (state: {
  readonly suppressed: boolean;
  readonly reasonCode: string | null;
}): boolean =>
  state.suppressed || (state.reasonCode ?? '').trim().length > 0;

/* -------------------------------------------------------------------------- */
/* Audit vocabulary                                                            */
/* -------------------------------------------------------------------------- */

/** New `GreenlightAuditLog.eventType` options — see `src/objects/greenlight-audit-log.ts`. */
export const AUDIT_EVENT_SUPPRESSED = 'SUPPRESSED';
export const AUDIT_EVENT_UNSUPPRESSED = 'UNSUPPRESSED';

export type SuppressionAuditEventType =
  | typeof AUDIT_EVENT_SUPPRESSED
  | typeof AUDIT_EVENT_UNSUPPRESSED;

/** The audit-trail rendering of a reason: machine code first, prose after. */
export const formatSuppressionReason = (
  reasonCode: string,
  note: string,
): string => {
  const label =
    findSuppressionReason(reasonCode)?.label ??
    findUnsuppressionReason(reasonCode)?.label ??
    null;
  const rendered = label === null ? reasonCode : `${reasonCode} · ${label}`;

  return note === '' ? rendered : `${rendered} — ${note}`;
};

/** One-line summary used as the audit row's record label. */
export const buildSuppressionAuditSummary = (
  eventType: SuppressionAuditEventType,
  displayName: string,
  reasonCode: string,
): string => {
  const name = displayName.trim() === '' ? 'Unnamed lead' : displayName.trim();

  return `${eventType} · ${name} · ${reasonCode}`;
};

/* -------------------------------------------------------------------------- */
/* The decisions                                                               */
/* -------------------------------------------------------------------------- */

export type SuppressOutcome =
  /** Newly added to the block list. */
  | 'suppressed'
  /** Already on the list under the same reason. Nothing written, nothing logged. */
  | 'already_suppressed'
  /** Already on the list under a different reason; the reason was amended. */
  | 'reason_amended';

export type UnsuppressOutcome =
  /** Removed from the block list. */
  | 'unsuppressed'
  /** Was not on the list. Nothing written, nothing logged. */
  | 'not_suppressed';

export interface SuppressionWrite {
  readonly [field: string]: string | boolean | null;
}

export interface SuppressionDecision<TOutcome extends string> {
  readonly outcome: TOutcome;
  /** Shown to the reviewer. Written for a salesperson, not a developer. */
  readonly message: string;
  /** The Person patch to apply, or null when nothing changes. */
  readonly write: SuppressionWrite | null;
  readonly shouldWriteAuditRow: boolean;
  readonly auditEventType: SuppressionAuditEventType | null;
  /** Rendered reason for the audit row. Empty when no row is written. */
  readonly auditReason: string;
}

export interface DecideSuppressInput {
  readonly request: SuppressRequest;
  readonly lead: CurrentSuppressionState;
  /** The clock, passed in — this module never reads it. */
  readonly now: Date;
}

export interface DecideUnsuppressInput {
  readonly request: UnsuppressRequest;
  readonly lead: CurrentSuppressionState;
  readonly now: Date;
}

/**
 * Decide what adding to the block list should do. Never throws.
 *
 * Three cases, and the amendment case is the interesting one. A record already
 * suppressed as `MANUAL_BLOCK` that turns out to be a `LEGAL_REQUEST` must be
 * correctable *without* passing through an unsuppressed state — a remove-then-add
 * would re-enable contact for as long as it took somebody to do the second half,
 * and would put a spurious `UNSUPPRESSED` row in the compliance trail.
 *
 * `greenlightSuppressedAt` is **not** rewritten on an amendment. That column
 * answers "since when has this person been off-limits", and the answer does not
 * change because we relabelled why.
 */
export const decideSuppress = (
  input: DecideSuppressInput,
): SuppressionDecision<SuppressOutcome> => {
  const { request, lead, now } = input;
  const currentReason = (lead.reasonCode ?? '').trim().toUpperCase();
  const alreadyOnList = isSuppressedState(lead);

  if (alreadyOnList && currentReason === request.reasonCode) {
    return {
      outcome: 'already_suppressed',
      message: `${
        lead.displayName.trim() === '' ? 'This lead' : lead.displayName.trim()
      } is already on the Greenlight block list for the same reason. Nothing changed, and no second audit entry was written.`,
      write: null,
      shouldWriteAuditRow: false,
      auditEventType: null,
      auditReason: '',
    };
  }

  if (alreadyOnList) {
    return {
      outcome: 'reason_amended',
      message: `Already blocked — the recorded reason has been changed from ${suppressionReasonLabel(
        currentReason === '' ? null : currentReason,
      )} to ${suppressionReasonLabel(
        request.reasonCode,
      )}. The original block date is unchanged and the amendment is on record.`,
      write: {
        [SUPPRESSION_FIELD_SUPPRESSED]: true,
        [SUPPRESSION_FIELD_REASON]: request.reasonCode,
        [SUPPRESSION_FIELD_NOTE]: request.note,
      },
      shouldWriteAuditRow: true,
      auditEventType: AUDIT_EVENT_SUPPRESSED,
      auditReason: `AMENDED from ${
        currentReason === '' ? 'no recorded reason' : currentReason
      } — ${formatSuppressionReason(request.reasonCode, request.note)}`,
    };
  }

  return {
    outcome: 'suppressed',
    message:
      'Added to the Greenlight block list. This person will not be contacted, the lead has been re-scored, and the block is on record.',
    write: {
      [SUPPRESSION_FIELD_SUPPRESSED]: true,
      [SUPPRESSION_FIELD_REASON]: request.reasonCode,
      [SUPPRESSION_FIELD_SUPPRESSED_AT]: now.toISOString(),
      [SUPPRESSION_FIELD_NOTE]: request.note,
    },
    shouldWriteAuditRow: true,
    auditEventType: AUDIT_EVENT_SUPPRESSED,
    auditReason: formatSuppressionReason(request.reasonCode, request.note),
  };
};

/**
 * Decide what removing from the block list should do. Never throws.
 *
 * Every field is cleared, not just the flag. Leaving the reason behind would
 * leave the record asserting "spam complaint" while claiming to be contactable,
 * and the compliance rule (correctly) reads a lingering reason as still
 * suppressed — so a partial clear would look like it worked and quietly do
 * nothing.
 *
 * The audit row records the reason the person was suppressed *under*, not just
 * the reason given for lifting it. "Which legal-request suppressions has this
 * workspace lifted, and who lifted them" is the question this trail exists to
 * answer, and it is unanswerable from the removal reason alone.
 */
export const decideUnsuppress = (
  input: DecideUnsuppressInput,
): SuppressionDecision<UnsuppressOutcome> => {
  const { request, lead } = input;

  if (!isSuppressedState(lead)) {
    return {
      outcome: 'not_suppressed',
      message:
        'This person is not on the Greenlight block list, so there was nothing to remove. No change made, and no audit entry written.',
      write: null,
      shouldWriteAuditRow: false,
      auditEventType: null,
      auditReason: '',
    };
  }

  const originalReason =
    (lead.reasonCode ?? '').trim() === ''
      ? 'no recorded reason'
      : (lead.reasonCode ?? '').trim().toUpperCase();

  return {
    outcome: 'unsuppressed',
    message:
      'Removed from the Greenlight block list. Contact is re-enabled, the lead has been re-scored, and your reason is on record and cannot be edited afterwards.',
    write: {
      [SUPPRESSION_FIELD_SUPPRESSED]: false,
      [SUPPRESSION_FIELD_REASON]: null,
      [SUPPRESSION_FIELD_SUPPRESSED_AT]: null,
      [SUPPRESSION_FIELD_NOTE]: '',
    },
    shouldWriteAuditRow: true,
    auditEventType: AUDIT_EVENT_UNSUPPRESSED,
    auditReason: `LIFTED a ${originalReason} suppression recorded ${
      lead.suppressedAt ?? 'at an unrecorded time'
    } — ${formatSuppressionReason(request.reasonCode, request.note)}`,
  };
};
