/**
 * The I/O half of the backfill, kept out of the `define*` files so the whole
 * resume-after-crash story can be exercised against a fake API client and a fake
 * key-value store.
 *
 * Everything about *what* to read is in `src/backfill/backfill-plan.ts` and
 * everything about *where the walk has got to* is in
 * `src/backfill/backfill-state.ts`, both pure. This module reads state, fetches a
 * page, calls the existing scoring run once per record, and writes the position
 * back. The only impure things it touches are the client, the store and the `now`
 * it is handed — plus one elapsed-time reading, injected, so a test can make the
 * tick run out of budget without waiting forty seconds.
 *
 * ## Why a cron rather than the alternatives
 *
 * **Not inline in the post-install hook.** A 10,000-contact workspace at 100
 * requests a minute needs hours. The hook would time out, and the platform would
 * retry it — from the beginning, three times, each attempt re-walking whatever
 * the last one managed. That is not a slow backfill, it is a backfill that can
 * never finish and that spends its whole life re-scoring the first few hundred
 * records.
 *
 * **Not a self-enqueueing chain** (`enqueueJob` with a delay, each chunk booking
 * the next). Tempting, and it would pace itself precisely. But the chain has
 * exactly one thread of liveness: if any single link fails to enqueue — a
 * transient error in the one call that is not retried, because it *is* the retry
 * — the run stops silently and forever, and nothing in the system is left to
 * notice. A backfill that can die quietly is the same class of defect as a
 * scoring trigger that never fires on existing records. Fixing invisibility with
 * something else invisible is not a fix.
 *
 * **A cron draining a durable cursor.** The schedule is owned by the platform,
 * not by the job, so liveness is supplied from outside: every minute, something
 * asks "is there work?" whatever happened last time. A crashed tick costs one
 * lease and nothing else. And because progress lives in storage rather than in an
 * in-flight process, "is a backfill running and how far has it got" is a question
 * that can be *answered* — by the cron, by the admin panel, and by the next tick
 * — instead of inferred from the absence of a log line.
 *
 * The cost is that the cron ticks forever on workspaces with no backfill running.
 * That tick is one key-value read which returns null. It is the cheapest possible
 * price for the property that matters.
 *
 * ## Never throwing
 *
 * No path here throws out to the platform. A tick that fails releases its lease,
 * records the reason where the panel can show it, and returns; the next tick
 * tries again. A *record* that fails is logged and skipped — `runPersonScoring`
 * has already flagged it `UNSCORED` with an ERROR audit row on the way out, which
 * is ARCHITECTURE.md's golden rule doing its job. One bad record must not stall
 * the queue, and in `unscored` mode it cannot even be retried into a loop: the
 * fail-open write moves it off `greenlightDecision is NULL`, so it leaves the
 * queue by being flagged rather than by being fixed.
 */

import {
  advanceCursor,
  BACKFILL_CHUNK_SIZE,
  BACKFILL_TICK_BUDGET_MS,
  buildCountRequest,
  buildPageRequest,
  backfillPersonSelection,
  configuredSelectionFields,
  isAlreadyHandled,
  PAGE_ATTEMPTS,
  pageSizeFor,
  readTotalCount,
  toScoringEvent,
} from 'src/backfill/backfill-plan';
import {
  buildFieldExistenceProbe,
  classifyProbeRejection,
  describeFieldMappingFindings,
  EMPTY_FIELD_MAPPING_CHECK,
  fieldMappingAuditDetail,
  fieldMappingAuditName,
  FIELD_MAPPING_PROBE_LIMIT,
  mappedFieldNames,
  probeAnswered,
  type FieldMappingCheckResult,
  type FieldProbeVerdict,
  type MappingFinding,
} from 'src/backfill/field-mapping-check';
import {
  beginBackfill,
  cancelBackfill as cancelBackfillState,
  claimLease,
  commitChunk,
  describeBackfill,
  EMPTY_TALLY,
  isLeaseHeld,
  releaseLease,
  toBackfillState,
  type BackfillCursor,
  type BackfillMode,
  type BackfillProgress,
  type BackfillState,
  type BackfillTally,
} from 'src/backfill/backfill-state';
import {
  describeError,
  logGreenlight,
  readConnectionNodes,
  type GreenlightApiClient,
} from 'src/logic-functions/greenlight-api';
import {
  type CalibrationReaderPort,
  type CalibrationSealPort,
} from 'src/calibration';
import { readLeadObjectNameSingular } from 'src/logic-functions/greenlight-config-record';
import {
  loadConfigRecord,
  runPersonScoring,
  type ReleaseMarkerStore,
} from 'src/logic-functions/scoring-run';
import { SCORING_ENGINE_VERSION } from 'src/scoring';

/* -------------------------------------------------------------------------- */
/* Ports                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The slice of app key-value storage the backfill needs, as a port — same shape
 * and same justification as `ReleaseMarkerStore` in `scoring-run.ts`.
 * `src/logic-functions/backfill-state-store.ts` holds the one real implementation.
 */
export interface BackfillStateStore {
  read(): Promise<unknown>;
  write(state: BackfillState): Promise<void>;
}

export interface BackfillDeps {
  readonly client: GreenlightApiClient;
  readonly store: BackfillStateStore;
  readonly now: Date;
  /**
   * Elapsed-time source for the tick budget, injected so a test can expire the
   * budget instantly. `now` cannot serve: it is a fixed instant on purpose, and
   * the whole point of the budget is that real time passes during a chunk.
   */
  readonly clock?: () => number;
}

export interface BackfillChunkDeps extends BackfillDeps {
  readonly markers: ReleaseMarkerStore;
  /**
   * Read-only calibration cache, passed straight through to each record's
   * scoring run so a bulk pass calibrates identically to a live event. Omitted
   * means shipped defaults, which is what an unlicensed backfill has always
   * produced.
   */
  readonly calibration?: CalibrationReaderPort | null;
  /** Checks the cached calibration belongs to this workspace's licence key. */
  readonly calibrationSeal?: CalibrationSealPort;
  /** Overridden only by tests; production uses the rate-limit-derived default. */
  readonly chunkSize?: number;
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                              */
/* -------------------------------------------------------------------------- */

const readState = async (
  store: BackfillStateStore,
): Promise<{ ok: true; state: BackfillState | null } | { ok: false; error: string }> => {
  try {
    return { ok: true, state: toBackfillState(await store.read()) };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
};

/** Best effort. A count drives a progress bar; it must never stop a run. */
const countMatching = async (
  client: GreenlightApiClient,
  mode: BackfillMode,
): Promise<number | null> => {
  try {
    return readTotalCount(await client.query(buildCountRequest(mode)));
  } catch (error) {
    logGreenlight('backfill_count_failed', { mode, error: describeError(error) });

    return null;
  }
};

/**
 * A run-level row in the audit log, so "was this workspace ever backfilled, and
 * when" survives the key-value blob and is answerable from inside the CRM.
 *
 * Filed under `BACKFILL`, which the object's `eventType` SELECT now carries. It
 * used to borrow `CONFIG_CHANGED` — the precedent `install-run.ts` set for a
 * lifecycle event that is not about one lead — because appending a SELECT option
 * belonged to another workstream. It does not any more: a backfill is not a
 * configuration change, and an admin filtering for "what did this workspace do
 * in bulk" should not have to read row names to find out.
 *
 * Existing `CONFIG_CHANGED` rows are left exactly as written. Option identity in
 * Twenty derives from the option `value`, so appending disturbed nothing, and a
 * row that recorded what it recorded at the time is not something to rewrite.
 *
 * Swallows every failure, like its counterpart in `install-run.ts`: a missing
 * provenance row is not worth failing a backfill over.
 *
 * `eventType` is a parameter with a default rather than a constant because this
 * module files rows of two kinds. A backfill starting, progressing and finishing
 * is `BACKFILL`. A configured field name that does not exist is not a backfill
 * event at all — it is a fault an admin has to act on, and an admin filtering the
 * audit log for faults filters for `ERROR`. Making it share `BACKFILL` would bury
 * the one row in this app that says "your scores are wrong" underneath the
 * routine ones that say "bulk scoring happened", which is the same argument the
 * object's own `eventType` comment makes about SUPPRESSED and UNSUPPRESSED.
 */
const writeBackfillAuditRow = async (
  client: GreenlightApiClient,
  now: Date,
  summary: string,
  detail: Record<string, unknown>,
  eventType: 'BACKFILL' | 'ERROR' = 'BACKFILL',
): Promise<void> => {
  try {
    await client.mutation({
      createGreenlightAuditLog: {
        __args: {
          data: {
            name: summary,
            eventType,
            occurredAt: now.toISOString(),
            leadObjectNameSingular: '',
            leadRecordId: null,
            leadDisplayName: '',
            actorType: 'SYSTEM',
            actorDisplayName: `Greenlight backfill ${SCORING_ENGINE_VERSION}`,
            ruleTrace: detail,
            score: null,
            band: 'UNSCORED',
            decision: 'UNSCORED',
            overrideReason: '',
            traceId: String(detail['runId'] ?? ''),
          },
        },
        id: true,
      },
    });
  } catch (error) {
    logGreenlight('backfill_audit_write_failed', {
      summary,
      error: describeError(error),
    });
  }
};

/* -------------------------------------------------------------------------- */
/* Does the configured field mapping name fields that exist?                   */
/* -------------------------------------------------------------------------- */

/**
 * The connection the backfill actually walks, and what to call it on screen.
 *
 * Hard-coded rather than derived from `leadObjectNameSingular`, and deliberately:
 * `buildPageRequest` walks `people` and nothing else, and v0.1 writes score,
 * decision and trace fields to Person only. Probing whichever object the SELECT
 * happens to name would ask about a schema this run is not going to read, and
 * would tell an admin their mapping is fine for records that are not being
 * scored at all. The configured object name still reaches the audit row, where
 * "which object did it mean" is a question worth being able to answer.
 */
const LEAD_CONNECTION = 'people';
const LEAD_OBJECT_LABEL = 'Person';

/**
 * One name, one question, in the half of a query Twenty validates.
 *
 * A response that came back but carries no connection is `inconclusive`, not
 * `absent`: see `probeAnswered`. Every rejection is handed to the pure
 * classifier, which is where the decision to stay quiet unless certain lives.
 */
const probeFieldExists = async (
  client: GreenlightApiClient,
  fieldName: string,
): Promise<FieldProbeVerdict> => {
  try {
    const response = await client.query(
      buildFieldExistenceProbe(LEAD_CONNECTION, fieldName),
    );

    return probeAnswered(LEAD_CONNECTION, response) ? 'present' : 'inconclusive';
  } catch (error) {
    return classifyProbeRejection(fieldName, describeError(error));
  }
};

/**
 * Ask about every configured name, one at a time.
 *
 * Serial rather than `Promise.all`, for the same reason `icp-run.ts` probes
 * serially: eight simultaneous requests is a burst against a per-minute ceiling
 * the live scoring path is also drawing on, and there is nothing to hurry for —
 * this runs once, on a click, before a job that will take hours.
 *
 * Exported so the check can be unit-tested against a fake client without going
 * through a whole run.
 */
export const checkFieldMapping = async (
  client: GreenlightApiClient,
  configRecord: unknown,
): Promise<FieldMappingCheckResult> => {
  const mapped = mappedFieldNames(configRecord);
  const asked = mapped.slice(0, FIELD_MAPPING_PROBE_LIMIT);

  const missing: MappingFinding[] = [];
  let inconclusive = 0;

  for (const candidate of asked) {
    const verdict = await probeFieldExists(client, candidate.name);

    if (verdict === 'absent') {
      missing.push(candidate);
    } else if (verdict === 'inconclusive') {
      inconclusive += 1;
    }
  }

  return {
    missing,
    probed: asked.length,
    inconclusive,
    unchecked: mapped.length - asked.length,
  };
};

/**
 * The whole check, wrapped so that it cannot cost the caller anything.
 *
 * Reads the config record itself rather than taking one, because the only caller
 * is `startBackfill`, which has no reason to hold a config otherwise — and
 * because the read has to be inside the `try` that makes this fail-open. If
 * anything at all goes wrong, from the config read to the last probe, the result
 * is the empty one: no findings, no notice, no audit row, and a backfill that
 * behaves precisely as it did before this check existed.
 *
 * That is the ordering rule the whole feature is built on. A validation that can
 * break scoring is worse than the defect it was written to catch.
 */
const runFieldMappingCheck = async (
  client: GreenlightApiClient,
): Promise<{
  readonly result: FieldMappingCheckResult;
  readonly configRecord: Record<string, unknown> | null;
}> => {
  try {
    const configRecord = await loadConfigRecord(client);

    return {
      result: await checkFieldMapping(client, configRecord),
      configRecord,
    };
  } catch (error) {
    logGreenlight('backfill_field_mapping_check_failed', {
      error: describeError(error),
    });

    return { result: EMPTY_FIELD_MAPPING_CHECK, configRecord: null };
  }
};

/* -------------------------------------------------------------------------- */
/* One tick                                                                    */
/* -------------------------------------------------------------------------- */

export type BackfillChunkOutcome =
  /** No run has ever been requested on this workspace. */
  | { status: 'no_run' }
  /** A run exists but is finished, cancelled or failed. */
  | { status: 'not_running'; runStatus: BackfillState['status'] }
  /** Another tick is mid-chunk. */
  | { status: 'locked'; leaseUntil: string | null }
  | { status: 'state_unreadable'; error: string }
  | { status: 'lease_not_taken'; error: string }
  | { status: 'config_unavailable'; error: string }
  | { status: 'page_failed'; error: string }
  | {
      status: 'progressed';
      runId: string;
      tally: BackfillTally;
      exhausted: boolean;
      degraded: boolean;
    };

interface PageResult {
  readonly nodes: Record<string, unknown>[];
  /** False on the fallback rung that drops ordering and the cursor together. */
  readonly ordered: boolean;
  readonly degraded: boolean;
}

/**
 * Walk `PAGE_ATTEMPTS` until one rung answers. See that constant for why each
 * rung exists; the `all`-mode filter below is why the last one is skipped there.
 */
const fetchPage = async (
  client: GreenlightApiClient,
  state: BackfillState,
  chunkSize: number,
  extraFields: readonly string[],
): Promise<{ ok: true; page: PageResult } | { ok: false; error: string }> => {
  const attempts = PAGE_ATTEMPTS.filter(
    (attempt) => attempt.ordered || state.mode === 'unscored',
  );

  let lastError = 'no page attempt was made';

  for (const [index, attempt] of attempts.entries()) {
    const selection = backfillPersonSelection(
      attempt.useExtraFields ? extraFields : [],
    );

    try {
      const response = await client.query(
        buildPageRequest({
          mode: state.mode,
          cursor: state.cursor,
          chunkSize,
          selection,
          ordered: attempt.ordered,
        }),
      );

      return {
        ok: true,
        page: {
          nodes: readConnectionNodes(response, 'people'),
          ordered: attempt.ordered,
          degraded: index > 0,
        },
      };
    } catch (error) {
      lastError = describeError(error);

      logGreenlight('backfill_page_attempt_failed', {
        runId: state.runId,
        mode: state.mode,
        attempt: index,
        ordered: attempt.ordered,
        useExtraFields: attempt.useExtraFields,
        error: lastError,
      });
    }
  }

  return { ok: false, error: lastError };
};

/**
 * Score one bounded chunk and record where the walk reached. Never throws.
 *
 * The ordering of the steps is the resumability argument, so it is worth stating
 * flatly:
 *
 *   1. Read the state. No run, or not `running` — return.
 *   2. Refuse if another tick holds the lease.
 *   3. Take the lease **and write it** before touching a single record. A tick
 *      that cannot record that it started must not start.
 *   4. Read the config once for the whole chunk. A failure here **abandons the
 *      tick** rather than falling back to engine defaults: the event path treats
 *      an unreadable config as a per-lead fail-open, which is right for one lead,
 *      but scoring thirty leads against defaults a workspace has deliberately
 *      moved away from would bulk-gate or bulk-pass them on configuration nobody
 *      chose. A minute of delay costs nothing; thirty wrong decisions do.
 *   5. Fetch the page, degrading through `PAGE_ATTEMPTS`.
 *   6. Score records in order, stopping when the tick budget runs out, and build
 *      the *prefix actually reached* as we go.
 *   7. Commit: advance the cursor over that prefix only, fold in the tally,
 *      release the lease.
 *
 * A crash anywhere in 4-6 leaves the cursor exactly where step 3 found it, so the
 * next tick after the lease expires re-fetches the same page. Records the crashed
 * tick had already scored are re-scored — and write nothing, because guard 3
 * recognises the stored fingerprint. That is the whole of the crash story: at
 * most one chunk of duplicated *reads*, never a duplicated write, never a
 * duplicated audit row, and never a skipped record.
 */
export const runBackfillChunk = async ({
  client,
  store,
  markers,
  calibration,
  calibrationSeal,
  now,
  clock = () => Date.now(),
  chunkSize = BACKFILL_CHUNK_SIZE,
}: BackfillChunkDeps): Promise<BackfillChunkOutcome> => {
  const read = await readState(store);

  if (!read.ok) {
    logGreenlight('backfill_state_unreadable', { error: read.error });

    return { status: 'state_unreadable', error: read.error };
  }

  const state = read.state;

  if (state === null) {
    return { status: 'no_run' };
  }

  if (state.status !== 'running') {
    return { status: 'not_running', runStatus: state.status };
  }

  if (isLeaseHeld(state, now)) {
    return { status: 'locked', leaseUntil: state.leaseUntil };
  }

  const claimed = claimLease(state, now);

  try {
    await store.write(claimed);
  } catch (error) {
    const message = describeError(error);

    logGreenlight('backfill_lease_write_failed', {
      runId: state.runId,
      error: message,
    });

    return { status: 'lease_not_taken', error: message };
  }

  const commit = async (
    cursor: BackfillCursor,
    tally: BackfillTally,
    lastError: string | null,
    exhausted: boolean,
    stalled: boolean,
  ): Promise<void> => {
    const next = commitChunk(claimed, {
      now,
      cursor,
      tally,
      lastError,
      exhausted,
      stalled,
    });

    try {
      await store.write(next);
    } catch (error) {
      // Nothing to be done but say so. The lease expires on its own, and the
      // chunk that was not recorded is simply redone — which writes nothing.
      logGreenlight('backfill_commit_failed', {
        runId: state.runId,
        error: describeError(error),
      });

      return;
    }

    if (exhausted) {
      logGreenlight('backfill_completed', {
        runId: next.runId,
        mode: next.mode,
        ...next.tally,
        chunks: next.chunks,
      });

      await writeBackfillAuditRow(
        client,
        now,
        `BACKFILL · Greenlight backfill finished · ${next.tally.examined} records examined`,
        {
          action: 'backfill_completed',
          runId: next.runId,
          mode: next.mode,
          startedAt: next.startedAt,
          finishedAt: next.finishedAt,
          chunks: next.chunks,
          ...next.tally,
          engineVersion: SCORING_ENGINE_VERSION,
        },
      );
    }
  };

  const abandon = async (lastError: string): Promise<void> => {
    try {
      await store.write(releaseLease(claimed, now, lastError));
    } catch (error) {
      logGreenlight('backfill_release_failed', {
        runId: state.runId,
        error: describeError(error),
      });
    }
  };

  let configRecord: Record<string, unknown> | null;

  try {
    configRecord = await loadConfigRecord(client);
  } catch (error) {
    const message = describeError(error);

    logGreenlight('backfill_config_unavailable', {
      runId: state.runId,
      error: message,
    });

    await abandon(message);

    return { status: 'config_unavailable', error: message };
  }

  const page = await fetchPage(
    client,
    state,
    chunkSize,
    configuredSelectionFields(configRecord),
  );

  if (!page.ok) {
    await abandon(page.error);

    return { status: 'page_failed', error: page.error };
  }

  const { nodes, ordered, degraded } = page.page;

  const tally = { ...EMPTY_TALLY };
  const handled: Record<string, unknown>[] = [];
  const deadline = clock() + BACKFILL_TICK_BUDGET_MS;

  for (const node of nodes) {
    // The page is deliberately larger than the chunk — the surplus pays for
    // skipping the cursor boundary, not for extra scoring. The rate arithmetic
    // is sized on the chunk, so the chunk is what bounds the writes.
    if (tally.examined >= chunkSize) {
      break;
    }

    // At least one record is always attempted, so a clock that is already past
    // the budget cannot stall the run forever.
    if (tally.examined > 0 && clock() > deadline) {
      break;
    }

    // Only meaningful on an ordered page: the boundary ids exist to stop `gte`
    // re-processing records at the cursor's exact timestamp. The unordered rung
    // has no cursor, and its filter already excludes anything scored.
    if (ordered && isAlreadyHandled(state.cursor, node)) {
      handled.push(node);
      continue;
    }

    tally.examined += 1;

    try {
      const outcome = await runPersonScoring({
        client,
        event: toScoringEvent(node),
        now,
        markers,
        // Read once per chunk, not once per record. The single largest saving in
        // the whole design — see `PreloadedConfig` in `scoring-run.ts`.
        config: { record: configRecord },
        calibration,
        calibrationSeal,
      });

      switch (outcome.status) {
        case 'scored':
          tally.scored += 1;
          break;
        case 'unchanged':
          tally.unchanged += 1;
          break;
        case 'skipped':
          tally.skipped += 1;
          break;
        default:
          tally.failed += 1;
          logGreenlight('backfill_record_failed', {
            runId: state.runId,
            leadRecordId: outcome.leadRecordId,
            error: outcome.error,
          });
          break;
      }
    } catch (error) {
      // `runPersonScoring` is documented never to throw, and it does not. This
      // exists so that if it ever starts to, one malformed record costs one
      // record rather than the whole queue.
      tally.failed += 1;

      logGreenlight('backfill_record_threw', {
        runId: state.runId,
        error: describeError(error),
      });
    }

    handled.push(node);
  }

  // Only a page that came back short of what was asked for *and* was fully
  // worked through proves there is nothing left. A page cut off by the chunk
  // budget or the tick budget proves nothing.
  const requested = ordered ? pageSizeFor(chunkSize, state.cursor) : chunkSize;
  const exhausted =
    nodes.length < requested && handled.length === nodes.length;

  // Records came back and the tick got through none of them. See
  // `BACKFILL_MAX_STALLS`: repeated, this is a walk that cannot advance, and it
  // has to become visible rather than spin.
  const stalled = nodes.length > 0 && tally.examined === 0;

  const cursor = ordered ? advanceCursor(state.cursor, handled) : state.cursor;

  await commit(
    cursor,
    tally,
    degraded ? 'Ran with a reduced query. See logs.' : null,
    exhausted,
    stalled,
  );

  logGreenlight('backfill_chunk', {
    runId: state.runId,
    mode: state.mode,
    requested,
    fetched: nodes.length,
    handled: handled.length,
    ...tally,
    exhausted,
    stalled,
    degraded,
  });

  return {
    status: 'progressed',
    runId: state.runId,
    tally,
    exhausted,
    degraded,
  };
};

/* -------------------------------------------------------------------------- */
/* Control surface                                                             */
/* -------------------------------------------------------------------------- */

export interface BackfillControlResult {
  readonly status: number;
  readonly body: {
    readonly outcome: string;
    readonly message: string;
    /** Null when no backfill has ever been requested on this workspace. */
    readonly run: BackfillProgress | null;
    /** Person records with no Greenlight decision at all. Null if uncountable. */
    readonly neverScoredCount: number | null;
    /** So the panel can state the cadence without hard-coding it twice. */
    readonly chunkSize: number;
  };
}

const control = (
  status: number,
  outcome: string,
  message: string,
  run: BackfillProgress | null,
  neverScoredCount: number | null,
): BackfillControlResult => ({
  status,
  body: {
    outcome,
    message,
    run,
    neverScoredCount,
    chunkSize: BACKFILL_CHUNK_SIZE,
  },
});

/**
 * What the admin panel renders.
 *
 * Deliberately answers all four questions in one round trip — how many are
 * unscored, is something running, how far has it got, when did it last finish —
 * because a surface that needs three calls to tell you whether the gate is
 * working is a surface people stop opening.
 */
export const readBackfillStatus = async ({
  client,
  store,
  now,
}: BackfillDeps): Promise<BackfillControlResult> => {
  const read = await readState(store);
  const neverScoredCount = await countMatching(client, 'unscored');

  if (!read.ok) {
    return control(
      200,
      'state_unreadable',
      'Greenlight could not read the backfill’s progress. Scoring of new leads is unaffected. Try again, and start a backfill if this persists.',
      null,
      neverScoredCount,
    );
  }

  if (read.state === null) {
    return control(
      200,
      'no_run',
      neverScoredCount === null || neverScoredCount === 0
        ? 'No backfill has run on this workspace.'
        : `No backfill has run on this workspace. ${neverScoredCount} people have never been scored — until they are, an empty gate queue does not mean they are clean.`,
      null,
      neverScoredCount,
    );
  }

  return control(
    200,
    read.state.status,
    '',
    describeBackfill(read.state, now),
    neverScoredCount,
  );
};

export interface StartBackfillInput extends BackfillDeps {
  readonly mode: BackfillMode;
  /** Server-derived. Never taken from the request body. */
  readonly requestedBy: string;
}

/**
 * Begin a run, or refuse because one is already going.
 *
 * The refusal is a `200` carrying the running run's progress rather than a `409`:
 * the caller asked for a backfill and there is a backfill, so the honest answer
 * is to show them the one that exists. Starting a second would double the request
 * rate against a limit the first is already sized against.
 *
 * ============================================================================
 * ## Why the field-mapping check happens here
 *
 * A configured field name that does not exist comes back `null` rather than
 * failing anything (`field-mapping-check.ts` has the whole story). Somewhere has
 * to notice. Four places could:
 *
 *   - **On the per-record scoring path.** Never. Scoring one lead must not gain a
 *     schema round trip to answer a question whose answer changes about once a
 *     year. The mapping changes rarely; that path runs constantly.
 *   - **On each backfill tick.** Same objection in slower motion. A run is
 *     thousands of ticks, the answer is identical on every one of them, and the
 *     probes would be spent against the same per-minute ceiling the chunk
 *     arithmetic already budgets 62 of.
 *   - **On the config record's write path.** There is no such path to hook. The
 *     record is edited by a human on Twenty's own record page and this app
 *     registers no database-event function against it; adding one would mean a
 *     schema probe on every field save, and it would still say nothing about the
 *     workspaces that were already mis-configured before this shipped.
 *   - **On the panel's status poll.** The panel polls `readBackfillStatus` while
 *     a run is going. A probe there is a schema query every few seconds, for a
 *     fact that has not moved.
 *
 * **Here**, once per run, is the moment the question is actually being asked:
 * this is where a whole workspace gets scored against this mapping in one go, so
 * it is where a wrong mapping does its damage all at once. It is also the moment
 * an admin is looking — they pressed Start and are reading the reply. And because
 * `requestInstallBackfill` routes through this function, install and upgrade are
 * covered by the same code without a second implementation, as is the re-score
 * `icp-run.ts` kicks off after a profile is applied.
 *
 * ## What it costs
 *
 * One config read plus one `first: 1` query per configured name, capped at
 * `FIELD_MAPPING_PROBE_LIMIT`, once, on a human's click. A stock workspace has a
 * single configured name (`decisionMakerFieldName`, seeded `jobTitle`), so the
 * usual bill is two requests before a job that will run for hours. Nothing here
 * is on a schedule and nothing here can fail the start.
 */
export const startBackfill = async ({
  client,
  store,
  now,
  mode,
  requestedBy,
}: StartBackfillInput): Promise<BackfillControlResult> => {
  const read = await readState(store);

  if (read.ok && read.state !== null && read.state.status === 'running') {
    return control(
      200,
      'already_running',
      'A backfill is already running. Watch its progress here, or stop it first if you need to change the mode.',
      describeBackfill(read.state, now),
      await countMatching(client, 'unscored'),
    );
  }

  const totalAtStart = await countMatching(client, mode);
  const state = beginBackfill({ mode, now, requestedBy, totalAtStart });

  try {
    await store.write(state);
  } catch (error) {
    const message = describeError(error);

    logGreenlight('backfill_start_failed', { mode, error: message });

    return control(
      502,
      'start_failed',
      `Greenlight could not record the backfill, so it did not start one. Nothing has changed. (${message})`,
      null,
      totalAtStart,
    );
  }

  logGreenlight('backfill_started', {
    runId: state.runId,
    mode,
    requestedBy,
    totalAtStart,
  });

  // After the run is recorded, never before. A configured name that does not
  // exist is a reason to tell somebody, not a reason to refuse to start: the
  // backfill still fills in blanks, still respects suppression, and still leaves
  // the workspace better off than the unscored state it was in. Refusing would
  // trade a quiet defect for a loud one.
  const mapping = await runFieldMappingCheck(client);
  const mappingNotice = describeFieldMappingFindings(
    mapping.result.missing,
    LEAD_OBJECT_LABEL,
  );

  if (mapping.result.missing.length > 0) {
    const detail = {
      ...fieldMappingAuditDetail(
        mapping.result,
        readLeadObjectNameSingular(mapping.configRecord),
      ),
      runId: state.runId,
      mode,
      requestedBy,
      engineVersion: SCORING_ENGINE_VERSION,
    };

    logGreenlight('backfill_field_mapping_missing', detail);

    await writeBackfillAuditRow(
      client,
      now,
      fieldMappingAuditName(mapping.result.missing, LEAD_OBJECT_LABEL),
      detail,
      'ERROR',
    );
  } else if (mapping.result.inconclusive > 0 || mapping.result.unchecked > 0) {
    // Nothing an admin can act on, so nothing an admin is shown. Logged because
    // "the check ran and could not answer" and "the check ran and found nothing
    // wrong" are different states, and support should not have to guess which
    // one a quiet run was in.
    logGreenlight('backfill_field_mapping_unverified', {
      runId: state.runId,
      probed: mapping.result.probed,
      inconclusive: mapping.result.inconclusive,
      unchecked: mapping.result.unchecked,
    });
  }

  await writeBackfillAuditRow(
    client,
    now,
    `BACKFILL · Greenlight backfill started · ${mode}`,
    {
      action: 'backfill_started',
      runId: state.runId,
      mode,
      requestedBy,
      totalAtStart,
      chunkSize: BACKFILL_CHUNK_SIZE,
      engineVersion: SCORING_ENGINE_VERSION,
      fieldMappingChecked: mapping.result.probed,
      fieldMappingMissing: mapping.result.missing.length,
    },
  );

  const started =
    totalAtStart === null
      ? 'Backfill started. It runs about one batch a minute in the background; you can close this panel.'
      : `Backfill started over ${totalAtStart} records. It runs ${BACKFILL_CHUNK_SIZE} a minute in the background; you can close this panel.`;

  return control(
    200,
    'started',
    // The notice leads. The confirmation ends with "you can close this panel",
    // and a warning placed after that sentence is a warning nobody reads.
    mappingNotice === null ? started : `${mappingNotice} ${started}`,
    describeBackfill(state, now),
    await countMatching(client, 'unscored'),
  );
};

export const stopBackfill = async ({
  client,
  store,
  now,
  requestedBy,
}: BackfillDeps & { requestedBy: string }): Promise<BackfillControlResult> => {
  const read = await readState(store);
  const neverScoredCount = await countMatching(client, 'unscored');

  if (!read.ok || read.state === null) {
    return control(
      200,
      'no_run',
      'There is no backfill to stop.',
      null,
      neverScoredCount,
    );
  }

  if (read.state.status !== 'running') {
    return control(
      200,
      'not_running',
      'That backfill is not running any more.',
      describeBackfill(read.state, now),
      neverScoredCount,
    );
  }

  const cancelled = cancelBackfillState(read.state, now, requestedBy);

  try {
    await store.write(cancelled);
  } catch (error) {
    return control(
      502,
      'stop_failed',
      `Greenlight could not stop the backfill. (${describeError(error)})`,
      describeBackfill(read.state, now),
      neverScoredCount,
    );
  }

  logGreenlight('backfill_cancelled', {
    runId: cancelled.runId,
    requestedBy,
    ...cancelled.tally,
  });

  return control(
    200,
    'stopped',
    'Backfill stopped. Records already scored keep their scores; the rest are untouched. Starting again begins from the beginning, which is cheap — records that are already scored are recognised and left alone.',
    describeBackfill(cancelled, now),
    neverScoredCount,
  );
};

/* -------------------------------------------------------------------------- */
/* The install entry point                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Request the automatic first backfill. **This is the only function the
 * post-install hook needs to call.**
 *
 * ## Idempotency across install *and* upgrade
 *
 * The post-install hook runs on a fresh install, on every version upgrade
 * (`shouldRunOnVersionUpgrade: true`), and up to three times on each of those
 * because the async queue retries. So the question is not "has a backfill run",
 * it is "has one ever been *requested*" — and the presence of any state at all,
 * in any status, is the durable answer. A completed run, a cancelled run and a
 * run still going all mean the same thing here: a human has been given the
 * surface, do not start another behind their back.
 *
 * That deliberately includes a run somebody cancelled. Re-starting a backfill an
 * admin stopped, on the next patch release, is the app overruling a decision it
 * was told about. If they want another they can start one; the panel is one
 * command away and says exactly how many records are still unscored.
 *
 * ## Why `unscored` and never `all`
 *
 * An install-triggered `all` would rewrite `greenlightDecision` on every record in
 * the workspace, including ones a rep has already worked from — on an upgrade,
 * without anyone asking. `unscored` only ever fills in a blank, and a blank is
 * unambiguously wrong: nothing has looked at that lead.
 *
 * ## Never throws
 *
 * The post-install hook deliberately does not catch, so that a transient failure
 * is retried by the platform. That is right for seeding the config, which is what
 * that hook is *for*. It is not right for this: a backfill that could not be
 * requested must not fail the install or burn the hook's three retries, because
 * the workspace is perfectly functional without it and the admin can start one by
 * hand. Every failure below is logged and swallowed.
 */
export const requestInstallBackfill = async ({
  client,
  store,
  now,
}: BackfillDeps): Promise<
  | { status: 'requested'; runId: string; totalAtStart: number | null }
  | { status: 'already_requested'; runStatus: BackfillState['status'] }
  | { status: 'nothing_to_do' }
  | { status: 'failed'; error: string }
> => {
  try {
    const read = await readState(store);

    if (!read.ok) {
      logGreenlight('backfill_install_state_unreadable', { error: read.error });

      return { status: 'failed', error: read.error };
    }

    if (read.state !== null) {
      logGreenlight('backfill_install_skipped', {
        reason: 'already_requested',
        runId: read.state.runId,
        runStatus: read.state.status,
      });

      return { status: 'already_requested', runStatus: read.state.status };
    }

    const totalAtStart = await countMatching(client, 'unscored');

    // A fresh workspace with nothing to walk gets no run and no audit row. The
    // cron would finish it on the first tick anyway; not starting is tidier and
    // leaves the panel saying "no backfill has run", which is true and correct.
    if (totalAtStart === 0) {
      logGreenlight('backfill_install_skipped', {
        reason: 'nothing_unscored',
      });

      return { status: 'nothing_to_do' };
    }

    const result = await startBackfill({
      client,
      store,
      now,
      mode: 'unscored',
      requestedBy: 'install',
    });

    if (result.body.outcome !== 'started' || result.body.run === null) {
      return { status: 'failed', error: result.body.outcome };
    }

    return {
      status: 'requested',
      runId: result.body.run.runId,
      totalAtStart,
    };
  } catch (error) {
    const message = describeError(error);

    logGreenlight('backfill_install_request_failed', { error: message });

    return { status: 'failed', error: message };
  }
};
