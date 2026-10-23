import { describe, expect, it } from 'vitest';

import {
  buildGreenlightConfigSeed,
  toScoringConfigInput,
} from 'src/logic-functions/greenlight-config-record';
import { releaseMarkerKey, type ReleaseMarker } from 'src/gate/release-decision';
import {
  SUPPRESSION_PERSON_FIELDS,
  SUPPRESSION_SCORING_INPUT_FIELDS,
} from 'src/gate/suppression-decision';
import {
  fingerprintOutcome,
  GREENLIGHT_MANAGED_PERSON_FIELDS,
  isGreenlightAuthoredWrite,
  runPersonScoring,
  SCORING_TRIGGER_PERSON_FIELDS,
  toDecisionValue,
  type ReleaseMarkerStore,
  type ScoringRunInput,
} from 'src/logic-functions/scoring-run';
import { scoreLead, toLeadRecord } from 'src/scoring';

import {
  asConnection,
  createFakeClient,
  mutationData,
} from 'src/logic-functions/__tests__/fake-client';

const NOW = new Date('2026-08-02T12:00:00.000Z');

/* -------------------------------------------------------------------------- */
/* Release markers                                                             */
/* -------------------------------------------------------------------------- */

interface FakeMarkerStore extends ReleaseMarkerStore {
  readonly reads: string[];
  readonly deletes: string[];
}

/**
 * Stand-in for app key-value storage. `entries` is keyed exactly as the override
 * writes it, so a test that gets the key wrong fails rather than passing by
 * accident on a store that answers everything.
 */
const createFakeMarkerStore = (
  options: {
    entries?: Record<string, ReleaseMarker>;
    failGet?: boolean;
    failDelete?: boolean;
  } = {},
): FakeMarkerStore => {
  const entries = { ...(options.entries ?? {}) };
  const reads: string[] = [];
  const deletes: string[] = [];

  return {
    reads,
    deletes,
    async get(key) {
      reads.push(key);

      if (options.failGet === true) {
        throw new Error('key-value store unreachable');
      }

      return entries[key] ?? null;
    },
    async delete(key) {
      deletes.push(key);

      if (options.failDelete === true) {
        throw new Error('key-value delete failed');
      }

      delete entries[key];
    },
  };
};

const aMarker = (overrides: Partial<ReleaseMarker> = {}): ReleaseMarker => ({
  leadObjectNameSingular: 'person',
  recordId: '11111111-1111-4111-8111-111111111111',
  releasedAt: '2026-08-02T11:59:00.000Z',
  releasedBy: 'Workspace member 7',
  reasonCode: 'ICP_TOO_NARROW',
  ...overrides,
});

/** Most tests do not care about the override, so they get an empty store. */
const runScoring = (
  input: Omit<ScoringRunInput, 'markers'> & { markers?: ReleaseMarkerStore },
) => runPersonScoring({ markers: createFakeMarkerStore(), ...input });

const configRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'config-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...buildGreenlightConfigSeed(),
  ...overrides,
});

const withConfig = (overrides: Record<string, unknown> = {}) =>
  asConnection('greenlightConfigs', [configRecord(overrides)]);

/** A lead good enough to clear the default gate. */
const strongPerson = (extra: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: { firstName: 'Jane', lastName: 'Doe' },
  emails: { primaryEmail: 'jane.doe@acme.com' },
  phones: { primaryPhoneNumber: '+441234567890' },
  jobTitle: 'Chief Technology Officer',
  companyId: '22222222-2222-4222-8222-222222222222',
  company: { id: '22222222-2222-4222-8222-222222222222', name: 'Acme Ltd' },
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...extra,
});

/** A lead with nothing usable on it. */
const emptyPerson = (extra: Record<string, unknown> = {}) => ({
  id: '33333333-3333-4333-8333-333333333333',
  name: { firstName: '', lastName: '' },
  emails: { primaryEmail: '' },
  phones: {},
  jobTitle: '',
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...extra,
});

/** A lead the compliance rule stops outright, whatever else it scores. */
const optedOutPerson = (extra: Record<string, unknown> = {}) =>
  strongPerson({ optedOut: true, ...extra });

const createdEvent = (record: Record<string, unknown>) => ({
  name: 'person.created',
  recordId: record['id'],
  properties: { after: record },
});

const updatedEvent = (
  record: Record<string, unknown>,
  updatedFields: string[],
) => ({
  name: 'person.updated',
  recordId: record['id'],
  properties: { before: record, after: record, diff: {}, updatedFields },
});

/* -------------------------------------------------------------------------- */
/* The retrigger guard                                                         */
/* -------------------------------------------------------------------------- */

describe('retrigger guard — layer 1 (declarative trigger allow-list)', () => {
  it('never lists a Greenlight-managed field as a scoring trigger', () => {
    // If this ever fails, the app's own write-back starts firing the update
    // trigger and the loop is live. This is the single most important assertion
    // in the file.
    for (const managed of GREENLIGHT_MANAGED_PERSON_FIELDS) {
      expect(SCORING_TRIGGER_PERSON_FIELDS).not.toContain(managed);
    }
  });

  it('does not listen on updatedAt, which every write touches', () => {
    expect(SCORING_TRIGGER_PERSON_FIELDS).not.toContain('updatedAt');
  });
});

/* -------------------------------------------------------------------------- */
/* Suppression: the one Greenlight-owned field on the trigger list             */
/* -------------------------------------------------------------------------- */

describe('re-score on suppression change', () => {
  it('listens on the suppression fields that feed the compliance rule', () => {
    // Without this the block list is inert: someone is added to it and the lead
    // sits in the queue still reading PASS until an unrelated edit happens to
    // wake the scorer.
    for (const field of SUPPRESSION_SCORING_INPUT_FIELDS) {
      expect(SCORING_TRIGGER_PERSON_FIELDS).toContain(field);
    }
  });

  it('keeps the trigger list and the written-fields list disjoint', () => {
    // This is the whole termination argument in one assertion. The loop closes
    // if and only if the run writes a field it also listens on.
    for (const field of SUPPRESSION_PERSON_FIELDS) {
      expect(GREENLIGHT_MANAGED_PERSON_FIELDS).not.toContain(field);
    }

    for (const managed of GREENLIGHT_MANAGED_PERSON_FIELDS) {
      expect(SCORING_TRIGGER_PERSON_FIELDS).not.toContain(managed);
    }
  });

  it('does not treat a suppression-only edit as its own write-back', () => {
    // Guard 2 must let this through: a human ticked the box, and skipping it
    // would leave the lead cleared.
    expect(isGreenlightAuthoredWrite(['greenlightSuppressed'])).toBe(false);
    expect(
      isGreenlightAuthoredWrite([
        'greenlightSuppressed',
        'greenlightSuppressionReason',
      ]),
    ).toBe(false);
  });

  it('blocks the lead when the suppression field is set, and never writes it back', async () => {
    const updates: Record<string, unknown>[] = [];
    const audits: Record<string, unknown>[] = [];

    const client = createFakeClient({
      query: () => withConfig(),
      mutation: (request) => {
        const update = request['updatePerson'] as
          | Record<string, unknown>
          | undefined;
        const audit = request['createGreenlightAuditLog'] as
          | Record<string, unknown>
          | undefined;

        if (update !== undefined) {
          updates.push(mutationData(update));
        }

        if (audit !== undefined) {
          audits.push(mutationData(audit));
        }

        return {};
      },
    });

    const outcome = await runScoring({
      client,
      event: updatedEvent(
        strongPerson({
          greenlightSuppressed: true,
          greenlightSuppressionReason: 'SPAM_COMPLAINT',
        }),
        ['greenlightSuppressed', 'greenlightSuppressionReason'],
      ),
      now: NOW,
    });

    expect(outcome).toMatchObject({ status: 'scored', decision: 'BLOCKED' });
    expect(audits[0]?.['decision']).toBe('BLOCKED');

    // The termination guarantee, checked against what actually went over the
    // wire rather than against a constant: the run writes only the three
    // engine-owned columns, none of which is on the trigger list.
    expect(updates).toHaveLength(1);

    for (const field of SUPPRESSION_PERSON_FIELDS) {
      expect(Object.keys(updates[0] ?? {})).not.toContain(field);
    }

    expect(Object.keys(updates[0] ?? {}).sort()).toEqual(
      [...GREENLIGHT_MANAGED_PERSON_FIELDS].sort(),
    );
  });

  it('terminates: the write-back provoked by a suppression change provokes nothing further', async () => {
    // Worst case, both earlier guards bypassed. Feed the run's own output back
    // in as a second event and require it to write nothing.
    let written: Record<string, unknown> | null = null;

    const client = createFakeClient({
      query: () => withConfig(),
      mutation: (request) => {
        const update = request['updatePerson'] as
          | Record<string, unknown>
          | undefined;

        if (update !== undefined) {
          written = mutationData(update);
        }

        return {};
      },
    });

    const suppressed = strongPerson({
      greenlightSuppressed: true,
      greenlightSuppressionReason: 'UNSUBSCRIBED',
    });

    const first = await runScoring({
      client,
      event: updatedEvent(suppressed, ['greenlightSuppressed']),
      now: NOW,
    });

    expect(first.status).toBe('scored');
    expect(written).not.toBeNull();

    const replay = await runScoring({
      client,
      event: updatedEvent(
        { ...suppressed, ...(written ?? {}) },
        // Pretend the platform ignored `updatedFields` entirely and reported a
        // mixed write, so guards 1 and 2 both decline to help.
        ['greenlightSuppressed', 'greenlightTrace'],
      ),
      now: NOW,
    });

    expect(replay.status).toBe('unchanged');
  });

  it('re-scores back to a clearing decision when the suppression is lifted', async () => {
    const client = createFakeClient({ query: () => withConfig() });

    const outcome = await runScoring({
      client,
      event: updatedEvent(
        strongPerson({
          greenlightSuppressed: false,
          greenlightSuppressionReason: null,
        }),
        ['greenlightSuppressed', 'greenlightSuppressionReason'],
      ),
      now: NOW,
    });

    expect(outcome).toMatchObject({ status: 'scored', decision: 'PASS' });
  });
});

describe('retrigger guard — layer 2 (authored-write check)', () => {
  it('recognises a write that touched only Greenlight-owned fields', () => {
    expect(isGreenlightAuthoredWrite([...GREENLIGHT_MANAGED_PERSON_FIELDS])).toBe(
      true,
    );
    expect(isGreenlightAuthoredWrite(['greenlightScore'])).toBe(true);
  });

  it('lets a mixed write through', () => {
    expect(isGreenlightAuthoredWrite(['greenlightScore', 'jobTitle'])).toBe(
      false,
    );
  });

  it('scores when it does not know what changed', () => {
    // "Unknown" must mean "score it": skipping a real edit is unrecoverable,
    // whereas a redundant run is suppressed by layer 3 at zero cost.
    expect(isGreenlightAuthoredWrite([])).toBe(false);
    expect(isGreenlightAuthoredWrite(undefined)).toBe(false);
    expect(isGreenlightAuthoredWrite('greenlightScore')).toBe(false);
  });

  it('exits before touching the API', async () => {
    const client = createFakeClient();

    const outcome = await runScoring({
      client,
      event: updatedEvent(strongPerson(), ['greenlightScore', 'greenlightTrace']),
      now: NOW,
    });

    expect(outcome).toEqual({
      status: 'skipped',
      reason: 'greenlight_authored_write',
    });
    expect(client.calls).toHaveLength(0);
  });
});

describe('retrigger guard — layer 3 (outcome fingerprint)', () => {
  it('writes nothing when the stored fingerprint already matches', async () => {
    const person = strongPerson();
    const result = scoreLead({
      lead: toLeadRecord(person),
      now: NOW,
      config: toScoringConfigInput(configRecord()),
    });
    const fingerprint = fingerprintOutcome(
      result,
      toDecisionValue(result.decision, true),
    );

    const client = createFakeClient({ query: () => withConfig() });

    const outcome = await runScoring({
      client,
      event: createdEvent(
        strongPerson({ greenlightTrace: { fingerprint } }),
      ),
      now: NOW,
    });

    expect(outcome).toMatchObject({ status: 'unchanged', fingerprint });
    expect(client.mutationNames()).toHaveLength(0);
  });

  it('terminates the loop: replaying our own write-back is a no-op', async () => {
    // Simulate the worst case — both earlier guards bypassed — by feeding the
    // trace this run wrote straight back in as a second event.
    let written: Record<string, unknown> | null = null;

    const client = createFakeClient({
      query: () => withConfig(),
      mutation: (request) => {
        const update = request['updatePerson'] as
          | Record<string, unknown>
          | undefined;

        if (update !== undefined) {
          written = mutationData(update);
        }

        return {};
      },
    });

    const first = await runScoring({
      client,
      event: createdEvent(strongPerson()),
      now: NOW,
    });

    expect(first.status).toBe('scored');
    expect(written).not.toBeNull();

    const echoed = strongPerson({
      greenlightTrace: written!['greenlightTrace'],
      greenlightScore: written!['greenlightScore'],
      greenlightDecision: written!['greenlightDecision'],
      // A later clock, to prove the fingerprint ignores time.
      updatedAt: '2026-08-02T12:00:01.000Z',
    });

    const second = await runScoring({
      client,
      event: updatedEvent(echoed, ['greenlightScore', 'jobTitle']),
      now: new Date('2026-08-03T09:00:00.000Z'),
    });

    expect(second.status).toBe('unchanged');
  });

  it('does write again when the lead actually changed', async () => {
    const client = createFakeClient({ query: () => withConfig() });

    const first = await runScoring({
      client,
      event: createdEvent(strongPerson()),
      now: NOW,
    });
    const second = await runScoring({
      client,
      event: createdEvent(emptyPerson()),
      now: NOW,
    });

    expect(first.status).toBe('scored');
    expect(second.status).toBe('scored');
    expect(first).not.toMatchObject({ decision: (second as never)['decision'] });
  });
});

/* -------------------------------------------------------------------------- */
/* Write-back                                                                  */
/* -------------------------------------------------------------------------- */

describe('write-back', () => {
  it('writes score, decision and trace to the Person', async () => {
    const client = createFakeClient({ query: () => withConfig() });

    await runScoring({
      client,
      event: createdEvent(strongPerson()),
      now: NOW,
    });

    const data = mutationData(client.callsTo('updatePerson')[0]!);

    expect(Object.keys(data).sort()).toEqual([
      'greenlightDecision',
      'greenlightScore',
      'greenlightTrace',
    ]);
    expect(typeof data['greenlightScore']).toBe('number');
    expect(['PASS', 'GATE', 'UNSCORED']).toContain(data['greenlightDecision']);
  });

  it('appends an audit row carrying trace, score, band, decision and trace id', async () => {
    const client = createFakeClient({ query: () => withConfig() });

    const outcome = await runScoring({
      client,
      event: createdEvent(strongPerson()),
      now: NOW,
    });

    const data = mutationData(client.callsTo('createGreenlightAuditLog')[0]!);

    expect(data['traceId']).toBe((outcome as never)['traceId']);
    expect(data['leadRecordId']).toBe(strongPerson().id);
    expect(data['leadObjectNameSingular']).toBe('person');
    expect(data['leadDisplayName']).toBe('Jane Doe');
    expect(data['actorType']).toBe('SYSTEM');
    expect(['EXCELLENT', 'GOOD', 'FAIR', 'POOR', 'UNSCORED']).toContain(
      data['band'],
    );
    expect(Array.isArray((data['ruleTrace'] as never)['rules'])).toBe(true);
  });

  it('writes the audit row before the Person, so a half-failure over-records rather than losing an entry', async () => {
    const client = createFakeClient({ query: () => withConfig() });

    await runScoring({
      client,
      event: createdEvent(strongPerson()),
      now: NOW,
    });

    expect(client.mutationNames()).toEqual([
      'createGreenlightAuditLog',
      'updatePerson',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Fail-open                                                                   */
/* -------------------------------------------------------------------------- */

describe('fail-open', () => {
  it('scores with engine defaults when no config record exists', async () => {
    const client = createFakeClient({
      query: () => asConnection('greenlightConfigs', []),
    });

    const outcome = await runScoring({
      client,
      event: createdEvent(strongPerson()),
      now: NOW,
    });

    expect(outcome.status).toBe('scored');

    const trace = mutationData(client.callsTo('updatePerson')[0]!)[
      'greenlightTrace'
    ] as Record<string, unknown>;

    expect(trace['configSource']).toBe('defaults');
    expect((trace['degradations'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('does not throw when the config query fails, and leaves the lead flagged', async () => {
    let attempt = 0;
    const client = createFakeClient({
      query: () => {
        attempt += 1;
        throw new Error('config query exploded');
      },
    });

    const outcome = await runScoring({
      client,
      event: createdEvent(strongPerson()),
      now: NOW,
    });

    expect(attempt).toBe(1);
    expect(outcome.status).toBe('failed');

    const person = mutationData(client.callsTo('updatePerson')[0]!);

    expect(person['greenlightDecision']).toBe('UNSCORED');
    expect(
      mutationData(client.callsTo('createGreenlightAuditLog')[0]!)['eventType'],
    ).toBe('ERROR');
  });

  it('does not throw even when the fail-open write itself fails', async () => {
    const client = createFakeClient({
      query: () => {
        throw new Error('read failed');
      },
      mutation: () => {
        throw new Error('write failed');
      },
    });

    await expect(
      runScoring({
        client,
        event: createdEvent(strongPerson()),
        now: NOW,
      }),
    ).resolves.toMatchObject({ status: 'failed' });
  });

  it('records no fingerprint on a failed run, so the next event retries', async () => {
    const client = createFakeClient({
      query: () => {
        throw new Error('nope');
      },
    });

    await runScoring({
      client,
      event: createdEvent(strongPerson()),
      now: NOW,
    });

    const trace = mutationData(client.callsTo('updatePerson')[0]!)[
      'greenlightTrace'
    ] as Record<string, unknown>;

    expect(trace['fingerprint']).toBeUndefined();
  });

  it('scores without company data when the company read fails', async () => {
    const client = createFakeClient({
      query: (request) => {
        if ('companies' in request) {
          throw new Error('company read failed');
        }

        return withConfig();
      },
    });

    const outcome = await runScoring({
      client,
      // No pre-resolved `company`, so hydration is attempted and fails.
      event: createdEvent(strongPerson({ company: undefined })),
      now: NOW,
    });

    expect(outcome.status).toBe('scored');
  });

  it('hydrates the company with the fields the ICP rules and the exclusion gate read', async () => {
    // The engine can only score what the selection actually fetches: without
    // `industry`, `country` and `employeeCount` here, neither `icp.region`,
    // `icp.company-size`, `icp.industry` nor the exclusion gate can ever see a
    // value the company record genuinely holds. Pinned against
    // `backfillPersonSelection`, which must stay in lockstep.
    const client = createFakeClient({
      query: (request) => {
        if ('companies' in request) {
          return asConnection('companies', [
            {
              id: '22222222-2222-4222-8222-222222222222',
              name: 'Acme Ltd',
              industry: 'Manufacturing',
              country: 'AU',
              employeeCount: 250,
            },
          ]);
        }

        return withConfig({ icpRegions: ['AU'] });
      },
    });

    const outcome = await runScoring({
      client,
      event: createdEvent(strongPerson({ company: undefined })),
      now: NOW,
    });

    expect(outcome.status).toBe('scored');

    const companyNode = (
      client.callsTo('companies')[0] as Record<string, unknown>
    ) as { edges: { node: unknown } };

    expect(companyNode.edges.node).toEqual({
      id: true,
      name: true,
      industry: true,
      country: true,
      employeeCount: true,
    });

    // And the fetched fields genuinely reach the engine.
    const trace = mutationData(client.callsTo('updatePerson')[0]!)[
      'greenlightTrace'
    ] as { rules: { ruleId: string; observations: { mappedTo: string }[] }[] };

    const region = trace.rules.find((entry) => entry.ruleId === 'icp.region');

    expect(region?.observations[0]?.mappedTo).toBe('company.country');
  });

  it('blocks a lead whose hydrated company carries the EXCLUDED tag', async () => {
    const client = createFakeClient({
      query: (request) => {
        if ('companies' in request) {
          return asConnection('companies', [
            {
              id: '22222222-2222-4222-8222-222222222222',
              name: 'Acme Ltd',
              industry: 'EXCLUDED',
              country: 'AU',
              employeeCount: 250,
            },
          ]);
        }

        return withConfig();
      },
    });

    const outcome = await runScoring({
      client,
      event: createdEvent(strongPerson({ company: undefined })),
      now: NOW,
    });

    expect(outcome.status).toBe('scored');

    expect(
      mutationData(client.callsTo('updatePerson')[0]!)['greenlightDecision'],
    ).toBe('BLOCKED');
  });

  it('skips an event it cannot read rather than throwing', async () => {
    const client = createFakeClient();

    await expect(
      runScoring({ client, event: { properties: {} }, now: NOW }),
    ).resolves.toEqual({ status: 'skipped', reason: 'event_unreadable' });
  });
});

/* -------------------------------------------------------------------------- */
/* Decision mapping                                                            */
/* -------------------------------------------------------------------------- */

describe('decision mapping', () => {
  it('maps the engine vocabulary onto the SELECT vocabulary, one to one', () => {
    expect(toDecisionValue('approved', true)).toBe('PASS');
    expect(toDecisionValue('gated', true)).toBe('GATE');
    expect(toDecisionValue('blocked', true)).toBe('BLOCKED');
    expect(toDecisionValue('unscored', true)).toBe('UNSCORED');
  });

  it('releases gated leads when the gate is switched off', () => {
    expect(toDecisionValue('gated', false)).toBe('PASS');
  });

  it('still holds a compliance block when the gate is switched off', () => {
    // "Nothing is held for review" cannot be allowed to buy an opted-out
    // contact a PASS.
    expect(toDecisionValue('blocked', false)).toBe('BLOCKED');
  });

  it('records a compliance stop as BLOCKED end to end, and audits it as GATED', async () => {
    const client = createFakeClient({ query: () => withConfig() });

    await runScoring({
      client,
      event: createdEvent(optedOutPerson()),
      now: NOW,
    });

    expect(
      mutationData(client.callsTo('updatePerson')[0]!)['greenlightDecision'],
    ).toBe('BLOCKED');

    const audit = mutationData(client.callsTo('createGreenlightAuditLog')[0]!);

    expect(audit['decision']).toBe('BLOCKED');
    // The lead was held; which of the two holding states it landed in is the
    // `decision` column's job, not the event type's.
    expect(audit['eventType']).toBe('GATED');
  });

  it('honours isGateEnabled: false end to end', async () => {
    const gated = createFakeClient({ query: () => withConfig() });
    const ungated = createFakeClient({
      query: () => withConfig({ isGateEnabled: false }),
    });

    await runScoring({
      client: gated,
      event: createdEvent(emptyPerson()),
      now: NOW,
    });
    await runScoring({
      client: ungated,
      event: createdEvent(emptyPerson()),
      now: NOW,
    });

    expect(
      mutationData(gated.callsTo('updatePerson')[0]!)['greenlightDecision'],
    ).toBe('GATE');
    expect(
      mutationData(ungated.callsTo('updatePerson')[0]!)['greenlightDecision'],
    ).toBe('PASS');
  });
});

/* -------------------------------------------------------------------------- */
/* The human override                                                          */
/* -------------------------------------------------------------------------- */

const GATED_LEAD_ID = emptyPerson()['id'] as string;
const GATED_LEAD_KEY = releaseMarkerKey('person', GATED_LEAD_ID);

const releasedStore = (overrides: Partial<ReleaseMarker> = {}) =>
  createFakeMarkerStore({
    entries: {
      [GATED_LEAD_KEY]: aMarker({ recordId: GATED_LEAD_ID, ...overrides }),
    },
  });

describe('release marker — a human override is not undone by a re-score', () => {
  it('leaves a released lead at PASS when re-scoring would gate it again', async () => {
    const client = createFakeClient({ query: () => withConfig() });

    const outcome = await runScoring({
      client,
      event: updatedEvent(emptyPerson(), ['jobTitle']),
      now: NOW,
      markers: releasedStore(),
    });

    expect(outcome).toMatchObject({ status: 'scored', decision: 'PASS' });
    expect(
      mutationData(client.callsTo('updatePerson')[0]!)['greenlightDecision'],
    ).toBe('PASS');
  });

  it('looks the marker up under the key the override actually writes', async () => {
    const markers = createFakeMarkerStore();

    await runScoring({
      client: createFakeClient({ query: () => withConfig() }),
      event: updatedEvent(emptyPerson(), ['jobTitle']),
      now: NOW,
      markers,
    });

    expect(markers.reads).toEqual([GATED_LEAD_KEY]);
  });

  it('still updates the score and the trace on a pinned run', async () => {
    // The point of pinning only the decision: a released lead keeps being
    // scored, so the queue statistics and the explanation stay truthful.
    const client = createFakeClient({ query: () => withConfig() });

    await runScoring({
      client,
      event: updatedEvent(emptyPerson(), ['jobTitle']),
      now: NOW,
      markers: releasedStore(),
    });

    const written = mutationData(client.callsTo('updatePerson')[0]!);
    const trace = written['greenlightTrace'] as Record<string, unknown>;

    expect(typeof written['greenlightScore']).toBe('number');
    expect((trace['rules'] as unknown[]).length).toBeGreaterThan(0);
    expect(trace['decision']).toBe('PASS');
    // …and the record says why it reads PASS on a score that would gate it.
    expect(trace['releaseOverride']).toMatchObject({
      engineDecision: 'GATE',
      releasedBy: 'Workspace member 7',
      reasonCode: 'ICP_TOO_NARROW',
    });
  });

  it('records the honoured override on the audit row', async () => {
    const client = createFakeClient({ query: () => withConfig() });

    await runScoring({
      client,
      event: updatedEvent(emptyPerson(), ['jobTitle']),
      now: NOW,
      markers: releasedStore(),
    });

    const audit = mutationData(client.callsTo('createGreenlightAuditLog')[0]!);

    expect(audit['decision']).toBe('PASS');
    expect(audit['eventType']).toBe('SCORED');
    expect(audit['overrideReason']).toContain('RELEASE_MARKER_HONOURED');
    expect(audit['actorType']).toBe('SYSTEM');
  });

  it('does not consult the store when the lead was not going to be held', async () => {
    const markers = createFakeMarkerStore();

    await runScoring({
      client: createFakeClient({ query: () => withConfig() }),
      event: createdEvent(strongPerson()),
      now: NOW,
      markers,
    });

    expect(markers.reads).toEqual([]);
  });

  it('terminates: a second pinned run over an unchanged lead writes nothing', async () => {
    // The fingerprint is taken over the decision actually written, so pinning
    // must neither suppress the first write nor re-write forever.
    let written: Record<string, unknown> | null = null;

    const client = createFakeClient({
      query: () => withConfig(),
      mutation: (request) => {
        const update = request['updatePerson'] as
          | Record<string, unknown>
          | undefined;

        if (update !== undefined) {
          written = mutationData(update);
        }

        return {};
      },
    });

    const first = await runScoring({
      client,
      event: updatedEvent(emptyPerson(), ['jobTitle']),
      now: NOW,
      markers: releasedStore(),
    });

    expect(first).toMatchObject({ status: 'scored', decision: 'PASS' });

    const second = await runScoring({
      client,
      event: updatedEvent(
        emptyPerson({
          greenlightTrace: written!['greenlightTrace'],
          greenlightScore: written!['greenlightScore'],
          greenlightDecision: written!['greenlightDecision'],
        }),
        ['jobTitle'],
      ),
      now: new Date('2026-08-03T09:00:00.000Z'),
      markers: releasedStore(),
    });

    expect(second.status).toBe('unchanged');
  });

  it('writes on the first pinned run even though the stored fingerprint exists', async () => {
    // The lead was gated before the release, so it carries the GATE
    // fingerprint. Pinning changes the decision, so guard 3 must not suppress
    // the write that turns the record into a truthful PASS.
    const gatedResult = scoreLead({
      lead: toLeadRecord(emptyPerson()),
      now: NOW,
      config: toScoringConfigInput(configRecord()),
    });
    const gateFingerprint = fingerprintOutcome(gatedResult, 'GATE');

    const client = createFakeClient({ query: () => withConfig() });

    const outcome = await runScoring({
      client,
      event: updatedEvent(
        emptyPerson({ greenlightTrace: { fingerprint: gateFingerprint } }),
        ['jobTitle'],
      ),
      now: NOW,
      markers: releasedStore(),
    });

    expect(outcome).toMatchObject({ status: 'scored', decision: 'PASS' });
  });
});

describe('release marker — when the marker loses', () => {
  const blockedKey = releaseMarkerKey(
    'person',
    optedOutPerson()['id'] as string,
  );

  const blockedStore = (options: { failDelete?: boolean } = {}) =>
    createFakeMarkerStore({
      entries: {
        [blockedKey]: aMarker({ recordId: optedOutPerson()['id'] as string }),
      },
      failDelete: options.failDelete,
    });

  it('re-gates a released lead that has since picked up a blocking compliance failure', async () => {
    const client = createFakeClient({ query: () => withConfig() });
    const markers = blockedStore();

    const outcome = await runScoring({
      client,
      event: updatedEvent(optedOutPerson(), ['emails']),
      now: NOW,
      markers,
    });

    expect(outcome).toMatchObject({ status: 'scored', decision: 'BLOCKED' });
    expect(
      mutationData(client.callsTo('updatePerson')[0]!)['greenlightDecision'],
    ).toBe('BLOCKED');
  });

  it('clears the marker so the override does not resurrect itself', async () => {
    const markers = blockedStore();

    await runScoring({
      client: createFakeClient({ query: () => withConfig() }),
      event: updatedEvent(optedOutPerson(), ['emails']),
      now: NOW,
      markers,
    });

    expect(markers.deletes).toEqual([blockedKey]);
    expect(await markers.get(blockedKey)).toBeNull();
  });

  it('re-gates anyway when the marker cannot be deleted', async () => {
    // A surviving marker is self-correcting: the next run re-evaluates the same
    // blocking rule and re-holds the lead. What must never happen is the
    // delete failure taking the re-gating down with it.
    const client = createFakeClient({ query: () => withConfig() });

    const outcome = await runScoring({
      client,
      event: updatedEvent(optedOutPerson(), ['emails']),
      now: NOW,
      markers: blockedStore({ failDelete: true }),
    });

    expect(outcome).toMatchObject({ status: 'scored', decision: 'BLOCKED' });
  });
});

describe('release marker — key-value failures', () => {
  it('re-gates rather than releasing when the store cannot be read', async () => {
    // The chosen direction, and the reasoning is asymmetric: wrongly re-gating
    // a released lead is an annoyance a human fixes in one click, and the audit
    // trail says what happened. Wrongly releasing a held lead — including one
    // held on compliance grounds — is not recoverable, because nobody knows.
    const client = createFakeClient({ query: () => withConfig() });

    const outcome = await runScoring({
      client,
      event: updatedEvent(emptyPerson(), ['jobTitle']),
      now: NOW,
      markers: createFakeMarkerStore({ failGet: true }),
    });

    expect(outcome).toMatchObject({ status: 'scored', decision: 'GATE' });
    expect(
      mutationData(client.callsTo('updatePerson')[0]!)['greenlightDecision'],
    ).toBe('GATE');
  });

  it('does not swallow the failure silently', async () => {
    const logged: string[] = [];
    const log = console.log;

    console.log = (line: unknown) => {
      logged.push(String(line));
    };

    try {
      await runScoring({
        client: createFakeClient({ query: () => withConfig() }),
        event: updatedEvent(emptyPerson(), ['jobTitle']),
        now: NOW,
        markers: createFakeMarkerStore({ failGet: true }),
      });
    } finally {
      console.log = log;
    }

    expect(
      logged.some((line) => line.includes('release_marker_read_failed')),
    ).toBe(true);
  });

  it('does not fail the run when the store is unreadable', async () => {
    await expect(
      runScoring({
        client: createFakeClient({ query: () => withConfig() }),
        event: updatedEvent(emptyPerson(), ['jobTitle']),
        now: NOW,
        markers: createFakeMarkerStore({ failGet: true }),
      }),
    ).resolves.toMatchObject({ status: 'scored' });
  });
});
