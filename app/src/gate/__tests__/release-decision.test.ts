import { describe, expect, it } from 'vitest';

import {
  ALLOW_COMPLIANCE_OVERRIDE,
  auditBandValue,
  auditDecisionValue,
  BAND_UNSCORED,
  buildAuditSummary,
  DECISION_BLOCKED,
  DECISION_GATE,
  DECISION_PASS,
  DECISION_UNSCORED,
  decideRelease,
  DUPLICATE_RELEASE_WINDOW_MS,
  formatOverrideReason,
  isComplianceBlocked,
  MAX_REASON_NOTE_LENGTH,
  parseReleaseRequest,
  RELEASE_REASON_CODES,
  releaseMarkerKey,
  type CurrentLeadState,
  type ReleaseMarker,
  type ReleaseRequest,
} from 'src/gate/release-decision';

const RECORD_ID = '3f1d9a8e-6c2b-4f7a-9d51-8b2c0e4a7f13';
const NOW = new Date('2026-08-02T12:00:00.000Z');

const aRequest = (overrides: Partial<ReleaseRequest> = {}): ReleaseRequest => ({
  leadObjectNameSingular: 'person',
  recordId: RECORD_ID,
  reasonCode: 'ICP_TOO_NARROW',
  reasonNote: '',
  ...overrides,
});

const aLead = (overrides: Partial<CurrentLeadState> = {}): CurrentLeadState => ({
  recordId: RECORD_ID,
  displayName: 'Jane Doe',
  decision: DECISION_GATE,
  score: 32,
  trace: { rules: [] },
  ...overrides,
});

const aMarker = (overrides: Partial<ReleaseMarker> = {}): ReleaseMarker => ({
  leadObjectNameSingular: 'person',
  recordId: RECORD_ID,
  releasedAt: NOW.toISOString(),
  releasedBy: 'Workspace member 1',
  reasonCode: 'ICP_TOO_NARROW',
  ...overrides,
});

const decide = (
  lead: CurrentLeadState,
  marker: ReleaseMarker | null = null,
  request: ReleaseRequest = aRequest(),
  now: Date = NOW,
) => decideRelease({ request, lead, marker, now });

const blockingTrace = {
  rules: [
    { ruleId: 'contact-named-person', severity: 'major', outcome: 'pass' },
    { ruleId: 'compliance-opt-out', severity: 'blocking', outcome: 'fail' },
  ],
};

/* -------------------------------------------------------------------------- */

describe('parseReleaseRequest', () => {
  it('should accept a well-formed request and default the lead object to person', () => {
    const result = parseReleaseRequest({
      recordId: RECORD_ID,
      reasonCode: 'KNOWN_ACCOUNT',
      reasonNote: '  they asked us to call  ',
    });

    expect(result).toEqual({
      ok: true,
      request: {
        leadObjectNameSingular: 'person',
        recordId: RECORD_ID,
        reasonCode: 'KNOWN_ACCOUNT',
        reasonNote: 'they asked us to call',
      },
    });
  });

  it.each([
    ['a non-object body', 'nonsense'],
    ['an array body', []],
    ['a null body', null],
  ])('should reject %s', (_label, body) => {
    expect(parseReleaseRequest(body).ok).toBe(false);
  });

  it('should reject a record id that is not a uuid', () => {
    const result = parseReleaseRequest({
      recordId: 'not-a-uuid',
      reasonCode: 'TESTING',
    });

    expect(result).toMatchObject({ ok: false });
  });

  // The mandatory-reason policy is the Art. 22 evidence, so it is enforced
  // server-side rather than only in the panel that collects it.
  it.each([
    ['a missing reason', undefined],
    ['an empty reason', ''],
    ['an unknown reason', 'BECAUSE_I_SAID_SO'],
    ['a free-text reason smuggled into the code field', 'ok'],
  ])('should reject %s', (_label, reasonCode) => {
    const result = parseReleaseRequest({ recordId: RECORD_ID, reasonCode });

    expect(result.ok).toBe(false);
  });

  it('should accept every published reason code', () => {
    for (const reasonCode of RELEASE_REASON_CODES) {
      expect(
        parseReleaseRequest({ recordId: RECORD_ID, reasonCode }).ok,
      ).toBe(true);
    }
  });

  it('should reject a lead object v0.1 does not carry the gate fields on', () => {
    const result = parseReleaseRequest({
      leadObjectNameSingular: 'company',
      recordId: RECORD_ID,
      reasonCode: 'TESTING',
    });

    expect(result.ok).toBe(false);
  });

  it('should truncate an over-long note rather than rejecting the release', () => {
    const result = parseReleaseRequest({
      recordId: RECORD_ID,
      reasonCode: 'TESTING',
      reasonNote: 'x'.repeat(MAX_REASON_NOTE_LENGTH + 250),
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.request.reasonNote).toHaveLength(
      MAX_REASON_NOTE_LENGTH,
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('isComplianceBlocked', () => {
  it('should detect a blocking rule failure in a rules envelope', () => {
    expect(isComplianceBlocked(blockingTrace)).toBe(true);
  });

  it('should detect a blocking rule failure in a bare array trace', () => {
    expect(isComplianceBlocked(blockingTrace.rules)).toBe(true);
  });

  it.each(['trace', 'entries'])(
    'should detect a blocking rule failure under a "%s" key',
    (key) => {
      expect(isComplianceBlocked({ [key]: blockingTrace.rules })).toBe(true);
    },
  );

  it('should detect a declared blocked decision on the trace envelope', () => {
    expect(isComplianceBlocked({ decision: 'BLOCKED', rules: [] })).toBe(true);
  });

  it('should not treat a blocking rule that passed as a block', () => {
    expect(
      isComplianceBlocked({
        rules: [{ severity: 'blocking', outcome: 'pass' }],
      }),
    ).toBe(false);
  });

  it('should not treat a failing non-blocking rule as a block', () => {
    expect(
      isComplianceBlocked({
        rules: [{ severity: 'critical', outcome: 'fail' }],
      }),
    ).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'broken'],
    ['an empty object', {}],
    ['a number', 7],
  ])('should answer false for %s rather than throwing', (_label, trace) => {
    expect(isComplianceBlocked(trace)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe('decideRelease — releasing a genuinely held lead', () => {
  it('should clear the gate, audit it, and leave a marker', () => {
    const decision = decide(aLead());

    expect(decision).toMatchObject({
      outcome: 'released',
      shouldClearGate: true,
      shouldWriteAuditRow: true,
      auditEventType: 'RELEASED',
      shouldWriteMarker: true,
    });
  });

  it('should record the reason code and the note in the audit reason', () => {
    const decision = decide(
      aLead(),
      null,
      aRequest({ reasonCode: 'STRATEGIC_EXCEPTION', reasonNote: 'CFO asked' }),
    );

    expect(decision.overrideReason).toContain('STRATEGIC_EXCEPTION');
    expect(decision.overrideReason).toContain('CFO asked');
  });
});

describe('decideRelease — double-release safety', () => {
  it('should not release, audit or re-mark a lead that already passed', () => {
    const decision = decide(aLead({ decision: DECISION_PASS }));

    expect(decision).toMatchObject({
      outcome: 'already_released',
      shouldClearGate: false,
      shouldWriteAuditRow: false,
      auditEventType: null,
      shouldWriteMarker: false,
    });
  });

  it('should treat lowercase and padded decision values as the same state', () => {
    expect(decide(aLead({ decision: '  pass ' })).outcome).toBe(
      'already_released',
    );
  });

  it('should treat a second submission inside the de-duplication window as a duplicate', () => {
    const decision = decide(
      aLead(),
      aMarker({ releasedAt: new Date(NOW.getTime() - 1_000).toISOString() }),
    );

    expect(decision).toMatchObject({
      outcome: 'duplicate_request',
      shouldClearGate: false,
      shouldWriteAuditRow: false,
    });
  });

  // A lead released last week and legitimately re-gated since must be
  // releasable again. The marker is a race guard, not a permanent veto.
  it('should release again when the marker is older than the de-duplication window', () => {
    const decision = decide(
      aLead(),
      aMarker({
        releasedAt: new Date(
          NOW.getTime() - DUPLICATE_RELEASE_WINDOW_MS - 1,
        ).toISOString(),
      }),
    );

    expect(decision.outcome).toBe('released');
  });

  it('should ignore a marker dated in the future rather than blocking forever', () => {
    const decision = decide(
      aLead(),
      aMarker({ releasedAt: new Date(NOW.getTime() + 60_000).toISOString() }),
    );

    expect(decision.outcome).toBe('released');
  });

  it('should ignore an unparseable marker timestamp', () => {
    const decision = decide(aLead(), aMarker({ releasedAt: 'not a date' }));

    expect(decision.outcome).toBe('released');
  });

  // The field is authoritative: a stale marker must never make an actually-held
  // lead look already-released.
  it('should still release a gated lead whose marker is stale', () => {
    const decision = decide(
      aLead({ decision: DECISION_GATE }),
      aMarker({ releasedAt: '2026-01-01T00:00:00.000Z' }),
    );

    expect(decision.outcome).toBe('released');
  });
});

describe('decideRelease — leads that were never held', () => {
  it('should refuse to act on an unscored lead that failed open', () => {
    const decision = decide(aLead({ decision: DECISION_UNSCORED, score: null }));

    expect(decision).toMatchObject({
      outcome: 'not_held',
      shouldClearGate: false,
      shouldWriteAuditRow: false,
    });
  });

  it.each([
    ['null', null],
    ['empty', ''],
    ['whitespace', '   '],
  ])('should refuse to act on a lead with a %s decision', (_label, decision) => {
    expect(decide(aLead({ decision })).outcome).toBe('not_scored');
  });

  it('should leave a lead in an unrecognised state alone', () => {
    const decision = decide(aLead({ decision: 'SOMETHING_NEW' }));

    expect(decision).toMatchObject({
      outcome: 'not_held',
      shouldClearGate: false,
      shouldWriteAuditRow: false,
    });
  });
});

// Product decision 2026-08-02: the sales team maintains the opt-out register in
// Twenty and is trusted to correct it, so a compliance block is releasable by
// hand. These tests previously asserted the opposite; they are inverted rather
// than deleted, so the change of policy stays visible in the history.
describe('decideRelease — compliance blocks', () => {
  it('should be configured to allow compliance overrides', () => {
    expect(ALLOW_COMPLIANCE_OVERRIDE).toBe(true);
  });

  it('should release an opted-out lead when a human asks', () => {
    const decision = decide(aLead({ trace: blockingTrace }));

    expect(decision).toMatchObject({
      outcome: 'released',
      shouldClearGate: true,
      shouldWriteMarker: true,
    });
  });

  // Releasing over a live opt-out leaves the record contradictory — cleared to
  // work while the suppression fields still say do-not-contact. The audit row is
  // the only thing that explains it, so it has to be written.
  it('should audit the release of a compliance-blocked lead with its reason', () => {
    const decision = decide(
      aLead({ trace: blockingTrace }),
      null,
      aRequest({ reasonCode: 'KNOWN_ACCOUNT', reasonNote: 'they emailed us' }),
    );

    expect(decision.shouldWriteAuditRow).toBe(true);
    expect(decision.overrideReason).toContain('KNOWN_ACCOUNT');
  });

  it('should still deduplicate repeat release attempts', () => {
    const decision = decide(
      aLead({ trace: blockingTrace }),
      aMarker({ releasedAt: new Date(NOW.getTime() - 500).toISOString() }),
    );

    expect(decision.outcome).toBe('duplicate_request');
  });

  // Not-held wins over blocked: there is nothing to refuse on a lead that is
  // not being held in the first place.
  it('should report an already-passed lead as released even if its trace looks blocked', () => {
    const decision = decide(
      aLead({ decision: DECISION_PASS, trace: blockingTrace }),
    );

    expect(decision.outcome).toBe('already_released');
  });
});

/* -------------------------------------------------------------------------- */

describe('audit helpers', () => {
  it('should build a readable summary in the documented shape', () => {
    expect(buildAuditSummary('RELEASED', aLead())).toBe(
      'RELEASED · Jane Doe · 32',
    );
  });

  it('should stay readable for an unnamed, unscored lead', () => {
    expect(
      buildAuditSummary('SKIPPED', aLead({ displayName: '  ', score: null })),
    ).toBe('SKIPPED · Unnamed lead · unscored');
  });

  it('should render a reason without a note as just the category', () => {
    expect(formatOverrideReason('TESTING', '')).toBe(
      'TESTING · Testing Greenlight',
    );
  });

  it('should namespace the release marker key by object and record', () => {
    expect(releaseMarkerKey('person', RECORD_ID)).toBe(
      `greenlight:release:person:${RECORD_ID}`,
    );
  });

  it('should record a refusal against the state the lead was left in', () => {
    expect(auditDecisionValue(DECISION_BLOCKED, false)).toBe(DECISION_BLOCKED);
    expect(auditDecisionValue(DECISION_GATE, false)).toBe(DECISION_GATE);
    expect(auditDecisionValue(DECISION_GATE, true)).toBe(DECISION_PASS);
  });

  it('should never write an unknown value into the decision SELECT', () => {
    // An unrecognised option is rejected by the field, which would lose the
    // audit row entirely — the one outcome an append-only trail cannot have.
    expect(auditDecisionValue('SOMETHING_NEW', false)).toBe(DECISION_GATE);
    expect(auditDecisionValue(null, false)).toBe(DECISION_GATE);
  });
});

/* -------------------------------------------------------------------------- */
/* The band on the override's audit row                                        */
/* -------------------------------------------------------------------------- */

describe('auditBandValue', () => {
  it('should carry the band the scoring run recorded on the trace', () => {
    // The whole point: the GATED row for this lead says POOR, so the RELEASED
    // row has to say POOR too. Before this existed it said UNSCORED, and a
    // reviewer reading the two rows saw one lead with two bands.
    expect(auditBandValue({ band: 'POOR', score: 39.8 })).toBe('POOR');
    expect(auditBandValue({ band: 'EXCELLENT' })).toBe('EXCELLENT');
    expect(auditBandValue({ band: 'GOOD' })).toBe('GOOD');
    expect(auditBandValue({ band: 'FAIR' })).toBe('FAIR');
  });

  it('should normalise case and padding the way the decision value does', () => {
    expect(auditBandValue({ band: ' fair ' })).toBe('FAIR');
  });

  it('should fall back to UNSCORED rather than write an unknown option', () => {
    // Bands are configurable, so an id nobody ships can reach here. Writing it
    // into the SELECT would be rejected and lose the row.
    expect(auditBandValue({ band: 'PLATINUM' })).toBe(BAND_UNSCORED);
    expect(auditBandValue({ band: 42 })).toBe(BAND_UNSCORED);
  });

  it('should say UNSCORED when there is no trace to read a band from', () => {
    // A lead released before it was ever scored. UNSCORED here is the honest
    // answer, not a default nobody chose.
    expect(auditBandValue(null)).toBe(BAND_UNSCORED);
    expect(auditBandValue(undefined)).toBe(BAND_UNSCORED);
    expect(auditBandValue({ rules: [] })).toBe(BAND_UNSCORED);
    expect(auditBandValue([{ band: 'GOOD' }])).toBe(BAND_UNSCORED);
    expect(auditBandValue('POOR')).toBe(BAND_UNSCORED);
  });
});

/* -------------------------------------------------------------------------- */
/* BLOCKED is now a state of its own                                           */
/* -------------------------------------------------------------------------- */

describe('decideRelease — BLOCKED read straight off the field', () => {
  it('should release a lead whose decision field says BLOCKED', () => {
    // No trace needed: the field carries the compliance stop now.
    const decision = decide(
      aLead({ decision: DECISION_BLOCKED, trace: { rules: [] } }),
    );

    expect(decision).toMatchObject({
      outcome: 'released',
      shouldClearGate: true,
      shouldWriteAuditRow: true,
      shouldWriteMarker: true,
    });
  });

  it('should not mistake BLOCKED for an unrecognised state', () => {
    expect(decide(aLead({ decision: 'blocked' })).outcome).toBe('released');
  });

  it('should deduplicate repeat attempts against a BLOCKED lead', () => {
    const decision = decide(
      aLead({ decision: DECISION_BLOCKED, trace: { rules: [] } }),
      aMarker({ releasedAt: new Date(NOW.getTime() - 500).toISOString() }),
    );

    expect(decision.outcome).toBe('duplicate_request');
  });

  // Nothing backfills a new SELECT option, so every lead scored before BLOCKED
  // existed still reads GATE and can only be told apart by its trace. The
  // detection still matters even though both paths now release: it is what puts
  // the compliance context into the audit row.
  it('should recognise a legacy record that reads GATE with a blocking trace', () => {
    const decision = decide(
      aLead({ decision: DECISION_GATE, trace: blockingTrace }),
    );

    expect(decision.outcome).toBe('released');
    expect(decision.shouldWriteAuditRow).toBe(true);
  });

  it('should still release a legacy GATE record whose trace carries no block', () => {
    expect(decide(aLead({ decision: DECISION_GATE })).outcome).toBe('released');
  });
});
