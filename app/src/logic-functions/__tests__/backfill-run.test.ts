import { beforeEach, describe, expect, it } from 'vitest';

import { BACKFILL_LEASE_MS, toBackfillState } from 'src/backfill/backfill-state';
import { releaseMarkerKey, type ReleaseMarker } from 'src/gate/release-decision';
import {
  readBackfillStatus,
  requestInstallBackfill,
  runBackfillChunk,
  startBackfill,
  stopBackfill,
  type BackfillStateStore,
} from 'src/logic-functions/backfill-run';
import { buildGreenlightConfigSeed } from 'src/logic-functions/greenlight-config-record';
import type { GreenlightApiClient } from 'src/logic-functions/greenlight-api';
import type { ReleaseMarkerStore } from 'src/logic-functions/scoring-run';

const NOW = new Date('2026-08-02T12:00:00.000Z');

const later = (minutes: number): Date =>
  new Date(NOW.getTime() + minutes * 60_000);

/* -------------------------------------------------------------------------- */
/* A workspace you can crash                                                   */
/* -------------------------------------------------------------------------- */

interface FakeStore extends BackfillStateStore {
  /** Whatever is currently persisted, as the cron would read it back. */
  peek(): unknown;
  readonly writes: () => number;
}

/**
 * Round-trips through JSON on every read and write, because that is what app
 * key-value storage does — and a state that survives in memory but not through
 * `JSON.parse(JSON.stringify(...))` would resume fine in a test and not at all in
 * a workspace.
 */
const createFakeStore = (
  options: {
    failRead?: boolean;
    /** 1-based write number that should throw, simulating a lost commit. */
    failWriteNumber?: number;
    initial?: unknown;
  } = {},
): FakeStore => {
  let value: unknown = options.initial ?? null;
  let writes = 0;

  return {
    peek: () => (value === null ? null : JSON.parse(JSON.stringify(value))),
    writes: () => writes,
    async read() {
      if (options.failRead === true) {
        throw new Error('key-value store unreachable');
      }

      return value === null ? null : JSON.parse(JSON.stringify(value));
    },
    async write(state) {
      writes += 1;

      if (options.failWriteNumber === writes) {
        throw new Error('key-value write failed');
      }

      value = JSON.parse(JSON.stringify(state));
    },
  };
};

const createMarkerStore = (
  entries: Record<string, ReleaseMarker> = {},
): ReleaseMarkerStore => ({
  async get(key) {
    return entries[key] ?? null;
  },
  async delete(key) {
    delete entries[key];
  },
});

interface FakeWorkspace {
  readonly client: GreenlightApiClient;
  readonly people: Record<string, unknown>[];
  readonly auditRows: Record<string, unknown>[];
  readonly personWrites: string[];
  readonly queries: Record<string, unknown>[];
}

const applyFilter = (
  person: Record<string, unknown>,
  filter: unknown,
): boolean => {
  if (typeof filter !== 'object' || filter === null) {
    return true;
  }

  const clauses = filter as Record<string, Record<string, unknown>>;

  if (clauses['greenlightDecision']?.['is'] === 'NULL') {
    const decision = person['greenlightDecision'];

    if (decision !== null && decision !== undefined) {
      return false;
    }
  }

  const gte = clauses['createdAt']?.['gte'];

  if (typeof gte === 'string' && String(person['createdAt']) < gte) {
    return false;
  }

  return true;
};

/**
 * A workspace that answers the four calls the backfill makes, holds the writes,
 * and can be told to fail on cue.
 */
const createWorkspace = (
  people: Record<string, unknown>[],
  options: {
    /** Ids whose `updatePerson` throws — "a record that throws". */
    failWritesFor?: readonly string[];
    /** Reject any page query naming this field in its selection. */
    rejectSelectionField?: string;
    /** Reject any page query that carries an `orderBy`. */
    rejectOrderBy?: boolean;
    failConfigRead?: boolean;
    config?: Record<string, unknown>;
  } = {},
): FakeWorkspace => {
  const auditRows: Record<string, unknown>[] = [];
  const personWrites: string[] = [];
  const queries: Record<string, unknown>[] = [];
  const failWrites = new Set(options.failWritesFor ?? []);

  const config = {
    id: 'config-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...buildGreenlightConfigSeed(),
    ...(options.config ?? {}),
  };

  const client: GreenlightApiClient = {
    async query(request) {
      queries.push(request);

      if ('greenlightConfigs' in request) {
        if (options.failConfigRead === true) {
          throw new Error('config read failed');
        }

        return { greenlightConfigs: { edges: [{ node: config }] } };
      }

      const spec = request['people'] as Record<string, unknown>;
      const args = (spec['__args'] ?? {}) as Record<string, unknown>;
      const matching = people.filter((person) =>
        applyFilter(person, args['filter']),
      );

      if (spec['totalCount'] === true) {
        return { people: { totalCount: matching.length } };
      }

      if (options.rejectOrderBy === true && args['orderBy'] !== undefined) {
        throw new Error('Unknown argument "orderBy"');
      }

      const selection = (spec['edges'] as Record<string, unknown>)['node'] as
        | Record<string, unknown>
        | undefined;

      if (
        options.rejectSelectionField !== undefined &&
        selection !== undefined &&
        options.rejectSelectionField in selection
      ) {
        throw new Error(
          `Cannot query field "${options.rejectSelectionField}" on type "Person"`,
        );
      }

      const ordered =
        args['orderBy'] === undefined
          ? matching
          : [...matching].sort((left, right) =>
              String(left['createdAt']) < String(right['createdAt']) ? -1 : 1,
            );

      const first = typeof args['first'] === 'number' ? args['first'] : 60;

      return {
        people: {
          edges: ordered.slice(0, first).map((node) => ({ node })),
        },
      };
    },
    async mutation(request) {
      if ('createGreenlightAuditLog' in request) {
        const call = request['createGreenlightAuditLog'] as Record<
          string,
          unknown
        >;

        auditRows.push(
          ((call['__args'] as Record<string, unknown>)['data'] ??
            {}) as Record<string, unknown>,
        );

        return { createGreenlightAuditLog: { id: `audit-${auditRows.length}` } };
      }

      const call = request['updatePerson'] as Record<string, unknown>;
      const args = call['__args'] as Record<string, unknown>;
      const id = String(args['id']);

      if (failWrites.has(id)) {
        throw new Error('person write failed');
      }

      personWrites.push(id);

      const person = people.find((candidate) => candidate['id'] === id);

      if (person !== undefined) {
        Object.assign(person, args['data'] as Record<string, unknown>);
      }

      return { updatePerson: { id } };
    },
  };

  return { client, people, auditRows, personWrites, queries };
};

const uuid = (n: number): string =>
  `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;

/** A lead good enough to clear the default gate. */
const strongPerson = (
  n: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: uuid(n),
  createdAt: `2025-01-${String(n).padStart(2, '0')}T00:00:00.000Z`,
  updatedAt: '2026-08-01T00:00:00.000Z',
  name: { firstName: 'Jane', lastName: `Doe${n}` },
  emails: { primaryEmail: `jane${n}@acme.com` },
  phones: { primaryPhoneNumber: '+441234567890' },
  jobTitle: 'Chief Technology Officer',
  companyId: uuid(900 + n),
  company: { id: uuid(900 + n), name: 'Acme Ltd' },
  greenlightSuppressed: false,
  greenlightDecision: null,
  greenlightScore: null,
  greenlightTrace: null,
  ...extra,
});

/** A lead the gate should hold. */
const weakPerson = (
  n: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  ...strongPerson(n),
  name: {},
  emails: {},
  phones: {},
  jobTitle: null,
  companyId: null,
  company: null,
  ...extra,
});

/** Everything except the backfill's own run-level rows. */
const scoringAuditRows = (workspace: FakeWorkspace) =>
  workspace.auditRows.filter((row) => row['eventType'] !== 'BACKFILL');

const drain = async (
  workspace: FakeWorkspace,
  store: FakeStore,
  options: {
    chunkSize?: number;
    markers?: ReleaseMarkerStore;
    ticks?: number;
    /** Minute of the first tick — used to step past a stranded lease. */
    startMinute?: number;
  } = {},
) => {
  const outcomes = [];

  for (let tick = 0; tick < (options.ticks ?? 20); tick += 1) {
    const outcome = await runBackfillChunk({
      client: workspace.client,
      store,
      markers: options.markers ?? createMarkerStore(),
      now: later((options.startMinute ?? 0) + tick),
      chunkSize: options.chunkSize ?? 2,
    });

    outcomes.push(outcome);

    if (outcome.status !== 'progressed' || outcome.exhausted) {
      break;
    }
  }

  return outcomes;
};

/* -------------------------------------------------------------------------- */
/* Tests                                                                       */
/* -------------------------------------------------------------------------- */

describe('runBackfillChunk — the basics', () => {
  let store: FakeStore;

  beforeEach(() => {
    store = createFakeStore();
  });

  it('should do nothing at all when no backfill has been requested', async () => {
    const workspace = createWorkspace([strongPerson(1)]);

    const outcome = await runBackfillChunk({
      client: workspace.client,
      store,
      markers: createMarkerStore(),
      now: NOW,
    });

    expect(outcome.status).toBe('no_run');
    expect(workspace.personWrites).toEqual([]);
  });

  it('should stop acting once the run is finished', async () => {
    const workspace = createWorkspace([strongPerson(1)]);

    await startBackfill({
      client: workspace.client,
      store,
      now: NOW,
      mode: 'unscored',
      requestedBy: 'test',
    });
    await drain(workspace, store);

    const after = await runBackfillChunk({
      client: workspace.client,
      store,
      markers: createMarkerStore(),
      now: later(30),
    });

    expect(after).toEqual({ status: 'not_running', runStatus: 'completed' });
  });

  it('should refuse to start a second tick while one holds the lease', async () => {
    const workspace = createWorkspace([strongPerson(1), strongPerson(2)]);

    await startBackfill({
      client: workspace.client,
      store,
      now: NOW,
      mode: 'unscored',
      requestedBy: 'test',
    });

    // A tick that took the lease and never came back — i.e. one still running.
    const state = toBackfillState(store.peek());
    await store.write({
      ...state!,
      leaseUntil: new Date(NOW.getTime() + BACKFILL_LEASE_MS).toISOString(),
    });

    const outcome = await runBackfillChunk({
      client: workspace.client,
      store,
      markers: createMarkerStore(),
      now: later(1),
      chunkSize: 2,
    });

    expect(outcome.status).toBe('locked');
    expect(workspace.personWrites).toEqual([]);
  });

  it('should pick the run up again once a killed tick’s lease expires', async () => {
    const workspace = createWorkspace([strongPerson(1)]);

    await startBackfill({
      client: workspace.client,
      store,
      now: NOW,
      mode: 'unscored',
      requestedBy: 'test',
    });

    const state = toBackfillState(store.peek());
    await store.write({
      ...state!,
      leaseUntil: new Date(NOW.getTime() + BACKFILL_LEASE_MS).toISOString(),
    });

    // The lease is the entire cost of a crash: nothing else holds the run back.
    const outcome = await runBackfillChunk({
      client: workspace.client,
      store,
      markers: createMarkerStore(),
      now: new Date(NOW.getTime() + BACKFILL_LEASE_MS + 1_000),
      chunkSize: 2,
    });

    expect(outcome.status).toBe('progressed');
    expect(workspace.personWrites).toEqual([uuid(1)]);
  });
});

describe('runBackfillChunk — resumability', () => {
  it('should walk a workspace in bounded chunks and finish', async () => {
    const store = createFakeStore();
    const workspace = createWorkspace(
      [1, 2, 3, 4, 5].map((n) => strongPerson(n)),
    );

    await startBackfill({
      client: workspace.client,
      store,
      now: NOW,
      mode: 'unscored',
      requestedBy: 'test',
    });

    const outcomes = await drain(workspace, store, { chunkSize: 2 });

    // 2 + 2 + 1: the short page is what proves the walk is over.
    expect(outcomes.map((o) => o.status)).toEqual([
      'progressed',
      'progressed',
      'progressed',
    ]);
    expect(outcomes[outcomes.length - 1]).toMatchObject({ exhausted: true });

    const state = toBackfillState(store.peek());

    expect(state?.status).toBe('completed');
    expect(state?.tally).toMatchObject({ examined: 5, scored: 5, failed: 0 });
    expect(new Set(workspace.personWrites)).toEqual(
      new Set([1, 2, 3, 4, 5].map(uuid)),
    );
  });

  it('should read the config once per chunk, not once per record', async () => {
    // This is the refactor `PreloadedConfig` exists for, and the single largest
    // line in the request arithmetic: per-record config reads would treble the
    // backfill's share of the rate limit to buy thirty identical answers.
    const store = createFakeStore();
    const workspace = createWorkspace(
      [1, 2, 3, 4, 5].map((n) => strongPerson(n)),
    );

    await startBackfill({
      client: workspace.client,
      store,
      now: NOW,
      mode: 'unscored',
      requestedBy: 'test',
    });

    const before = workspace.queries.filter(
      (query) => 'greenlightConfigs' in query,
    ).length;

    await runBackfillChunk({
      client: workspace.client,
      store,
      markers: createMarkerStore(),
      now: NOW,
      chunkSize: 5,
    });

    expect(
      workspace.queries.filter((query) => 'greenlightConfigs' in query).length -
        before,
    ).toBe(1);
    expect(workspace.personWrites).toHaveLength(5);
  });

  it('should continue rather than restart when a tick is interrupted', async () => {
    const store = createFakeStore();
    const workspace = createWorkspace(
      [1, 2, 3, 4].map((n) => strongPerson(n)),
    );

    await startBackfill({
      client: workspace.client,
      store,
      now: NOW,
      mode: 'unscored',
      requestedBy: 'test',
    });

    await runBackfillChunk({
      client: workspace.client,
      store,
      markers: createMarkerStore(),
      now: NOW,
      chunkSize: 2,
    });

    const midpoint = toBackfillState(store.peek());

    expect(midpoint?.cursor.createdAt).toBe('2025-01-02T00:00:00.000Z');
    expect(midpoint?.tally.examined).toBe(2);

    await drain(workspace, store, { chunkSize: 2 });

    // Four records, four scored, no record examined twice: the cursor is what
    // makes the second tick continue rather than start again.
    expect(toBackfillState(store.peek())?.tally).toMatchObject({
      examined: 4,
      scored: 4,
      unchanged: 0,
    });
  });

  it('should stop mid-page when the tick budget runs out and resume from exactly there', async () => {
    const store = createFakeStore();
    const workspace = createWorkspace(
      [1, 2, 3, 4].map((n) => strongPerson(n)),
    );

    await startBackfill({
      client: workspace.client,
      store,
      now: NOW,
      mode: 'unscored',
      requestedBy: 'test',
    });

    // A clock that is already past the budget after the first record, so the
    // tick commits a one-record prefix out of a four-record page.
    let reading = 0;
    const impatient = () => {
      reading += 1;
      return reading === 1 ? 0 : 10_000_000;
    };

    await runBackfillChunk({
      client: workspace.client,
      store,
      markers: createMarkerStore(),
      now: NOW,
      chunkSize: 4,
      clock: impatient,
    });

    const partial = toBackfillState(store.peek());

    expect(partial?.tally.examined).toBe(1);
    expect(partial?.cursor.createdAt).toBe('2025-01-01T00:00:00.000Z');
    // A short page that ran out of budget proves nothing about the walk.
    expect(partial?.status).toBe('running');

    await drain(workspace, store, { chunkSize: 4 });

    expect(toBackfillState(store.peek())).toMatchObject({
      status: 'completed',
      tally: { examined: 4, scored: 4 },
    });
  });

  it('should lose at most one chunk when the commit itself is lost', async () => {
    // The truest crash: records were scored, and the process died before the
    // position could be written. The next tick redoes the page.
    const store = createFakeStore({ failWriteNumber: 3 });
    const workspace = createWorkspace([1, 2].map((n) => strongPerson(n)));

    // `all` rather than `unscored`, so the redo genuinely re-reads the records
    // rather than being saved by a filter they no longer match. This is the
    // guard-3 demonstration, not the filter's.
    await startBackfill({
      client: workspace.client,
      store,
      now: NOW,
      mode: 'all',
      requestedBy: 'test',
    });

    // Writes: 1 = start, 2 = lease claim, 3 = commit (fails).
    await runBackfillChunk({
      client: workspace.client,
      store,
      markers: createMarkerStore(),
      now: NOW,
      chunkSize: 2,
    });

    const stranded = toBackfillState(store.peek());

    expect(stranded?.cursor.createdAt).toBeNull();
    expect(stranded?.tally.examined).toBe(0);
    // The records were nonetheless written — the lost commit lost the position,
    // not the work.
    expect(workspace.personWrites).toHaveLength(2);
    expect(scoringAuditRows(workspace)).toHaveLength(2);

    // The stranded lease is the whole cost of the crash — three minutes on, the
    // run picks itself back up with no intervention.
    await drain(workspace, store, { chunkSize: 2, startMinute: 3 });

    // The redo re-reads both records and writes neither: guard 3 recognises the
    // stored fingerprint. No duplicate audit rows, no duplicate person writes.
    expect(workspace.personWrites).toHaveLength(2);
    expect(scoringAuditRows(workspace)).toHaveLength(2);
    expect(toBackfillState(store.peek())).toMatchObject({
      status: 'completed',
      tally: { unchanged: 2, scored: 0 },
    });
  });
});

describe('runBackfillChunk — idempotency', () => {
  it('should write nothing on a second pass over already-scored records', async () => {
    const store = createFakeStore();
    const workspace = createWorkspace(
      [1, 2, 3].map((n) => strongPerson(n)),
    );

    await startBackfill({
      client: workspace.client,
      store,
      now: NOW,
      mode: 'unscored',
      requestedBy: 'test',
    });
    await drain(workspace, store, { chunkSize: 3 });

    const writesAfterFirstPass = workspace.personWrites.length;
    const rowsAfterFirstPass = scoringAuditRows(workspace).length;

    expect(writesAfterFirstPass).toBe(3);
    expect(rowsAfterFirstPass).toBe(3);

    // Re-scoring everything, deliberately, over a workspace that is current.
    await startBackfill({
      client: workspace.client,
      store,
      now: later(10),
      mode: 'all',
      requestedBy: 'test',
    });
    await drain(workspace, store, { chunkSize: 3 });

    expect(workspace.personWrites).toHaveLength(writesAfterFirstPass);
    expect(scoringAuditRows(workspace)).toHaveLength(rowsAfterFirstPass);
    expect(toBackfillState(store.peek())?.tally).toMatchObject({
      examined: 3,
      scored: 0,
      unchanged: 3,
    });
  });
});

describe('runBackfillChunk — a record that throws', () => {
  it('should log and skip it without stalling the queue', async () => {
    const store = createFakeStore();
    const workspace = createWorkspace(
      [1, 2, 3].map((n) => strongPerson(n)),
      { failWritesFor: [uuid(2)] },
    );

    await startBackfill({
      client: workspace.client,
      store,
      now: NOW,
      mode: 'unscored',
      requestedBy: 'test',
    });

    const outcomes = await drain(workspace, store, { chunkSize: 1 });

    expect(outcomes[outcomes.length - 1]).toMatchObject({ exhausted: true });
    expect(toBackfillState(store.peek())).toMatchObject({
      status: 'completed',
      tally: { examined: 3, scored: 2, failed: 1 },
    });

    // The good records either side of the bad one are scored.
    expect(workspace.personWrites).toContain(uuid(1));
    expect(workspace.personWrites).toContain(uuid(3));

    // And the failure left a trail rather than a silent gap: the fail-open path
    // appended an ERROR row before giving up on the record.
    expect(
      scoringAuditRows(workspace).filter((row) => row['eventType'] === 'ERROR'),
    ).toHaveLength(1);
  });
});

describe('runBackfillChunk — released leads', () => {
  it('should honour a human release rather than re-gating it in bulk', async () => {
    const store = createFakeStore();
    const released = weakPerson(1);
    const workspace = createWorkspace([released]);

    const markers = createMarkerStore({
      [releaseMarkerKey('person', uuid(1))]: {
        leadObjectNameSingular: 'person',
        recordId: uuid(1),
        releasedAt: '2026-07-01T00:00:00.000Z',
        releasedBy: 'Workspace member 7',
        reasonCode: 'KNOWN_ACCOUNT',
      },
    });

    await startBackfill({
      client: workspace.client,
      store,
      now: NOW,
      mode: 'all',
      requestedBy: 'test',
    });
    await drain(workspace, store, { chunkSize: 1, markers });

    // The lead scores badly and would be held — the marker pins it to PASS,
    // through exactly the same `pinReleasedDecision` the event path uses.
    expect(released['greenlightDecision']).toBe('PASS');
    expect(
      (released['greenlightTrace'] as Record<string, unknown>)[
        'releaseOverride'
      ],
    ).toMatchObject({ engineDecision: 'GATE', reasonCode: 'KNOWN_ACCOUNT' });
  });

  it('should hold a lead with no release marker, so the pin is doing the work', async () => {
    const store = createFakeStore();
    const held = weakPerson(1);
    const workspace = createWorkspace([held]);

    await startBackfill({
      client: workspace.client,
      store,
      now: NOW,
      mode: 'all',
      requestedBy: 'test',
    });
    await drain(workspace, store, { chunkSize: 1 });

    expect(held['greenlightDecision']).toBe('GATE');
  });

  it('should never reach a released lead at all in the default mode', async () => {
    // A released lead reads PASS, so it does not match `decision is NULL`. Only
    // an explicit re-score of everything can touch it.
    const store = createFakeStore();
    const released = weakPerson(1, { greenlightDecision: 'PASS' });
    const workspace = createWorkspace([released, strongPerson(2)]);

    await startBackfill({
      client: workspace.client,
      store,
      now: NOW,
      mode: 'unscored',
      requestedBy: 'test',
    });
    await drain(workspace, store, { chunkSize: 5 });

    expect(workspace.personWrites).toEqual([uuid(2)]);
  });
});

describe('runBackfillChunk — suppression', () => {
  it('should block a suppressed lead it is meeting for the first time', async () => {
    // The page selection carries the suppression register. Omitting it would
    // make every bulk-scored opt-out come back "nothing on this record says",
    // and the workspace's whole do-not-contact list would be ignored for exactly
    // the records nobody has checked.
    const store = createFakeStore();
    const suppressed = strongPerson(1, {
      greenlightSuppressed: true,
      greenlightSuppressionReason: 'UNSUBSCRIBED',
    });
    const workspace = createWorkspace([suppressed]);

    await startBackfill({
      client: workspace.client,
      store,
      now: NOW,
      mode: 'unscored',
      requestedBy: 'test',
    });
    await drain(workspace, store, { chunkSize: 1 });

    expect(suppressed['greenlightDecision']).toBe('BLOCKED');
  });
});

describe('runBackfillChunk — failing safely', () => {
  it('should abandon the tick rather than score a chunk on the wrong config', async () => {
    const store = createFakeStore();
    const workspace = createWorkspace([strongPerson(1)], {
      failConfigRead: true,
    });

    await startBackfill({
      client: workspace.client,
      store,
      now: NOW,
      mode: 'unscored',
      requestedBy: 'test',
    });

    const outcome = await runBackfillChunk({
      client: workspace.client,
      store,
      markers: createMarkerStore(),
      now: NOW,
      chunkSize: 2,
    });

    expect(outcome.status).toBe('config_unavailable');
    expect(workspace.personWrites).toEqual([]);

    const state = toBackfillState(store.peek());

    // Lease given back, position untouched, reason recorded for the panel.
    expect(state?.leaseUntil).toBeNull();
    expect(state?.cursor.createdAt).toBeNull();
    expect(state?.lastError).toContain('config read failed');
  });

  it('should drop the workspace’s custom field names before giving up on a page', async () => {
    const store = createFakeStore();
    const workspace = createWorkspace([strongPerson(1)], {
      rejectSelectionField: 'seniorityLevel',
      config: { decisionMakerFieldName: 'seniorityLevel' },
    });

    await startBackfill({
      client: workspace.client,
      store,
      now: NOW,
      mode: 'unscored',
      requestedBy: 'test',
    });

    const outcome = await runBackfillChunk({
      client: workspace.client,
      store,
      markers: createMarkerStore(),
      now: NOW,
      chunkSize: 2,
    });

    expect(outcome).toMatchObject({ status: 'progressed', degraded: true });
    expect(workspace.personWrites).toEqual([uuid(1)]);
    expect(toBackfillState(store.peek())?.lastError).toContain('reduced query');
  });

  it('should still drain without ordering support, because the default filter is the queue', async () => {
    const store = createFakeStore();
    const workspace = createWorkspace(
      [1, 2, 3].map((n) => strongPerson(n)),
      { rejectOrderBy: true },
    );

    await startBackfill({
      client: workspace.client,
      store,
      now: NOW,
      mode: 'unscored',
      requestedBy: 'test',
    });
    await drain(workspace, store, { chunkSize: 2 });

    // A record it scores stops matching `greenlightDecision is NULL`, so asking
    // repeatedly for "the next two unscored" drains the workspace with no cursor
    // and no ordering at all.
    expect(new Set(workspace.personWrites)).toEqual(
      new Set([1, 2, 3].map(uuid)),
    );
    expect(toBackfillState(store.peek())?.status).toBe('completed');
  });

  it('should stall visibly rather than walk randomly when a full re-score cannot be ordered', async () => {
    const store = createFakeStore();
    const workspace = createWorkspace([strongPerson(1)], {
      rejectOrderBy: true,
    });

    await startBackfill({
      client: workspace.client,
      store,
      now: NOW,
      mode: 'all',
      requestedBy: 'test',
    });

    const outcome = await runBackfillChunk({
      client: workspace.client,
      store,
      markers: createMarkerStore(),
      now: NOW,
      chunkSize: 2,
    });

    expect(outcome.status).toBe('page_failed');
    expect(toBackfillState(store.peek())?.lastError).toContain('orderBy');
    expect(workspace.personWrites).toEqual([]);
  });

  it('should never throw when the state store is unreadable', async () => {
    const workspace = createWorkspace([strongPerson(1)]);

    const outcome = await runBackfillChunk({
      client: workspace.client,
      store: createFakeStore({ failRead: true }),
      markers: createMarkerStore(),
      now: NOW,
    });

    expect(outcome.status).toBe('state_unreadable');
  });

  it('should not touch a record when it cannot record that it started', async () => {
    const workspace = createWorkspace([strongPerson(1)]);
    // Write 1 is the start; write 2 is the lease claim.
    const store = createFakeStore({ failWriteNumber: 2 });

    await startBackfill({
      client: workspace.client,
      store,
      now: NOW,
      mode: 'unscored',
      requestedBy: 'test',
    });

    const outcome = await runBackfillChunk({
      client: workspace.client,
      store,
      markers: createMarkerStore(),
      now: NOW,
      chunkSize: 2,
    });

    expect(outcome.status).toBe('lease_not_taken');
    expect(workspace.personWrites).toEqual([]);
  });
});

describe('the control surface', () => {
  it('should tell an admin how many leads nothing has ever looked at', async () => {
    const workspace = createWorkspace([
      strongPerson(1),
      strongPerson(2, { greenlightDecision: 'PASS' }),
    ]);

    const result = await readBackfillStatus({
      client: workspace.client,
      store: createFakeStore(),
      now: NOW,
    });

    expect(result.body.outcome).toBe('no_run');
    expect(result.body.neverScoredCount).toBe(1);
    expect(result.body.message).toContain('never been scored');
  });

  it('should report progress of a live run in one round trip', async () => {
    const store = createFakeStore();
    const workspace = createWorkspace(
      [1, 2, 3, 4].map((n) => strongPerson(n)),
    );

    await startBackfill({
      client: workspace.client,
      store,
      now: NOW,
      mode: 'unscored',
      requestedBy: 'Workspace member 7',
    });
    await runBackfillChunk({
      client: workspace.client,
      store,
      markers: createMarkerStore(),
      now: NOW,
      chunkSize: 2,
    });

    const result = await readBackfillStatus({
      client: workspace.client,
      store,
      now: later(1),
    });

    expect(result.body.outcome).toBe('running');
    expect(result.body.run).toMatchObject({
      examined: 2,
      totalAtStart: 4,
      percent: 50,
      requestedBy: 'Workspace member 7',
    });
    expect(result.body.neverScoredCount).toBe(2);
  });

  it('should show the running run rather than starting a second one', async () => {
    const store = createFakeStore();
    const workspace = createWorkspace([strongPerson(1), strongPerson(2)]);

    const first = await startBackfill({
      client: workspace.client,
      store,
      now: NOW,
      mode: 'unscored',
      requestedBy: 'test',
    });

    const second = await startBackfill({
      client: workspace.client,
      store,
      now: later(1),
      mode: 'all',
      requestedBy: 'test',
    });

    expect(second.body.outcome).toBe('already_running');
    expect(second.body.run?.runId).toBe(first.body.run?.runId);
    expect(second.body.run?.mode).toBe('unscored');
  });

  it('should stop a run and leave the scored records alone', async () => {
    const store = createFakeStore();
    const workspace = createWorkspace(
      [1, 2, 3, 4].map((n) => strongPerson(n)),
    );

    await startBackfill({
      client: workspace.client,
      store,
      now: NOW,
      mode: 'unscored',
      requestedBy: 'test',
    });
    await runBackfillChunk({
      client: workspace.client,
      store,
      markers: createMarkerStore(),
      now: NOW,
      chunkSize: 2,
    });

    const stopped = await stopBackfill({
      client: workspace.client,
      store,
      now: later(1),
      requestedBy: 'Workspace member 9',
    });

    expect(stopped.body.outcome).toBe('stopped');
    expect(workspace.personWrites).toHaveLength(2);

    const after = await runBackfillChunk({
      client: workspace.client,
      store,
      markers: createMarkerStore(),
      now: later(2),
      chunkSize: 2,
    });

    expect(after).toEqual({ status: 'not_running', runStatus: 'cancelled' });
  });

  it('should record who asked for a run, and that it started, in the audit log', async () => {
    const workspace = createWorkspace([strongPerson(1)]);

    await startBackfill({
      client: workspace.client,
      store: createFakeStore(),
      now: NOW,
      mode: 'all',
      requestedBy: 'Workspace member 7',
    });

    const row = workspace.auditRows.find(
      (candidate) =>
        (candidate['ruleTrace'] as Record<string, unknown>)['action'] ===
        'backfill_started',
    );

    expect(row?.['eventType']).toBe('BACKFILL');
    expect(row?.['ruleTrace']).toMatchObject({
      mode: 'all',
      requestedBy: 'Workspace member 7',
    });
  });
});

describe('requestInstallBackfill', () => {
  it('should start the default run on a workspace with unscored leads', async () => {
    const store = createFakeStore();
    const workspace = createWorkspace([strongPerson(1), strongPerson(2)]);

    const result = await requestInstallBackfill({
      client: workspace.client,
      store,
      now: NOW,
    });

    expect(result).toMatchObject({ status: 'requested', totalAtStart: 2 });
    expect(toBackfillState(store.peek())).toMatchObject({
      mode: 'unscored',
      status: 'running',
      requestedBy: 'install',
    });
  });

  it('should do nothing on the retries and upgrades that re-run the hook', async () => {
    const store = createFakeStore();
    const workspace = createWorkspace([strongPerson(1)]);

    await requestInstallBackfill({ client: workspace.client, store, now: NOW });

    const again = await requestInstallBackfill({
      client: workspace.client,
      store,
      now: later(1),
    });

    expect(again).toEqual({
      status: 'already_requested',
      runStatus: 'running',
    });
    expect(store.writes()).toBe(1);
  });

  it('should not restart a run an admin deliberately stopped', async () => {
    const store = createFakeStore();
    const workspace = createWorkspace([strongPerson(1)]);

    await requestInstallBackfill({ client: workspace.client, store, now: NOW });
    await stopBackfill({
      client: workspace.client,
      store,
      now: later(1),
      requestedBy: 'Workspace member 9',
    });

    // The next patch release re-runs the hook. Starting another backfill here
    // would be the app overruling a decision it was told about.
    expect(
      await requestInstallBackfill({
        client: workspace.client,
        store,
        now: later(2),
      }),
    ).toEqual({ status: 'already_requested', runStatus: 'cancelled' });
  });

  it('should not start a run on a workspace with nothing to walk', async () => {
    const store = createFakeStore();
    const workspace = createWorkspace([
      strongPerson(1, { greenlightDecision: 'PASS' }),
    ]);

    expect(
      await requestInstallBackfill({ client: workspace.client, store, now: NOW }),
    ).toEqual({ status: 'nothing_to_do' });
    expect(store.peek()).toBeNull();
  });

  it('should never throw out to the install hook', async () => {
    const workspace = createWorkspace([strongPerson(1)]);

    const result = await requestInstallBackfill({
      client: workspace.client,
      store: createFakeStore({ failRead: true }),
      now: NOW,
    });

    expect(result.status).toBe('failed');
  });
});
