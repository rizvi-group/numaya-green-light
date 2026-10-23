/**
 * Numaya Greenlight — how one backfill tick decides what to read.
 *
 * Pure, like `backfill-state.ts` and for the same reason: the request shapes
 * below are the part most likely to be wrong against a real schema, and a pure
 * module is the only place they can be asserted without a workspace.
 *
 * Three things live here — the size of a chunk and the arithmetic that fixes it,
 * the Person selection and why it is exactly that wide, and the keyset cursor.
 */

import { mappedFieldNames } from 'src/backfill/field-mapping-check';
import { isPlainRecord } from 'src/logic-functions/greenlight-api';

import type { BackfillCursor, BackfillMode } from 'src/backfill/backfill-state';

/* -------------------------------------------------------------------------- */
/* Chunk size — the rate-limit arithmetic                                      */
/* -------------------------------------------------------------------------- */

/**
 * Twenty's documented ceiling. Stated here rather than left implicit because
 * every number below is derived from it and a future change to it must land in
 * one place.
 */
export const TWENTY_REQUESTS_PER_MINUTE = 100;

/**
 * Records handled per cron tick, and the cron fires once a minute.
 *
 * ## The arithmetic
 *
 * Per tick, against the Core API:
 *
 *     1   page query      (this module's `buildPageRequest`)
 *     1   config query    (`loadConfigRecord`, hoisted out of the per-record path)
 *   2×N   record writes   (`createGreenlightAuditLog` + `updatePerson`)
 *     ─────
 *     2 + 2N requests
 *
 * `2×N` is the worst case: it is what a record whose outcome actually *changed*
 * costs. A record guard 3 recognises as unchanged costs zero writes, so a re-run
 * over an already-scored workspace issues 2 requests a minute, not 62.
 *
 * At N = 30:  2 + 60 = **62 Core API requests per minute**, 62% of the ceiling.
 *
 * Against app key-value storage, per tick: 1 state read, 2 state writes (claim
 * the lease, commit the chunk), and up to N release-marker reads — but only for
 * records the engine wants to *hold*, since `pinReleasedDecision` does not spend
 * a read on a passing lead. Worst case 33 key-value operations. If Twenty ever
 * counts those against the same bucket the total is 95, still inside 100.
 *
 * ## Why not 49, which is what 100 requests would actually buy
 *
 * Because the backfill is not the only thing talking to the API. The create and
 * update scoring hooks keep firing while it runs, each costing up to 3 requests,
 * and a workspace importing leads during a backfill is not a hypothetical — it is
 * the most likely time for one. Roughly 38 requests a minute of headroom is
 * twelve concurrent live scoring events, which is a busy import.
 *
 * Spending the whole budget would make the backfill throttle the live gate. A
 * backfill that finishes an hour sooner by making new leads score late has
 * optimised the wrong thing: new leads are the ones a rep is about to call.
 *
 * ## What it costs in wall-clock
 *
 * 30/minute = 1,800/hour. The 1,205-person dev workspace: ~40 minutes. A
 * 10,000-contact workspace: ~5.6 hours. Both unattended, both resumable, and
 * both visible while they run — which is the requirement, rather than speed.
 */
export const BACKFILL_CHUNK_SIZE = 30;

/**
 * Twenty's page ceiling — the documented batch size. A page may therefore be
 * twice a chunk, and the difference is spent on the cursor boundary rather than
 * on scoring: see `pageSizeFor`.
 */
export const BACKFILL_PAGE_SIZE = 60;

/**
 * Stop starting new records after this much of the tick has gone.
 *
 * The cron function is registered with `timeoutSeconds: 55`. Being killed by the
 * platform is survivable — the cursor simply does not advance and the next tick
 * redoes the chunk — but it is wasteful, and it makes the panel's counters lag
 * reality by a whole lease. Stopping early and committing the prefix that was
 * actually finished is strictly better: the position is recorded, and the tail is
 * re-fetched rather than re-scored.
 */
export const BACKFILL_TICK_BUDGET_MS = 40_000;

/* -------------------------------------------------------------------------- */
/* What to read off a Person                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The Person columns a bulk score reads.
 *
 * ## The governing constraint is parity, not completeness
 *
 * The event path hands `scoring-run.ts` `event.properties.after` — every column
 * on the record — and then hydrates the company with `{ id, name, industry,
 * country, employeeCount }` (see `hydrateCompany`). A backfilled lead and a
 * freshly-created lead must land on the same score, or the gate queue becomes
 * incoherent: the same person scores one way if they were imported yesterday
 * and another if they arrive tomorrow, and nobody can explain the queue to the
 * rep working it.
 *
 * So this selection pulls exactly the company data the event path can see — no
 * more, no less. The three firmographics are what the ICP rules and the
 * exclusion gate read through the `company.*` mapping candidates; leaving them
 * out here would make a backfilled record score as though its company carried
 * nothing, and the two paths would disagree on the same record. Being
 * identically informed beats being inconsistently generous.
 *
 * ## The three that are not about scoring
 *
 *   - `greenlightTrace` carries the stored outcome fingerprint. Without it guard
 *     3 cannot fire, and every backfill pass would rewrite every record and
 *     append a duplicate audit row. This one field is what makes re-running the
 *     backfill idempotent.
 *   - `greenlightDecision` and `greenlightScore` are what the modes filter and
 *     sort on, and what the panel counts.
 *   - `createdAt` is the cursor. `updatedAt` is also the freshness rule's input.
 *
 * ## The suppression columns are not optional
 *
 * `greenlightSuppressed` / `greenlightSuppressionReason` are the compliance
 * rule's primary input (`DEFAULT_FIELD_MAPPING.suppressed`). Omitting them would
 * make every bulk-scored record answer the compliance question with "nothing on
 * this record says" — and a workspace's whole do-not-contact register would be
 * silently ignored for exactly the records nobody has checked yet. That is the
 * single worst thing this feature could do, so they are listed first among the
 * Greenlight fields and asserted in the tests.
 */
export const backfillPersonSelection = (
  extraFieldNames: readonly string[] = [],
): Record<string, unknown> => {
  const selection: Record<string, unknown> = {
    id: true,
    createdAt: true,
    updatedAt: true,
    name: { firstName: true, lastName: true },
    emails: { primaryEmail: true, additionalEmails: true },
    phones: {
      primaryPhoneNumber: true,
      primaryPhoneCallingCode: true,
      primaryPhoneCountryCode: true,
      additionalPhones: true,
    },
    jobTitle: true,
    city: true,
    linkedinLink: { primaryLinkUrl: true, primaryLinkLabel: true },
    // Both, for the same reason `SCORING_TRIGGER_PERSON_FIELDS` lists both: the
    // relation and its foreign key are reported under different names across
    // versions. Supplying `company` is also what stops `hydrateCompany` spending
    // an extra query per record — the difference between 2 and 3 requests each.
    companyId: true,
    company: { id: true, name: true, industry: true, country: true, employeeCount: true },
    greenlightSuppressed: true,
    greenlightSuppressionReason: true,
    // A scoring *input*, not bookkeeping: the resolved field mapping appends
    // `greenlightEnrichment.fields.<key>.parsedValue` to every enrichable key,
    // so a page fetched without this column scores an enriched lead as though it
    // had never been enriched — and a bulk pass would then disagree with the
    // event path on the same record. The two sibling columns are deliberately
    // absent; no rule reads a date or a status.
    greenlightEnrichment: true,
    greenlightScore: true,
    greenlightDecision: true,
    greenlightTrace: true,
  };

  for (const name of extraFieldNames) {
    if (!(name in selection)) {
      selection[name] = true;
    }
  }

  return selection;
};

/**
 * The Layer 3 field names a workspace has pointed Greenlight at, so a customised
 * workspace scores the same in bulk as it does on an event.
 *
 * The event path gets every column for free; this one has to ask by name, and the
 * names it does not know are exactly the ones an admin configured. Anything that
 * is not a plain GraphQL identifier is dropped rather than interpolated — a
 * config field is admin-supplied text, and it is one query away from the schema.
 * That filtering, and the provenance of each name, now live in
 * `field-mapping-check.ts`, which needs to know not just *which* names reach a
 * request but *which setting* each one was typed into. One list, one owner: the
 * names this function puts in a selection are by construction the names that
 * module probes.
 *
 * ## What a typo in a configured name actually does
 *
 * This used to read: "a name that passes the regex but does not exist still fails
 * the query, which is why `backfill-run.ts` retries the page without extras
 * before giving up." That is wrong, and it was wrong in the direction that hides
 * the problem.
 *
 * Proved against a live instance (`src/__live__/api-contract.live-test.ts`):
 * **Twenty validates arguments and does not validate selection sets.** A `filter`
 * or `orderBy` naming a column the object lacks is rejected outright; a
 * *selected* column the object lacks is accepted and comes back `null`.
 *
 * These names only ever reach the selection. So a typo in a settings field does
 * not fail the page and does not trip the retry ladder — the query succeeds, the
 * column arrives as `null`, and the engine scores the record as though the human
 * had left that field blank. The backfill runs to completion, reports success,
 * and produces quietly worse scores across the whole workspace.
 *
 * It is still not this function's job to fix that — a page builder that started
 * probing the schema would put a round trip on the path a tick takes every
 * minute. It is fixed one level up and once per run: `startBackfill` in
 * `backfill-run.ts` asks Twenty whether each of these names exists, using the
 * half of a query Twenty actually checks, and reports the ones that do not to the
 * panel and the audit log. See `field-mapping-check.ts` for why the probe is a
 * filter and never a selection.
 */
export const configuredSelectionFields = (configRecord: unknown): string[] =>
  mappedFieldNames(configRecord).map((mapped) => mapped.name);

/* -------------------------------------------------------------------------- */
/* The page request                                                            */
/* -------------------------------------------------------------------------- */

export interface PageRequestInput {
  readonly mode: BackfillMode;
  readonly cursor: BackfillCursor;
  readonly chunkSize: number;
  readonly selection: Record<string, unknown>;
  /**
   * False drops `orderBy` **and** the cursor together — they are one mechanism
   * and a cursor without an order is a random walk. See `PAGE_ATTEMPTS`.
   */
  readonly ordered: boolean;
}

/**
 * `is: 'NULL'` rather than a comparison against a value: a Person that predates
 * the app has no `greenlightDecision` at all, which is a different state from the
 * `UNSCORED` value the fail-open path writes. See `BACKFILL_MODES`.
 */
export const buildModeFilter = (mode: BackfillMode): Record<string, unknown> =>
  mode === 'unscored' ? { greenlightDecision: { is: 'NULL' } } : {};

/**
 * `gte`, not `gt`, and the boundary ids in the cursor are what make that correct.
 *
 * `createdAt` is not unique — a CSV import stamps hundreds of records within the
 * same millisecond. `gt` would step straight over every record sharing the
 * boundary timestamp with the last one handled, silently leaving them unscored:
 * the exact class of bug this whole feature exists to fix, reintroduced inside
 * the fix. `gte` re-reads the boundary and `cursor.ids` removes the ones already
 * done.
 */
export const buildPageFilter = ({
  mode,
  cursor,
  ordered,
}: Pick<PageRequestInput, 'mode' | 'cursor' | 'ordered'>): Record<
  string,
  unknown
> => {
  const filter: Record<string, unknown> = { ...buildModeFilter(mode) };

  if (ordered && cursor.createdAt !== null) {
    filter['createdAt'] = { gte: cursor.createdAt };
  }

  return filter;
};

/**
 * How many rows to ask for, given how many the page will have to skip.
 *
 * A `gte` cursor re-reads every record sharing the boundary timestamp, and
 * `cursor.ids` is how those are recognised and skipped. If the page were sized to
 * the chunk, those skips would eat the chunk's budget — and in the worst case a
 * page could be *entirely* boundary records, examine nothing, advance nothing,
 * and repeat forever. That is head-of-line blocking, and it is not hypothetical:
 * Postgres `now()` is constant within a transaction, so an import writes rows
 * with identical `createdAt`.
 *
 * Over-fetching by exactly the boundary size means a page always contains a full
 * chunk of *new* records, right up to Twenty's page ceiling. It costs nothing —
 * it is the same single request either way, which is why the rate arithmetic on
 * `BACKFILL_CHUNK_SIZE` is unaffected.
 *
 * `BACKFILL_MAX_CURSOR_IDS` is what stops the boundary set outgrowing the
 * headroom; past that the walk can only re-read records, never skip one, and
 * `BACKFILL_MAX_STALLS` turns a walk that has stopped advancing into a visible
 * failure rather than a silent spin.
 */
export const pageSizeFor = (
  chunkSize: number,
  cursor: BackfillCursor,
): number => Math.min(BACKFILL_PAGE_SIZE, chunkSize + cursor.ids.length);

export const buildPageRequest = ({
  mode,
  cursor,
  chunkSize,
  selection,
  ordered,
}: PageRequestInput): Record<string, unknown> => {
  const filter = buildPageFilter({ mode, cursor, ordered });

  const args: Record<string, unknown> = {
    first: ordered ? pageSizeFor(chunkSize, cursor) : chunkSize,
  };

  if (Object.keys(filter).length > 0) {
    args['filter'] = filter;
  }

  if (ordered) {
    args['orderBy'] = [{ createdAt: 'AscNullsFirst' }];
  }

  return { people: { __args: args, edges: { node: selection } } };
};

/**
 * The ladder `backfill-run.ts` walks when a page query is rejected, in order.
 *
 * Each rung drops the next-most-likely cause and keeps everything below it:
 *
 *   1. **Everything.** Ordered, cursored, with the workspace's configured field
 *      names in the selection.
 *   2. **Without the configured names.** This rung is, on Twenty 2.26,
 *      **unreachable**, and the comment that used to be here said the opposite —
 *      "by far the likeliest failure". Configured names only ever enter the
 *      *selection*, and Twenty does not validate selection sets: an unknown
 *      column is accepted and returns `null`. So a mistyped mapping cannot reject
 *      a page, and this rung cannot be the thing that saves it. See
 *      `configuredSelectionFields` for what a typo does instead, which is worse
 *      than a failed page and much quieter.
 *
 *      It stays in the ladder for two reasons. It is free — a rung that never
 *      fires costs one unreached branch — and it is the correct response if a
 *      future Twenty starts validating selections, which is the stricter and more
 *      likely direction for that behaviour to move. The live contract test
 *      exercises every rung, so this note stops being true the moment it stops
 *      being true.
 *   3. **Unordered and uncursored.** Only reachable in `unscored` mode, and it
 *      works there because that mode's filter *is* the queue: a record the tick
 *      scores stops matching `greenlightDecision is NULL`, so repeatedly asking
 *      for "the next 30 unscored" drains the workspace with no ordering support
 *      whatsoever. In `all` mode there is no such self-consuming filter, so there
 *      is no honest fallback and the run records the error and stalls where an
 *      admin can see it — which is the correct outcome, not a worse one.
 *
 * The ladder exists because `orderBy` direction enums and cursor comparators are
 * the two things in this file that cannot be verified without a live schema, and
 * an app that stops scoring a whole workspace because of an enum spelling is a
 * bad trade against ~30 lines of degradation.
 */
export const PAGE_ATTEMPTS = [
  { useExtraFields: true, ordered: true },
  { useExtraFields: false, ordered: true },
  { useExtraFields: false, ordered: false },
] as const;

/** Counting is a nicety: it drives the progress bar and nothing else. */
export const buildCountRequest = (
  mode: BackfillMode,
): Record<string, unknown> => {
  const filter = buildModeFilter(mode);

  return {
    people: {
      ...(Object.keys(filter).length > 0 ? { __args: { filter } } : {}),
      totalCount: true,
    },
  };
};

export const readTotalCount = (response: unknown): number | null => {
  if (!isPlainRecord(response)) {
    return null;
  }

  const connection = response['people'];

  if (!isPlainRecord(connection)) {
    return null;
  }

  const total = connection['totalCount'];

  return typeof total === 'number' && Number.isFinite(total) && total >= 0
    ? Math.floor(total)
    : null;
};

/* -------------------------------------------------------------------------- */
/* The cursor                                                                  */
/* -------------------------------------------------------------------------- */

export const readNodeId = (node: unknown): string | null =>
  isPlainRecord(node) && typeof node['id'] === 'string' && node['id'].length > 0
    ? node['id']
    : null;

export const readNodeCreatedAt = (node: unknown): string | null =>
  isPlainRecord(node) &&
  typeof node['createdAt'] === 'string' &&
  node['createdAt'].length > 0
    ? node['createdAt']
    : null;

/** Has this record already been handled at the current cursor boundary? */
export const isAlreadyHandled = (
  cursor: BackfillCursor,
  node: unknown,
): boolean => {
  const id = readNodeId(node);

  return id !== null && cursor.ids.includes(id);
};

/**
 * Move the cursor over the records this tick actually reached.
 *
 * `handled` must be a **prefix** of the page in `createdAt` order — the records
 * the tick got through before its budget ran out, including any it skipped
 * because they were already at the boundary. Passing the whole page when only
 * part of it was processed is how a backfill silently skips records, so
 * `backfill-run.ts` builds the prefix as it goes rather than after the fact.
 *
 * The boundary id set carries forward only when the timestamp did not move; a
 * new timestamp starts a fresh, and usually tiny, set.
 */
export const advanceCursor = (
  previous: BackfillCursor,
  handled: readonly unknown[],
): BackfillCursor => {
  if (handled.length === 0) {
    return previous;
  }

  const last = handled[handled.length - 1];
  const createdAt = readNodeCreatedAt(last) ?? previous.createdAt;

  const carried =
    previous.createdAt === createdAt ? previous.ids : ([] as readonly string[]);

  const atBoundary = handled
    .filter((node) => (readNodeCreatedAt(node) ?? createdAt) === createdAt)
    .map(readNodeId)
    .filter((id): id is string => id !== null);

  return {
    createdAt,
    ids: [...new Set([...carried, ...atBoundary])],
  };
};

/* -------------------------------------------------------------------------- */
/* Handing a record to the scoring run                                         */
/* -------------------------------------------------------------------------- */

/**
 * Dress a fetched Person as the database-event payload `runPersonScoring` reads.
 *
 * This is the whole of the "reuse, do not duplicate" story: the bulk path builds
 * the same envelope the platform would have delivered and calls the same
 * function, so every guard, the release-marker pin, the audit row, the fail-open
 * flag and the trace payload are the ones the live path uses — not a second
 * implementation that will drift.
 *
 * `updatedFields` is deliberately absent. `isGreenlightAuthoredWrite` reads an
 * absent list as "we do not know what changed", which means "score it" — exactly
 * right for a record nobody has ever scored. Supplying a synthetic list would be
 * inventing history, and supplying the Greenlight-owned names would make guard 2
 * swallow every single record in the backfill.
 */
export const toScoringEvent = (
  node: Record<string, unknown>,
): Record<string, unknown> => ({
  recordId: readNodeId(node),
  properties: { after: node },
});
