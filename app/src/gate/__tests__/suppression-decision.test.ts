import { describe, expect, it } from 'vitest';

import {
  AUDIT_EVENT_SUPPRESSED,
  AUDIT_EVENT_UNSUPPRESSED,
  buildSuppressionAuditSummary,
  decideSuppress,
  decideUnsuppress,
  formatSuppressionReason,
  isSuppressedState,
  MIN_UNSUPPRESSION_NOTE_LENGTH,
  parseSuppressRequest,
  parseUnsuppressRequest,
  SUPPRESSION_FIELD_NOTE,
  SUPPRESSION_FIELD_REASON,
  SUPPRESSION_FIELD_SUPPRESSED,
  SUPPRESSION_FIELD_SUPPRESSED_AT,
  SUPPRESSION_PERSON_FIELDS,
  SUPPRESSION_REASON_CODES,
  SUPPRESSION_REASONS,
  SUPPRESSION_SCORING_INPUT_FIELDS,
  suppressionReasonLabel,
  UNSUPPRESSION_REASON_CODES,
  UNSUPPRESSION_REASONS,
  type CurrentSuppressionState,
  type SuppressRequest,
  type UnsuppressRequest,
} from 'src/gate/suppression-decision';

const NOW = new Date('2026-08-02T12:00:00.000Z');
const RECORD_ID = '11111111-1111-4111-8111-111111111111';

const aLead = (
  overrides: Partial<CurrentSuppressionState> = {},
): CurrentSuppressionState => ({
  recordId: RECORD_ID,
  displayName: 'Jane Doe',
  suppressed: false,
  reasonCode: null,
  suppressedAt: null,
  note: '',
  decision: 'PASS',
  score: 72,
  ...overrides,
});

const suppressBody = (overrides: Record<string, unknown> = {}) => ({
  leadObjectNameSingular: 'person',
  recordId: RECORD_ID,
  reasonCode: 'UNSUBSCRIBED',
  note: '',
  ...overrides,
});

const unsuppressBody = (overrides: Record<string, unknown> = {}) => ({
  leadObjectNameSingular: 'person',
  recordId: RECORD_ID,
  reasonCode: 'RECORDED_IN_ERROR',
  note: 'Import mapped the wrong column; nobody asked us to stop.',
  acknowledged: true,
  ...overrides,
});

const suppressRequest = (overrides: Record<string, unknown> = {}) => {
  const parsed = parseSuppressRequest(suppressBody(overrides));

  if (!parsed.ok) {
    throw new Error(`fixture is invalid: ${parsed.message}`);
  }

  return parsed.request satisfies SuppressRequest;
};

const unsuppressRequest = (overrides: Record<string, unknown> = {}) => {
  const parsed = parseUnsuppressRequest(unsuppressBody(overrides));

  if (!parsed.ok) {
    throw new Error(`fixture is invalid: ${parsed.message}`);
  }

  return parsed.request satisfies UnsuppressRequest;
};

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

describe('suppression vocabulary', () => {
  it('covers every source of suppression a mailing operation actually has', () => {
    expect(SUPPRESSION_REASON_CODES).toEqual([
      'UNSUBSCRIBED',
      'HARD_BOUNCE',
      'SPAM_COMPLAINT',
      'MANUAL_BLOCK',
      'LEGAL_REQUEST',
      'IMPORTED_DNC',
    ]);
  });

  it('keeps the removal vocabulary separate from the suppression vocabulary', () => {
    // Sharing one list would let a rep lift a spam complaint by picking "spam
    // complaint", which reads as nonsense in the trail a year later.
    const overlap = UNSUPPRESSION_REASON_CODES.filter((code) =>
      (SUPPRESSION_REASON_CODES as readonly string[]).includes(code),
    );

    expect(overlap).toEqual([]);
  });

  it('gives every reason a label and a hint a salesperson can act on', () => {
    for (const reason of [...SUPPRESSION_REASONS, ...UNSUPPRESSION_REASONS]) {
      expect(reason.label.length).toBeGreaterThan(3);
      expect(reason.hint.length).toBeGreaterThan(20);
      expect(reason.hint.trim().endsWith('.')).toBe(true);
    }
  });

  it('renders a reason label, and degrades to the raw code for anything else', () => {
    expect(suppressionReasonLabel('HARD_BOUNCE')).toBe('Hard bounce');
    expect(suppressionReasonLabel('hard_bounce')).toBe('Hard bounce');
    expect(suppressionReasonLabel('WHO_KNOWS')).toBe('WHO_KNOWS');
    expect(suppressionReasonLabel(null)).toBe('no reason recorded');
  });

  it('keeps the scoring-input subset inside the full field set', () => {
    for (const field of SUPPRESSION_SCORING_INPUT_FIELDS) {
      expect(SUPPRESSION_PERSON_FIELDS).toContain(field);
    }

    // The date and the note must not be on the trigger list: neither is read by
    // any rule, and every extra name is another chance for a write loop.
    expect(SUPPRESSION_SCORING_INPUT_FIELDS).not.toContain(
      SUPPRESSION_FIELD_SUPPRESSED_AT,
    );
    expect(SUPPRESSION_SCORING_INPUT_FIELDS).not.toContain(
      SUPPRESSION_FIELD_NOTE,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

describe('parseSuppressRequest', () => {
  it('accepts a well-formed request', () => {
    const parsed = parseSuppressRequest(
      suppressBody({ reasonCode: 'spam_complaint', note: '  bounced back  ' }),
    );

    expect(parsed).toMatchObject({
      ok: true,
      request: { reasonCode: 'SPAM_COMPLAINT', note: 'bounced back' },
    });
  });

  it.each([
    ['a non-object body', 'not an object'],
    ['a missing record id', suppressBody({ recordId: undefined })],
    ['a malformed record id', suppressBody({ recordId: 'nope' })],
    ['an unsupported lead object', suppressBody({ leadObjectNameSingular: 'company' })],
    ['a reason outside the closed list', suppressBody({ reasonCode: 'BECAUSE' })],
    ['no reason at all', suppressBody({ reasonCode: undefined })],
  ])('refuses %s', (_label, body) => {
    expect(parseSuppressRequest(body).ok).toBe(false);
  });

  it('caps the note rather than refusing a long one', () => {
    const parsed = parseSuppressRequest(suppressBody({ note: 'x'.repeat(2000) }));

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.request.note.length).toBe(500);
  });
});

describe('parseUnsuppressRequest', () => {
  it('accepts a well-formed request', () => {
    expect(parseUnsuppressRequest(unsuppressBody()).ok).toBe(true);
  });

  it('refuses a removal with no written note', () => {
    // The asymmetry with the release override is deliberate: a rare, expensive
    // action can afford to demand the actual reason.
    const parsed = parseUnsuppressRequest(unsuppressBody({ note: 'ok' }));

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toContain(
      String(MIN_UNSUPPRESSION_NOTE_LENGTH),
    );
  });

  it('refuses a removal that was not explicitly acknowledged', () => {
    expect(parseUnsuppressRequest(unsuppressBody({ acknowledged: false })).ok).toBe(
      false,
    );
    expect(
      parseUnsuppressRequest(unsuppressBody({ acknowledged: 'true' })).ok,
    ).toBe(false);
    expect(
      parseUnsuppressRequest(unsuppressBody({ acknowledged: undefined })).ok,
    ).toBe(false);
  });

  it('refuses a suppression reason used as a removal reason', () => {
    expect(
      parseUnsuppressRequest(unsuppressBody({ reasonCode: 'UNSUBSCRIBED' })).ok,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Adding to the block list                                                    */
/* -------------------------------------------------------------------------- */

describe('decideSuppress', () => {
  it('suppresses a lead that is not on the list, stamping the date', () => {
    const decision = decideSuppress({
      request: suppressRequest({ note: 'Replied to the March send.' }),
      lead: aLead(),
      now: NOW,
    });

    expect(decision.outcome).toBe('suppressed');
    expect(decision.write).toEqual({
      [SUPPRESSION_FIELD_SUPPRESSED]: true,
      [SUPPRESSION_FIELD_REASON]: 'UNSUBSCRIBED',
      [SUPPRESSION_FIELD_SUPPRESSED_AT]: NOW.toISOString(),
      [SUPPRESSION_FIELD_NOTE]: 'Replied to the March send.',
    });
    expect(decision.shouldWriteAuditRow).toBe(true);
    expect(decision.auditEventType).toBe(AUDIT_EVENT_SUPPRESSED);
    expect(decision.auditReason).toContain('UNSUBSCRIBED');
    expect(decision.auditReason).toContain('Replied to the March send.');
  });

  it('does nothing and logs nothing when the same block is applied twice', () => {
    const decision = decideSuppress({
      request: suppressRequest(),
      lead: aLead({ suppressed: true, reasonCode: 'UNSUBSCRIBED' }),
      now: NOW,
    });

    expect(decision.outcome).toBe('already_suppressed');
    expect(decision.write).toBeNull();
    expect(decision.shouldWriteAuditRow).toBe(false);
  });

  it('amends the reason without passing through an unsuppressed state', () => {
    // Correcting MANUAL_BLOCK to LEGAL_REQUEST must not require a remove-then-add
    // round trip: that would re-enable contact in between and put a spurious
    // UNSUPPRESSED row in the compliance trail.
    const decision = decideSuppress({
      request: suppressRequest({ reasonCode: 'LEGAL_REQUEST', note: 'Counsel asked.' }),
      lead: aLead({
        suppressed: true,
        reasonCode: 'MANUAL_BLOCK',
        suppressedAt: '2026-07-01T00:00:00.000Z',
      }),
      now: NOW,
    });

    expect(decision.outcome).toBe('reason_amended');
    expect(decision.write?.[SUPPRESSION_FIELD_REASON]).toBe('LEGAL_REQUEST');
    // The date contact stopped is unchanged by relabelling why.
    expect(decision.write).not.toHaveProperty(SUPPRESSION_FIELD_SUPPRESSED_AT);
    expect(decision.auditEventType).toBe(AUDIT_EVENT_SUPPRESSED);
    expect(decision.auditReason).toContain('AMENDED from MANUAL_BLOCK');
  });

  it('treats a half-cleared record as still on the list', () => {
    const decision = decideSuppress({
      request: suppressRequest({ reasonCode: 'HARD_BOUNCE' }),
      lead: aLead({ suppressed: false, reasonCode: 'HARD_BOUNCE' }),
      now: NOW,
    });

    expect(decision.outcome).toBe('already_suppressed');
  });
});

/* -------------------------------------------------------------------------- */
/* Removing from the block list                                                */
/* -------------------------------------------------------------------------- */

describe('decideUnsuppress', () => {
  it('clears every suppression field, not just the flag', () => {
    // A partial clear would leave the record asserting SPAM_COMPLAINT while
    // claiming to be contactable — and the compliance rule reads a lingering
    // reason as still suppressed, so it would look like it worked and do nothing.
    const decision = decideUnsuppress({
      request: unsuppressRequest(),
      lead: aLead({
        suppressed: true,
        reasonCode: 'SPAM_COMPLAINT',
        suppressedAt: '2026-07-01T00:00:00.000Z',
        note: 'Reported the June send.',
        decision: 'BLOCKED',
      }),
      now: NOW,
    });

    expect(decision.outcome).toBe('unsuppressed');
    expect(decision.write).toEqual({
      [SUPPRESSION_FIELD_SUPPRESSED]: false,
      [SUPPRESSION_FIELD_REASON]: null,
      [SUPPRESSION_FIELD_SUPPRESSED_AT]: null,
      [SUPPRESSION_FIELD_NOTE]: '',
    });
  });

  it('records what the person was suppressed under, not only why it was lifted', () => {
    const decision = decideUnsuppress({
      request: unsuppressRequest({ note: 'Duplicate of record 4f2; that one stays blocked.' }),
      lead: aLead({
        suppressed: true,
        reasonCode: 'LEGAL_REQUEST',
        suppressedAt: '2026-07-01T00:00:00.000Z',
        decision: 'BLOCKED',
      }),
      now: NOW,
    });

    expect(decision.auditEventType).toBe(AUDIT_EVENT_UNSUPPRESSED);
    // "Which legal-request blocks has this workspace lifted" has to be
    // answerable from this column alone.
    expect(decision.auditReason).toContain('LEGAL_REQUEST');
    expect(decision.auditReason).toContain('2026-07-01T00:00:00.000Z');
    expect(decision.auditReason).toContain('RECORDED_IN_ERROR');
    expect(decision.auditReason).toContain('Duplicate of record 4f2');
  });

  it('does nothing and logs nothing when the person was never on the list', () => {
    const decision = decideUnsuppress({
      request: unsuppressRequest(),
      lead: aLead(),
      now: NOW,
    });

    expect(decision.outcome).toBe('not_suppressed');
    expect(decision.write).toBeNull();
    expect(decision.shouldWriteAuditRow).toBe(false);
  });

  it('still lifts a half-cleared record, so the reason cannot be stranded', () => {
    const decision = decideUnsuppress({
      request: unsuppressRequest(),
      lead: aLead({ suppressed: false, reasonCode: 'IMPORTED_DNC' }),
      now: NOW,
    });

    expect(decision.outcome).toBe('unsuppressed');
    expect(decision.write?.[SUPPRESSION_FIELD_REASON]).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

describe('suppression helpers', () => {
  it('reads a recorded reason as suppression even with the flag cleared', () => {
    expect(isSuppressedState({ suppressed: false, reasonCode: 'HARD_BOUNCE' })).toBe(
      true,
    );
    expect(isSuppressedState({ suppressed: true, reasonCode: null })).toBe(true);
    expect(isSuppressedState({ suppressed: false, reasonCode: '   ' })).toBe(false);
    expect(isSuppressedState({ suppressed: false, reasonCode: null })).toBe(false);
  });

  it('renders a reason as machine code first, prose second', () => {
    expect(formatSuppressionReason('HARD_BOUNCE', '')).toBe(
      'HARD_BOUNCE · Hard bounce',
    );
    expect(formatSuppressionReason('HARD_BOUNCE', 'mailbox gone')).toBe(
      'HARD_BOUNCE · Hard bounce — mailbox gone',
    );
  });

  it('labels an audit row with the event, the lead and the reason', () => {
    expect(
      buildSuppressionAuditSummary(AUDIT_EVENT_SUPPRESSED, 'Jane Doe', 'UNSUBSCRIBED'),
    ).toBe('SUPPRESSED · Jane Doe · UNSUBSCRIBED');

    expect(
      buildSuppressionAuditSummary(AUDIT_EVENT_UNSUPPRESSED, '  ', 'CLEARED'),
    ).toBe('UNSUPPRESSED · Unnamed lead · CLEARED');
  });
});
