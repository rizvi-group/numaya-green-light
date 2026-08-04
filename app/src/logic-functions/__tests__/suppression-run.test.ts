import { describe, expect, it } from 'vitest';

import {
  SUPPRESSION_FIELD_NOTE,
  SUPPRESSION_FIELD_REASON,
  SUPPRESSION_FIELD_SUPPRESSED,
  SUPPRESSION_FIELD_SUPPRESSED_AT,
} from 'src/gate/suppression-decision';
import {
  runSuppressLead,
  runUnsuppressLead,
  toSuppressionState,
} from 'src/logic-functions/suppression-run';

import {
  asConnection,
  createFakeClient,
  mutationData,
  type FakeClient,
} from 'src/logic-functions/__tests__/fake-client';

const NOW = new Date('2026-08-02T12:00:00.000Z');
const RECORD_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR = 'Workspace member 7';

const person = (overrides: Record<string, unknown> = {}) => ({
  id: RECORD_ID,
  name: { firstName: 'Jane', lastName: 'Doe' },
  greenlightDecision: 'PASS',
  greenlightScore: 72,
  [SUPPRESSION_FIELD_SUPPRESSED]: false,
  [SUPPRESSION_FIELD_REASON]: null,
  [SUPPRESSION_FIELD_SUPPRESSED_AT]: null,
  [SUPPRESSION_FIELD_NOTE]: '',
  ...overrides,
});

const clientFor = (
  node: Record<string, unknown> | null,
  options: { failAudit?: boolean; failUpdate?: boolean } = {},
): FakeClient =>
  createFakeClient({
    query: () => asConnection('people', node === null ? [] : [node]),
    mutation: (request) => {
      if (options.failAudit === true && 'createGreenlightAuditLog' in request) {
        throw new Error('audit write failed');
      }

      if (options.failUpdate === true && 'updatePerson' in request) {
        throw new Error('person write failed');
      }

      return {};
    },
  });

const auditRow = (client: FakeClient): Record<string, unknown> =>
  mutationData(client.callsTo('createGreenlightAuditLog')[0] ?? {});

const personPatch = (client: FakeClient): Record<string, unknown> =>
  mutationData(client.callsTo('updatePerson')[0] ?? {});

const suppressBody = (overrides: Record<string, unknown> = {}) => ({
  leadObjectNameSingular: 'person',
  recordId: RECORD_ID,
  reasonCode: 'UNSUBSCRIBED',
  note: 'Replied to the March send asking to be removed.',
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

/* -------------------------------------------------------------------------- */
/* Reading the record                                                          */
/* -------------------------------------------------------------------------- */

describe('toSuppressionState', () => {
  it('reads the four suppression columns and the display name', () => {
    expect(
      toSuppressionState(
        RECORD_ID,
        person({
          [SUPPRESSION_FIELD_SUPPRESSED]: true,
          [SUPPRESSION_FIELD_REASON]: 'HARD_BOUNCE',
          [SUPPRESSION_FIELD_SUPPRESSED_AT]: '2026-07-01T00:00:00.000Z',
          [SUPPRESSION_FIELD_NOTE]: '  bounced twice  ',
          greenlightDecision: 'BLOCKED',
        }),
      ),
    ).toEqual({
      recordId: RECORD_ID,
      displayName: 'Jane Doe',
      suppressed: true,
      reasonCode: 'HARD_BOUNCE',
      suppressedAt: '2026-07-01T00:00:00.000Z',
      note: 'bounced twice',
      decision: 'BLOCKED',
      score: 72,
      // Read purely so the audit row can record the band the scoring run chose
      // instead of defaulting it to Unscored beside a real score.
      trace: null,
    });
  });

  it('carries the rule trace through so the audit row can band the lead', () => {
    expect(
      toSuppressionState(
        RECORD_ID,
        person({ greenlightTrace: { band: 'POOR', score: 39.8 } }),
      ).trace,
    ).toEqual({ band: 'POOR', score: 39.8 });
  });

  it('degrades an unreadable record to "not suppressed" rather than throwing', () => {
    expect(toSuppressionState(RECORD_ID, { id: RECORD_ID })).toMatchObject({
      displayName: RECORD_ID,
      suppressed: false,
      reasonCode: null,
      score: null,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Adding to the block list                                                    */
/* -------------------------------------------------------------------------- */

describe('runSuppressLead', () => {
  it('writes the block and audits it', async () => {
    const client = clientFor(person());

    const result = await runSuppressLead({
      client,
      body: suppressBody(),
      now: NOW,
      actorDisplayName: ACTOR,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      outcome: 'suppressed',
      changed: true,
      auditWritten: true,
    });

    expect(personPatch(client)).toEqual({
      [SUPPRESSION_FIELD_SUPPRESSED]: true,
      [SUPPRESSION_FIELD_REASON]: 'UNSUBSCRIBED',
      [SUPPRESSION_FIELD_SUPPRESSED_AT]: NOW.toISOString(),
      [SUPPRESSION_FIELD_NOTE]:
        'Replied to the March send asking to be removed.',
    });

    const row = auditRow(client);

    expect(row).toMatchObject({
      name: 'SUPPRESSED · Jane Doe · UNSUBSCRIBED',
      eventType: 'SUPPRESSED',
      occurredAt: NOW.toISOString(),
      leadObjectNameSingular: 'person',
      leadRecordId: RECORD_ID,
      leadDisplayName: 'Jane Doe',
      actorType: 'HUMAN',
      actorDisplayName: ACTOR,
    });
    expect(String(row['overrideReason'])).toContain('UNSUBSCRIBED');
  });

  it('never writes the decision column — that is the engine’s to move', async () => {
    const client = clientFor(person());

    await runSuppressLead({
      client,
      body: suppressBody(),
      now: NOW,
      actorDisplayName: ACTOR,
    });

    expect(Object.keys(personPatch(client))).not.toContain('greenlightDecision');
    // The audit row records the state at the moment the human acted; the
    // re-score this write triggers appends its own row for the new one.
    expect(auditRow(client)['decision']).toBe('PASS');
  });

  it('records the block before touching the record', async () => {
    const client = clientFor(person());

    await runSuppressLead({
      client,
      body: suppressBody(),
      now: NOW,
      actorDisplayName: ACTOR,
    });

    expect(client.mutationNames()).toEqual([
      'createGreenlightAuditLog',
      'updatePerson',
    ]);
  });

  it('abandons the action entirely when the audit row cannot be written', async () => {
    // An unrecorded change to a do-not-contact list is worse than no change.
    const client = clientFor(person(), { failAudit: true });

    const result = await runSuppressLead({
      client,
      body: suppressBody(),
      now: NOW,
      actorDisplayName: ACTOR,
    });

    expect(result.status).toBe(502);
    expect(result.body.changed).toBe(false);
    expect(client.mutationNames()).not.toContain('updatePerson');
  });

  it('says so loudly when it logged the block but could not apply it', async () => {
    const client = clientFor(person(), { failUpdate: true });

    const result = await runSuppressLead({
      client,
      body: suppressBody(),
      now: NOW,
      actorDisplayName: ACTOR,
    });

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      outcome: 'write_failed',
      changed: false,
      auditWritten: true,
    });
    expect(result.body.message).toContain('not in force');
  });

  it('writes nothing at all when the same block is applied twice', async () => {
    const client = clientFor(
      person({
        [SUPPRESSION_FIELD_SUPPRESSED]: true,
        [SUPPRESSION_FIELD_REASON]: 'UNSUBSCRIBED',
      }),
    );

    const result = await runSuppressLead({
      client,
      body: suppressBody(),
      now: NOW,
      actorDisplayName: ACTOR,
    });

    expect(result.body).toMatchObject({
      outcome: 'already_suppressed',
      changed: false,
      auditWritten: false,
    });
    expect(client.mutationNames()).toEqual([]);
  });

  it('refuses an invalid request without reading the lead', async () => {
    const client = clientFor(person());

    const result = await runSuppressLead({
      client,
      body: suppressBody({ reasonCode: 'BECAUSE_I_SAID_SO' }),
      now: NOW,
      actorDisplayName: ACTOR,
    });

    expect(result.status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });

  it('reports a lead that no longer exists', async () => {
    const client = clientFor(null);

    const result = await runSuppressLead({
      client,
      body: suppressBody(),
      now: NOW,
      actorDisplayName: ACTOR,
    });

    expect(result.status).toBe(404);
    expect(client.mutationNames()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Removing from the block list                                                */
/* -------------------------------------------------------------------------- */

describe('runUnsuppressLead', () => {
  const blocked = () =>
    person({
      [SUPPRESSION_FIELD_SUPPRESSED]: true,
      [SUPPRESSION_FIELD_REASON]: 'LEGAL_REQUEST',
      [SUPPRESSION_FIELD_SUPPRESSED_AT]: '2026-07-01T00:00:00.000Z',
      [SUPPRESSION_FIELD_NOTE]: 'Erasure request via counsel.',
      greenlightDecision: 'BLOCKED',
    });

  it('clears every suppression column and audits the removal', async () => {
    const client = clientFor(blocked());

    const result = await runUnsuppressLead({
      client,
      body: unsuppressBody(),
      now: NOW,
      actorDisplayName: ACTOR,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      outcome: 'unsuppressed',
      changed: true,
      auditWritten: true,
    });

    expect(personPatch(client)).toEqual({
      [SUPPRESSION_FIELD_SUPPRESSED]: false,
      [SUPPRESSION_FIELD_REASON]: null,
      [SUPPRESSION_FIELD_SUPPRESSED_AT]: null,
      [SUPPRESSION_FIELD_NOTE]: '',
    });

    const row = auditRow(client);

    expect(row).toMatchObject({
      name: 'UNSUPPRESSED · Jane Doe · CLEARED',
      eventType: 'UNSUPPRESSED',
      actorType: 'HUMAN',
      actorDisplayName: ACTOR,
      decision: 'BLOCKED',
    });

    // The row has to carry what they were blocked *for*, or a DPO cannot ask
    // "which legal-request blocks have been lifted".
    expect(String(row['overrideReason'])).toContain('LEGAL_REQUEST');
    expect(String(row['overrideReason'])).toContain('RECORDED_IN_ERROR');
  });

  it('refuses a removal with no written note, before reading the lead', async () => {
    const client = clientFor(blocked());

    const result = await runUnsuppressLead({
      client,
      body: unsuppressBody({ note: 'ok' }),
      now: NOW,
      actorDisplayName: ACTOR,
    });

    expect(result.status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });

  it('refuses a removal that was not acknowledged, whatever the panel sent', async () => {
    const client = clientFor(blocked());

    const result = await runUnsuppressLead({
      client,
      body: unsuppressBody({ acknowledged: undefined }),
      now: NOW,
      actorDisplayName: ACTOR,
    });

    expect(result.status).toBe(400);
    expect(client.calls).toHaveLength(0);
  });

  it('writes nothing when the person was never on the list', async () => {
    const client = clientFor(person());

    const result = await runUnsuppressLead({
      client,
      body: unsuppressBody(),
      now: NOW,
      actorDisplayName: ACTOR,
    });

    expect(result.body).toMatchObject({
      outcome: 'not_suppressed',
      changed: false,
      auditWritten: false,
    });
    expect(client.mutationNames()).toEqual([]);
  });

  it('abandons the removal entirely when the audit row cannot be written', async () => {
    const client = clientFor(blocked(), { failAudit: true });

    const result = await runUnsuppressLead({
      client,
      body: unsuppressBody(),
      now: NOW,
      actorDisplayName: ACTOR,
    });

    expect(result.status).toBe(502);
    expect(client.mutationNames()).not.toContain('updatePerson');
  });

  it('lifts a half-cleared record so a stranded reason cannot keep blocking', async () => {
    const client = clientFor(
      person({
        [SUPPRESSION_FIELD_SUPPRESSED]: false,
        [SUPPRESSION_FIELD_REASON]: 'IMPORTED_DNC',
      }),
    );

    const result = await runUnsuppressLead({
      client,
      body: unsuppressBody(),
      now: NOW,
      actorDisplayName: ACTOR,
    });

    expect(result.body.changed).toBe(true);
    expect(personPatch(client)[SUPPRESSION_FIELD_REASON]).toBeNull();
  });
});
