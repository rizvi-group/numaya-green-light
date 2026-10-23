import { describe, expect, it } from 'vitest';

import {
  advanceCursor,
  BACKFILL_CHUNK_SIZE,
  backfillPersonSelection,
  BACKFILL_PAGE_SIZE,
  buildCountRequest,
  buildModeFilter,
  buildPageFilter,
  buildPageRequest,
  configuredSelectionFields,
  isAlreadyHandled,
  PAGE_ATTEMPTS,
  pageSizeFor,
  readTotalCount,
  toScoringEvent,
  TWENTY_REQUESTS_PER_MINUTE,
} from 'src/backfill/backfill-plan';
import { isGreenlightAuthoredWrite } from 'src/logic-functions/scoring-run';
import {
  BACKFILL_MAX_CURSOR_IDS,
  type BackfillCursor,
} from 'src/backfill/backfill-state';

const NO_CURSOR: BackfillCursor = { createdAt: null, ids: [] };

describe('the chunk size', () => {
  it('should keep the boundary allowance equal to the page headroom', () => {
    // The page is over-fetched by exactly the boundary set so skipping it never
    // eats the chunk's budget; the boundary set is capped at what the page can
    // over-fetch. The two constants live in different modules to avoid a cycle,
    // so this is what stops them drifting apart.
    expect(BACKFILL_PAGE_SIZE - BACKFILL_CHUNK_SIZE).toBe(
      BACKFILL_MAX_CURSOR_IDS,
    );
  });

  it('should never ask for more than one page, however wide the boundary', () => {
    expect(
      pageSizeFor(BACKFILL_CHUNK_SIZE, {
        createdAt: '2025-01-01T00:00:00.000Z',
        ids: Array.from({ length: 500 }, (_, i) => String(i)),
      }),
    ).toBe(BACKFILL_PAGE_SIZE);
  });

  it('should over-fetch by exactly the number of records it will have to skip', () => {
    expect(pageSizeFor(10, { createdAt: 'x', ids: ['a', 'b'] })).toBe(12);
    expect(pageSizeFor(10, NO_CURSOR)).toBe(10);
  });

  it('should leave real headroom under the rate limit for live scoring', () => {
    // 1 page query + 1 config query + 2 writes per changed record.
    const worstCase = 2 + 2 * BACKFILL_CHUNK_SIZE;

    expect(worstCase).toBeLessThan(TWENTY_REQUESTS_PER_MINUTE);
    // Enough left for a dozen concurrent create/update scoring events at 3
    // requests each — a workspace importing leads mid-backfill is the likeliest
    // moment for one, and the live gate must not be throttled by the backfill.
    expect(TWENTY_REQUESTS_PER_MINUTE - worstCase).toBeGreaterThanOrEqual(30);
  });
});

describe('backfillPersonSelection', () => {
  const selection = backfillPersonSelection();

  it('should read the suppression register, or bulk scoring would ignore every opt-out', () => {
    expect(selection['greenlightSuppressed']).toBe(true);
    expect(selection['greenlightSuppressionReason']).toBe(true);
  });

  it('should read the stored trace, which is what makes a re-run idempotent', () => {
    // Guard 3 compares the fingerprint stored inside `greenlightTrace`. Without
    // this key every pass would rewrite every record and duplicate its audit row.
    expect(selection['greenlightTrace']).toBe(true);
  });

  it('should read the enriched blob, or a bulk pass would disagree with the event path', () => {
    // The resolved field mapping reads
    // `greenlightEnrichment.fields.<key>.parsedValue`, so this is a scoring
    // input. Fetching the page without it would score an enriched lead as
    // though it had never been enriched — and only in bulk.
    expect(selection['greenlightEnrichment']).toBe(true);
  });

  it('should carry the cursor field and the freshness input', () => {
    expect(selection['createdAt']).toBe(true);
    expect(selection['updatedAt']).toBe(true);
  });

  it('should read exactly the company data the event path can see', () => {
    // Parity with `hydrateCompany`, deliberately. Any difference in either
    // direction — richer here, richer there — makes the same person score
    // differently depending on when they arrived.
    expect(selection['company']).toEqual({
      id: true,
      name: true,
      industry: true,
      country: true,
      employeeCount: true,
    });
  });

  it('should append configured field names without displacing a shipped one', () => {
    const extended = backfillPersonSelection(['seniorityLevel', 'jobTitle']);

    expect(extended['seniorityLevel']).toBe(true);
    expect(extended['jobTitle']).toBe(true);
    expect(extended['name']).toEqual({ firstName: true, lastName: true });
  });
});

describe('configuredSelectionFields', () => {
  it('should pick up the Layer 3 field names a workspace configured', () => {
    expect(
      configuredSelectionFields({
        decisionMakerFieldName: 'seniorityLevel',
        readyForOutreachFieldName: 'stage',
        optOutFieldNames: ['doNotEmail', 'gdprOptOut'],
      }),
    ).toEqual(['seniorityLevel', 'stage', 'doNotEmail', 'gdprOptOut']);
  });

  it('should drop anything that is not a plain GraphQL identifier', () => {
    // These are admin-supplied strings one query away from the schema.
    expect(
      configuredSelectionFields({
        decisionMakerFieldName: 'job title',
        optOutFieldNames: ['id) { __schema }', '', 42, 'ok_1'],
      }),
    ).toEqual(['ok_1']);
  });

  it('should tolerate a missing or unreadable config', () => {
    expect(configuredSelectionFields(null)).toEqual([]);
    expect(configuredSelectionFields('nope')).toEqual([]);
    expect(configuredSelectionFields({})).toEqual([]);
  });
});

describe('the page request', () => {
  it('should filter on an absent decision in unscored mode', () => {
    // `is NULL`, not `IS 'UNSCORED'`. A record that predates the app carries no
    // value at all; `UNSCORED` is what the fail-open path writes after looking.
    expect(buildModeFilter('unscored')).toEqual({
      greenlightDecision: { is: 'NULL' },
    });
  });

  it('should not filter at all in all mode', () => {
    expect(buildModeFilter('all')).toEqual({});
  });

  it('should use gte so records sharing the boundary timestamp are not skipped', () => {
    const filter = buildPageFilter({
      mode: 'all',
      cursor: { createdAt: '2025-01-01T00:00:00.000Z', ids: ['a'] },
      ordered: true,
    });

    expect(filter['createdAt']).toEqual({ gte: '2025-01-01T00:00:00.000Z' });
  });

  it('should drop the cursor when ordering is dropped, because they are one mechanism', () => {
    const filter = buildPageFilter({
      mode: 'unscored',
      cursor: { createdAt: '2025-01-01T00:00:00.000Z', ids: [] },
      ordered: false,
    });

    expect(filter['createdAt']).toBeUndefined();
    expect(filter['greenlightDecision']).toEqual({ is: 'NULL' });
  });

  it('should ask for exactly one chunk, ordered oldest first', () => {
    const request = buildPageRequest({
      mode: 'unscored',
      cursor: NO_CURSOR,
      chunkSize: 30,
      selection: { id: true },
      ordered: true,
    }) as Record<string, { __args: Record<string, unknown> }>;

    expect(request['people']?.__args['first']).toBe(30);
    expect(request['people']?.__args['orderBy']).toEqual([
      { createdAt: 'AscNullsFirst' },
    ]);
  });

  it('should degrade through ordering last, and only after dropping custom fields', () => {
    expect(PAGE_ATTEMPTS.map((attempt) => [attempt.useExtraFields, attempt.ordered])).toEqual([
      [true, true],
      [false, true],
      [false, false],
    ]);
  });
});

describe('counting', () => {
  it('should ask for a total against the same filter the run walks', () => {
    expect(buildCountRequest('unscored')).toEqual({
      people: {
        __args: { filter: { greenlightDecision: { is: 'NULL' } } },
        totalCount: true,
      },
    });
  });

  it('should read a total, and degrade to null rather than guessing', () => {
    expect(readTotalCount({ people: { totalCount: 1205 } })).toBe(1205);
    expect(readTotalCount({ people: {} })).toBeNull();
    expect(readTotalCount(null)).toBeNull();
    expect(readTotalCount({ people: { totalCount: -1 } })).toBeNull();
  });
});

describe('the cursor', () => {
  const node = (id: string, createdAt: string) => ({ id, createdAt });

  it('should not move when the tick handled nothing', () => {
    const cursor = { createdAt: '2025-01-01T00:00:00.000Z', ids: ['a'] };

    expect(advanceCursor(cursor, [])).toEqual(cursor);
  });

  it('should move to the last record actually reached', () => {
    expect(
      advanceCursor(NO_CURSOR, [
        node('a', '2025-01-01T00:00:00.000Z'),
        node('b', '2025-01-02T00:00:00.000Z'),
      ]),
    ).toEqual({ createdAt: '2025-01-02T00:00:00.000Z', ids: ['b'] });
  });

  it('should remember every record sharing the boundary timestamp', () => {
    // The `gte` filter re-reads the boundary on the next page; these ids are
    // what stops it re-scoring them.
    expect(
      advanceCursor(NO_CURSOR, [
        node('a', '2025-01-01T00:00:00.000Z'),
        node('b', '2025-01-02T00:00:00.000Z'),
        node('c', '2025-01-02T00:00:00.000Z'),
      ]),
    ).toEqual({ createdAt: '2025-01-02T00:00:00.000Z', ids: ['b', 'c'] });
  });

  it('should carry boundary ids forward while the timestamp has not moved', () => {
    // A bulk import stamps hundreds of records in the same millisecond, so the
    // walk drains one chunk at a time through a growing boundary set.
    const first = advanceCursor(NO_CURSOR, [
      node('a', '2025-01-01T00:00:00.000Z'),
    ]);

    expect(
      advanceCursor(first, [node('b', '2025-01-01T00:00:00.000Z')]),
    ).toEqual({ createdAt: '2025-01-01T00:00:00.000Z', ids: ['a', 'b'] });
  });

  it('should forget boundary ids as soon as the timestamp moves on', () => {
    const first = advanceCursor(NO_CURSOR, [
      node('a', '2025-01-01T00:00:00.000Z'),
    ]);

    expect(
      advanceCursor(first, [node('b', '2025-02-01T00:00:00.000Z')]),
    ).toEqual({ createdAt: '2025-02-01T00:00:00.000Z', ids: ['b'] });
  });

  it('should skip only the records it has already handled at the boundary', () => {
    const cursor = { createdAt: '2025-01-01T00:00:00.000Z', ids: ['a'] };

    expect(isAlreadyHandled(cursor, node('a', '2025-01-01T00:00:00.000Z'))).toBe(
      true,
    );
    expect(isAlreadyHandled(cursor, node('b', '2025-01-01T00:00:00.000Z'))).toBe(
      false,
    );
    expect(isAlreadyHandled(cursor, { noId: true })).toBe(false);
  });
});

describe('toScoringEvent', () => {
  const person = { id: 'p1', jobTitle: 'CTO' };

  it('should build the envelope the scoring run already reads', () => {
    expect(toScoringEvent(person)).toEqual({
      recordId: 'p1',
      properties: { after: person },
    });
  });

  it('should carry no updatedFields, so guard 2 scores the record', () => {
    const event = toScoringEvent(person) as {
      properties: Record<string, unknown>;
    };

    expect(event.properties['updatedFields']).toBeUndefined();
    // An absent list reads as "we do not know what changed", which means score
    // it. Supplying the Greenlight-owned names would make guard 2 swallow the
    // entire backfill.
    expect(isGreenlightAuthoredWrite(event.properties['updatedFields'])).toBe(
      false,
    );
  });
});
