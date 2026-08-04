/**
 * The enrichment ⇄ scoring cycle, driven end to end.
 *
 * Adding `greenlightEnrichment` to `SCORING_TRIGGER_PERSON_FIELDS` closes a real
 * cycle for the first time in this app: enrichment writes → the scorer wakes →
 * the scorer writes `greenlightDecision` → enrichment wakes, because that single
 * field is its whole trigger. Every other retrigger argument in the codebase
 * rests on two sets being disjoint, and this one cannot, so it is proved here by
 * *running* the loop instead of asserting a property of two arrays.
 *
 * The harness below is a miniature of the platform: one mutable Person, and a
 * dispatcher that turns each `updatePerson` mutation into the `person.updated`
 * event the platform would deliver, routed by the same two trigger allow-lists
 * the manifests declare. A run that writes nothing therefore produces no event,
 * which is exactly the mechanism both termination arguments depend on — so if
 * either were wrong, this file would hang rather than pass, and `MAX_HOPS` turns
 * the hang into a failure.
 *
 * Two scenarios, one for each of the two independent guards:
 *
 *   1. `the enriched value moves the score` — the expensive path. Four hops,
 *      one provider call, and the chain ends because a woken enrichment run
 *      finds no gaps and returns *before writing anything*.
 *   2. `the enriched value does not move the score` — the common path. Three
 *      hops, and the chain ends one step earlier because the outcome
 *      fingerprint is unchanged and the scorer writes nothing at all.
 */

import { describe, expect, it } from 'vitest';

import { buildGreenlightConfigSeed } from 'src/logic-functions/greenlight-config-record';
import {
  runLeadEnrichment,
  type EnrichmentRunDeps,
} from 'src/logic-functions/enrich-run';
import {
  runPersonScoring,
  SCORING_TRIGGER_PERSON_FIELDS,
  type ReleaseMarkerStore,
  type ScoringRunOutcome,
} from 'src/logic-functions/scoring-run';
import {
  asConnection,
  createFakeClient,
  mutationData,
} from 'src/logic-functions/__tests__/fake-client';
import {
  completed,
  environment,
  fakeReasoning,
  fakeSearch,
  fakeStore,
  goodReply,
  licensed,
  NOW,
  searchResults,
} from 'src/logic-functions/__tests__/enrich-fakes';

/** The one field `enrich-lead.logic-function.ts` listens on. */
const ENRICHMENT_TRIGGER_FIELD = 'greenlightDecision';

/**
 * Well above any settling length the design allows. Reaching it means the cycle
 * did not terminate, which is the failure this file exists to catch.
 */
const MAX_HOPS = 12;

const LEAD_ID = 'person-1';

/* -------------------------------------------------------------------------- */
/* A miniature workspace                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A lead with contact details and a company, and deliberately no industry,
 * region, headcount or seniority — the four gaps enrichment is allowed to fill.
 */
const seedPerson = (): Record<string, unknown> => ({
  id: LEAD_ID,
  name: { firstName: 'Dana', lastName: 'Fry' },
  emails: { primaryEmail: 'dana.fry@acmepumps.example' },
  phones: { primaryPhoneNumber: '+441134960000' },
  jobTitle: 'Chief Operating Officer',
  company: { name: 'Acme Pumps Ltd' },
  updatedAt: '2026-08-01T00:00:00.000Z',
});

const noMarkers: ReleaseMarkerStore = {
  get: async () => null,
  delete: async () => undefined,
};

interface Hop {
  readonly runner: 'scoring' | 'enrichment';
  /** The Person columns this run wrote. Empty means it produced no event. */
  readonly wrote: readonly string[];
}

const createWorld = (icpIndustries: readonly string[]) => {
  let person = seedPerson();

  const personWrites: Record<string, unknown>[] = [];
  const auditRows: Record<string, unknown>[] = [];
  const scoringOutcomes: ScoringRunOutcome[] = [];

  const config = {
    id: 'config-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...buildGreenlightConfigSeed(),
    icpIndustries: [...icpIndustries],
  };

  const client = createFakeClient({
    query: (request) => {
      if ('people' in request) {
        return asConnection('people', [person]);
      }

      if ('greenlightConfigs' in request) {
        return asConnection('greenlightConfigs', [config]);
      }

      return {};
    },
    mutation: (request) => {
      if ('updatePerson' in request) {
        const data = mutationData(request['updatePerson'] as Record<string, unknown>);

        personWrites.push(data);
        person = { ...person, ...data };

        return { updatePerson: { id: LEAD_ID } };
      }

      if ('createGreenlightAuditLog' in request) {
        auditRows.push(
          mutationData(request['createGreenlightAuditLog'] as Record<string, unknown>),
        );

        return { createGreenlightAuditLog: { id: `audit-${auditRows.length}` } };
      }

      return {};
    },
  });

  const search = fakeSearch({ kind: 'results', results: searchResults() });
  const store = fakeStore();
  const reasoning = fakeReasoning({
    capable: completed(goodReply),
    cheap: completed(JSON.stringify({ results: [{ id: '1', supported: true }] })),
  });

  const deps: EnrichmentRunDeps = {
    client,
    store,
    environment: environment(),
    createReasoning: (choice) => (choice.kind === 'none' ? null : reasoning),
    createSearch: (choice) => (choice.kind === 'none' ? null : search),
    licence: licensed(),
    now: NOW,
  };

  /** Everything the run wrote, as the platform would report `updatedFields`. */
  const writesSince = (index: number): string[] =>
    personWrites.slice(index).flatMap((data) => Object.keys(data));

  const runScoring = async (updatedFields: readonly string[]): Promise<string[]> => {
    const before = personWrites.length;

    scoringOutcomes.push(
      await runPersonScoring({
        client,
        event: {
          recordId: LEAD_ID,
          properties: { after: { ...person }, updatedFields: [...updatedFields] },
        },
        now: NOW,
        markers: noMarkers,
      }),
    );

    return writesSince(before);
  };

  const runEnrichment = async (): Promise<string[]> => {
    const before = personWrites.length;

    await runLeadEnrichment(deps, { leadRecordId: LEAD_ID, lead: { ...person } });

    return writesSince(before);
  };

  /**
   * Deliver one `person.updated` event and everything it causes.
   *
   * Routing is by the two published allow-lists, not by hand: a field added to
   * either manifest changes what this dispatcher does, so the test tracks the
   * product rather than a snapshot of it.
   */
  const drive = async (first: readonly string[]): Promise<Hop[]> => {
    const hops: Hop[] = [];
    const queue: string[][] = [[...first]];

    while (queue.length > 0) {
      if (hops.length >= MAX_HOPS) {
        throw new Error(
          `the enrichment/scoring cycle did not settle within ${MAX_HOPS} hops`,
        );
      }

      const updatedFields = queue.shift() as string[];

      if (updatedFields.some((field) => SCORING_TRIGGER_PERSON_FIELDS.includes(field))) {
        const wrote = await runScoring(updatedFields);

        hops.push({ runner: 'scoring', wrote });

        if (wrote.length > 0) {
          queue.push(wrote);
        }
      }

      if (updatedFields.includes(ENRICHMENT_TRIGGER_FIELD)) {
        const wrote = await runEnrichment();

        hops.push({ runner: 'enrichment', wrote });

        if (wrote.length > 0) {
          queue.push(wrote);
        }
      }
    }

    return hops;
  };

  return {
    drive,
    get person() {
      return person;
    },
    personWrites,
    auditRows,
    scoringOutcomes,
    search,
    reasoning,
  };
};

const scoresWritten = (world: ReturnType<typeof createWorld>): unknown[] =>
  world.personWrites
    .filter((data) => 'greenlightScore' in data)
    .map((data) => data['greenlightScore']);

/* -------------------------------------------------------------------------- */
/* 1 — the enriched value moves the score                                      */
/* -------------------------------------------------------------------------- */

describe('the enrichment ⇄ scoring cycle, when enrichment moves the score', () => {
  /**
   * The ICP names the industry the fixture page happens to state, so the
   * enriched value flips `icp.industry` from fail to pass and the outcome
   * fingerprint genuinely changes. This is the branch that actually exercises
   * the cycle; with an empty ICP (the shipped default) it would never start.
   */
  const world = () => createWorld(['industrial manufacturing']);

  it('settles after exactly one re-score and one further wake-up', async () => {
    const state = world();

    const hops = await state.drive(['jobTitle']);

    expect(hops.map((hop) => hop.runner)).toEqual([
      // A human edit wakes the scorer, which writes a decision.
      'scoring',
      // The decision wakes enrichment, which sources an industry and writes it.
      'enrichment',
      // The enriched blob wakes the scorer, whose outcome has genuinely changed.
      'scoring',
      // That decision wakes enrichment once more — and this is where it stops.
      'enrichment',
    ]);

    // The last hop is the termination step: no gaps left, so nothing is written,
    // so no event is produced and the queue drains.
    expect(hops[hops.length - 1]?.wrote).toEqual([]);
  });

  it('reaches a provider exactly once across the whole cycle', async () => {
    const state = world();

    await state.drive(['jobTitle']);

    // The second enrichment run returns on the shelf-life cache, before search.
    expect(state.search.queries).toHaveLength(1);
    // Two model calls: one extraction, one verification. Both from run 1.
    expect(state.reasoning.calls).toHaveLength(2);
  });

  it('actually moves the score, and leaves the enriched value on the record', async () => {
    const state = world();

    await state.drive(['jobTitle']);

    const [firstScore, secondScore] = scoresWritten(state);

    expect(typeof firstScore).toBe('number');
    expect(secondScore).toBeGreaterThan(firstScore as number);

    const enrichment = state.person['greenlightEnrichment'] as {
      fields: { industry?: { parsedValue: unknown } };
    };

    expect(enrichment.fields.industry?.parsedValue).toBe('industrial manufacturing');
  });

  it('writes one audit row per scoring pass and none for the settling run', async () => {
    const state = world();

    await state.drive(['jobTitle']);

    // Two scoring passes wrote; the third scoring hop never happens because the
    // settling enrichment run produced no event.
    expect(state.auditRows).toHaveLength(2);
    expect(state.personWrites).toHaveLength(3);
  });
});

/* -------------------------------------------------------------------------- */
/* 2 — the enriched value does not move the score                              */
/* -------------------------------------------------------------------------- */

describe('the enrichment ⇄ scoring cycle, when enrichment moves nothing', () => {
  /**
   * The shipped default: an empty ICP industry list, so `icp.industry` is
   * `not_applicable` whether or not an industry is known. Enrichment still runs
   * and still writes, but the score, band, decision and every rule verdict are
   * unchanged — so the fingerprint matches and the scorer writes nothing.
   */
  const world = () => createWorld([]);

  it('stops at the scorer, one hop earlier', async () => {
    const state = world();

    const hops = await state.drive(['jobTitle']);

    expect(hops.map((hop) => hop.runner)).toEqual([
      'scoring',
      'enrichment',
      'scoring',
    ]);

    expect(hops[hops.length - 1]?.wrote).toEqual([]);
    const outcomes = state.scoringOutcomes;

    expect(outcomes[outcomes.length - 1]?.status).toBe('unchanged');
  });

  it('never wakes enrichment a second time', async () => {
    const state = world();

    await state.drive(['jobTitle']);

    expect(state.search.queries).toHaveLength(1);
    // One scoring write and one enrichment write. The second scoring pass wrote
    // nothing, which is what stops the chain.
    expect(state.personWrites).toHaveLength(2);
    expect(state.auditRows).toHaveLength(1);
  });
});
