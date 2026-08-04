/**
 * Numaya Greenlight — the durable state of a backfill run.
 *
 * Everything in this file is pure: no SDK import, no network, no clock read.
 * `src/logic-functions/backfill-run.ts` is the shell that reads this state out of
 * Twenty's app key-value storage, hands it to the functions below, and writes the
 * result back. That split exists for the same reason it exists in
 * `src/gate/release-decision.ts`: resumability is the property this feature lives
 * or dies by, and it has to be exhaustively testable without a live workspace and
 * without waiting a real minute between cron ticks.
 *
 * ## Why there is state at all
 *
 * The scoring trigger fires on Person create and update. Records that already
 * existed when Greenlight was installed emit neither, so they are never scored —
 * measured on a dev workspace, 1200 of 1205 people, while the gate queue sat
 * empty. An empty queue reads as "everything has been checked and is clean". It
 * was not: nothing had been checked.
 *
 * Fixing that means walking every existing Person, and a workspace of ten
 * thousand cannot be walked inside one function invocation at 100 requests a
 * minute. The walk therefore spans many invocations, and anything that spans
 * invocations needs its progress somewhere a crash cannot take with it.
 *
 * ## What "resumable" means precisely here
 *
 * A crashed or timed-out tick loses **the chunk it was in the middle of**, not
 * the run. The cursor is only advanced over records the tick actually reached, so
 * the next tick re-fetches the tail it did not get to. Records it *did* reach are
 * re-fetched too when the crash landed mid-chunk — and re-scoring them costs
 * nothing, because `scoring-run.ts`'s outcome fingerprint (guard 3) recognises an
 * unchanged outcome and writes neither the record nor an audit row. Idempotency
 * is not something this module has to provide; it only has to avoid *losing*
 * position, and it is allowed to lose a little.
 *
 * ## The lease
 *
 * `kv` offers no compare-and-set, so two overlapping ticks could both read the
 * same cursor. `leaseUntil` narrows that window: a tick claims the lease before
 * it does any work and releases it when it commits. It is a courtesy, not a
 * mutex — the read-modify-write race is still theoretically open.
 *
 * That is acceptable because the lease is not what makes the run safe. Guard 3
 * is. Two ticks processing the same page produce one set of writes and one set of
 * audit rows; the second finds every fingerprint already stored and does nothing.
 * The lease exists to stop us *wasting* the rate-limit budget, not to stop us
 * corrupting anything.
 *
 * The lease also has to expire, and that is the whole point: a tick the platform
 * killed on timeout never releases it, so a permanent lease would deadlock the
 * run at the first timeout. `BACKFILL_LEASE_MS` is therefore the maximum a crash
 * can cost — see the constant.
 */

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What a run is allowed to look at.
 *
 *   - `unscored` — Person records with **no** `greenlightDecision` at all. This
 *     is the defect: never seen by the engine. It is the default and it is the
 *     only mode that runs itself on install.
 *   - `all` — every Person, re-scored. Needed after a rule or weight change, and
 *     needed to move records scored before `BLOCKED` existed off their legacy
 *     `GATE` value. Never automatic: it rewrites decisions a workspace may have
 *     been working from, so a human asks for it explicitly.
 *
 * Note what is *not* here: a mode that re-scores `UNSCORED` records. Those are
 * fail-opens the engine already looked at and could not score, they already have
 * a view of their own, and a mode that retried them on a schedule would append an
 * ERROR audit row per record per pass forever. `all` covers them when a human
 * decides the underlying cause is fixed.
 */
export const BACKFILL_MODES = ['unscored', 'all'] as const;

export type BackfillMode = (typeof BACKFILL_MODES)[number];

export const isBackfillMode = (value: unknown): value is BackfillMode =>
  typeof value === 'string' &&
  (BACKFILL_MODES as readonly string[]).includes(value);

/**
 * `running` is the only state the cron acts on. The other three are terminal and
 * exist so the panel can say which of them happened — "finished", "you stopped
 * it" and "it broke" are three different things an admin needs told apart, and
 * collapsing them into "not running" is the same species of silence this whole
 * feature exists to remove.
 */
export type BackfillStatus = 'running' | 'completed' | 'cancelled' | 'failed';

/* -------------------------------------------------------------------------- */
/* Timings                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How long a tick holds the lease.
 *
 * Sized at roughly twice the cron function's `timeoutSeconds` (55). Shorter than
 * the timeout and a slow-but-healthy tick would have its lease stolen by the next
 * one, which is the overlap the lease exists to prevent. Much longer and a tick
 * the platform killed would idle the run for no reason: this is the exact cost of
 * a crash, so it is deliberately the smallest value that is safely above one full
 * invocation.
 */
export const BACKFILL_LEASE_MS = 120_000;

/**
 * Ceiling on how many boundary ids the cursor carries.
 *
 * `cursor.ids` holds the records already handled at the cursor's exact timestamp,
 * so the `gte` filter does not re-process them. It grows whenever more records
 * than one chunk share a single `createdAt` — which is not exotic: Postgres
 * `now()` is constant within a transaction, so a bulk import writes rows with
 * byte-identical timestamps.
 *
 * The value is not arbitrary. `backfill-plan.ts` over-fetches a page by exactly
 * this many rows so that skipping the boundary does not eat the chunk's budget,
 * and Twenty's page ceiling is 60, so this is `60 − BACKFILL_CHUNK_SIZE`. It is
 * declared here rather than imported from there only because `backfill-plan.ts`
 * imports *this* module; `backfill-plan.test.ts` asserts the two agree.
 *
 * Beyond the cap the walk still cannot skip a record — it can only re-read one,
 * which guard 3 makes free. What it can do is stop making progress, and
 * `BACKFILL_MAX_STALLS` is what turns that into something visible.
 */
export const BACKFILL_MAX_CURSOR_IDS = 30;

/**
 * Consecutive ticks that fetched records but got through none of them before the
 * run is declared failed.
 *
 * The only way this happens is a `createdAt` boundary wider than a whole page:
 * more than sixty records sharing one timestamp, where the order among ties is
 * not stable enough for the boundary set to cover them. In `unscored` mode it
 * self-corrects, because a scored record leaves the filter. In `all` mode there
 * is no self-correction, and without this the run would spin against the rate
 * limit forever, reporting "running", making no progress, and looking exactly
 * like a healthy backfill on a large workspace.
 *
 * Three rather than one: tie ordering can legitimately shuffle between pages, so
 * a single unproductive tick is not evidence of anything. Three in a row is.
 */
export const BACKFILL_MAX_STALLS = 3;

/* -------------------------------------------------------------------------- */
/* The state                                                                   */
/* -------------------------------------------------------------------------- */

/** Where the walk has got to. Split out because it is advanced as a unit. */
export interface BackfillCursor {
  /** ISO 8601 `createdAt` of the last record handled. Null before the first. */
  readonly createdAt: string | null;
  /** Ids already handled that share exactly `createdAt`. */
  readonly ids: readonly string[];
}

export interface BackfillTally {
  /** Records fetched and looked at, including ones nothing was written for. */
  readonly examined: number;
  /** `scoring-run` wrote a record and an audit row. */
  readonly scored: number;
  /** Guard 3 recognised the outcome; nothing was written. */
  readonly unchanged: number;
  /** `scoring-run` declined to score (unreadable event, authored write). */
  readonly skipped: number;
  /** `scoring-run` failed open: flagged UNSCORED, ERROR row appended. */
  readonly failed: number;
}

export const EMPTY_TALLY: BackfillTally = {
  examined: 0,
  scored: 0,
  unchanged: 0,
  skipped: 0,
  failed: 0,
};

export interface BackfillState {
  /** Bumped only for a shape change the reader below cannot absorb. */
  readonly version: 1;
  /** Derived from the start time, so it is unique without a random source. */
  readonly runId: string;
  readonly mode: BackfillMode;
  readonly status: BackfillStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  /** ISO 8601. Null when no tick holds the lease. */
  readonly leaseUntil: string | null;
  readonly cursor: BackfillCursor;
  /**
   * How many records matched the mode when the run started. Null when the count
   * query failed — a count is a nicety and must never stop a run beginning.
   */
  readonly totalAtStart: number | null;
  readonly tally: BackfillTally;
  /** Ticks that committed work. Distinguishes "slow" from "stuck". */
  readonly chunks: number;
  /** Consecutive ticks that fetched records and got through none. */
  readonly stalls: number;
  /** The most recent tick-level failure, kept so the panel can show it. */
  readonly lastError: string | null;
  /** Server-derived, or `'install'` for the automatic run. */
  readonly requestedBy: string;
}

/* -------------------------------------------------------------------------- */
/* Reading it back                                                             */
/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.length > 0 ? value : fallback;

const asNullableString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const asCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;

const asIdList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];

const STATUSES: readonly string[] = [
  'running',
  'completed',
  'cancelled',
  'failed',
];

/**
 * Coerce whatever came out of key-value storage into a state, or `null`.
 *
 * Deliberately lenient about every field except the two that decide behaviour —
 * `status` and `mode`. An unreadable counter is cosmetic and defaults to zero; an
 * unreadable *status* would let a corrupt blob keep a cron loop alive against a
 * cursor nobody can interpret, so anything it does not recognise is refused
 * outright and the run reads as "there is no backfill", which is the state an
 * admin can act on.
 *
 * Refusing rather than repairing is the right direction here specifically because
 * the recovery is cheap and visible: the panel shows no run, and starting a fresh
 * one costs one click and re-walks records that are almost all already scored —
 * which guard 3 makes nearly free.
 */
export const toBackfillState = (value: unknown): BackfillState | null => {
  if (!isRecord(value)) {
    return null;
  }

  const status = value['status'];
  const mode = value['mode'];

  if (typeof status !== 'string' || !STATUSES.includes(status)) {
    return null;
  }

  if (!isBackfillMode(mode)) {
    return null;
  }

  const startedAt = asString(value['startedAt'], '');

  if (startedAt === '') {
    return null;
  }

  const cursor = isRecord(value['cursor']) ? value['cursor'] : {};
  const tally = isRecord(value['tally']) ? value['tally'] : {};

  return {
    version: 1,
    runId: asString(value['runId'], startedAt),
    mode,
    status: status as BackfillStatus,
    startedAt,
    updatedAt: asString(value['updatedAt'], startedAt),
    finishedAt: asNullableString(value['finishedAt']),
    leaseUntil: asNullableString(value['leaseUntil']),
    cursor: {
      createdAt: asNullableString(cursor['createdAt']),
      ids: asIdList(cursor['ids']),
    },
    totalAtStart:
      typeof value['totalAtStart'] === 'number' &&
      Number.isFinite(value['totalAtStart'])
        ? Math.floor(value['totalAtStart'])
        : null,
    tally: {
      examined: asCount(tally['examined']),
      scored: asCount(tally['scored']),
      unchanged: asCount(tally['unchanged']),
      skipped: asCount(tally['skipped']),
      failed: asCount(tally['failed']),
    },
    chunks: asCount(value['chunks']),
    stalls: asCount(value['stalls']),
    lastError: asNullableString(value['lastError']),
    requestedBy: asString(value['requestedBy'], 'unknown'),
  };
};

/* -------------------------------------------------------------------------- */
/* Transitions                                                                 */
/* -------------------------------------------------------------------------- */

export interface BeginBackfillInput {
  readonly mode: BackfillMode;
  readonly now: Date;
  readonly requestedBy: string;
  readonly totalAtStart: number | null;
}

/**
 * The run id is derived from the start instant rather than drawn from a random
 * source, so this module stays pure and a test can assert the exact id. Two runs
 * cannot start in the same millisecond — `beginBackfill` is only reachable from
 * the control route, which refuses while a run is `running`.
 */
export const beginBackfill = ({
  mode,
  now,
  requestedBy,
  totalAtStart,
}: BeginBackfillInput): BackfillState => {
  const startedAt = now.toISOString();

  return {
    version: 1,
    runId: `backfill-${startedAt}`,
    mode,
    status: 'running',
    startedAt,
    updatedAt: startedAt,
    finishedAt: null,
    // Left unclaimed so the very next cron tick picks the run up rather than
    // waiting out a lease nobody is holding.
    leaseUntil: null,
    cursor: { createdAt: null, ids: [] },
    totalAtStart,
    tally: EMPTY_TALLY,
    chunks: 0,
    stalls: 0,
    lastError: null,
    requestedBy,
  };
};

export const isLeaseHeld = (state: BackfillState, now: Date): boolean => {
  if (state.leaseUntil === null) {
    return false;
  }

  const until = Date.parse(state.leaseUntil);

  // An unparseable lease is treated as expired. The alternative — treating it as
  // held — would strand the run permanently on one bad write, and the cost of
  // being wrong is one duplicated chunk that writes nothing.
  return !Number.isNaN(until) && until > now.getTime();
};

export const claimLease = (state: BackfillState, now: Date): BackfillState => ({
  ...state,
  updatedAt: now.toISOString(),
  leaseUntil: new Date(now.getTime() + BACKFILL_LEASE_MS).toISOString(),
});

/** Give the lease back without changing anything else. Used on a failed tick. */
export const releaseLease = (
  state: BackfillState,
  now: Date,
  lastError: string | null,
): BackfillState => ({
  ...state,
  updatedAt: now.toISOString(),
  leaseUntil: null,
  lastError,
});

const addTally = (left: BackfillTally, right: BackfillTally): BackfillTally => ({
  examined: left.examined + right.examined,
  scored: left.scored + right.scored,
  unchanged: left.unchanged + right.unchanged,
  skipped: left.skipped + right.skipped,
  failed: left.failed + right.failed,
});

export interface CommitChunkInput {
  readonly now: Date;
  readonly cursor: BackfillCursor;
  readonly tally: BackfillTally;
  readonly lastError: string | null;
  /** True when the page proved there is nothing left to walk. */
  readonly exhausted: boolean;
  /** True when records came back and the tick got through none of them. */
  readonly stalled: boolean;
}

const STALL_MESSAGE =
  'The backfill stopped making progress. More records share one creation timestamp than a single page can hold, so the walk cannot get past them. Run the backfill over unscored leads only — that mode drains regardless — or contact support.';

/**
 * Fold one tick's work into the run and release the lease.
 *
 * The cursor is replaced wholesale rather than merged: the caller has already
 * worked out where the walk actually reached, and it is the only party that can —
 * see `advanceCursor` in `backfill-plan.ts`.
 *
 * Three ways out of `running`, and it matters that they are distinguishable:
 * `exhausted` is the walk finishing, `stalled` past its limit is the walk being
 * unable to continue, and neither is a cancel. A run that quietly stayed
 * "running" while achieving nothing would be the same defect as an empty gate
 * queue over an unscored workspace — a surface that looks healthy and is not.
 */
export const commitChunk = (
  state: BackfillState,
  { now, cursor, tally, lastError, exhausted, stalled }: CommitChunkInput,
): BackfillState => {
  const at = now.toISOString();
  const stalls = stalled ? state.stalls + 1 : 0;
  const wedged = stalls >= BACKFILL_MAX_STALLS;

  return {
    ...state,
    status: exhausted ? 'completed' : wedged ? 'failed' : state.status,
    updatedAt: at,
    finishedAt: exhausted || wedged ? at : state.finishedAt,
    leaseUntil: null,
    cursor: {
      createdAt: cursor.createdAt,
      ids: cursor.ids.slice(-BACKFILL_MAX_CURSOR_IDS),
    },
    tally: addTally(state.tally, tally),
    chunks: state.chunks + 1,
    stalls,
    lastError: wedged ? STALL_MESSAGE : lastError,
  };
};

export const cancelBackfill = (
  state: BackfillState,
  now: Date,
  requestedBy: string,
): BackfillState => ({
  ...state,
  status: 'cancelled',
  updatedAt: now.toISOString(),
  finishedAt: now.toISOString(),
  // Released so a cancel taken while a tick is mid-flight does not leave a lease
  // behind on a run nobody will ever pick up again.
  leaseUntil: null,
  requestedBy,
});

/* -------------------------------------------------------------------------- */
/* What the admin is shown                                                     */
/* -------------------------------------------------------------------------- */

export interface BackfillProgress {
  readonly runId: string;
  readonly mode: BackfillMode;
  readonly status: BackfillStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  readonly totalAtStart: number | null;
  readonly examined: number;
  readonly scored: number;
  readonly unchanged: number;
  readonly skipped: number;
  readonly failed: number;
  readonly chunks: number;
  readonly lastError: string | null;
  readonly requestedBy: string;
  /** 0-100, or null when the total was never known. */
  readonly percent: number | null;
  /** Whole minutes, or null when there is nothing to estimate from. */
  readonly minutesRemaining: number | null;
  /** True when a tick is currently holding the lease. */
  readonly working: boolean;
}

/**
 * Render the state for a human.
 *
 * `percent` is capped at 100 and floored at 0 rather than reported raw. The total
 * is a snapshot taken when the run started, and records created *during* a run
 * are walked too, so the honest arithmetic can exceed the denominator. A progress
 * bar reading 114% is a bug report; the cap is not hiding anything the counters
 * beside it do not already state exactly.
 *
 * `minutesRemaining` is deliberately derived from the chunk *rate this run has
 * actually achieved* rather than from the nominal chunk size, so a workspace
 * whose ticks are being skipped is told the truth about how long it will take.
 */
export const describeBackfill = (
  state: BackfillState,
  now: Date,
): BackfillProgress => {
  const { tally, totalAtStart } = state;

  const percent =
    totalAtStart === null || totalAtStart <= 0
      ? null
      : Math.max(0, Math.min(100, Math.round((tally.examined / totalAtStart) * 100)));

  const elapsedMs = Math.max(
    0,
    Date.parse(state.updatedAt) - Date.parse(state.startedAt),
  );

  const remaining =
    totalAtStart === null ? null : Math.max(0, totalAtStart - tally.examined);

  const minutesRemaining =
    state.status !== 'running' ||
    remaining === null ||
    remaining === 0 ||
    tally.examined === 0 ||
    elapsedMs <= 0
      ? null
      : Math.ceil(remaining / (tally.examined / (elapsedMs / 60_000)));

  return {
    runId: state.runId,
    mode: state.mode,
    status: state.status,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    finishedAt: state.finishedAt,
    totalAtStart,
    examined: tally.examined,
    scored: tally.scored,
    unchanged: tally.unchanged,
    skipped: tally.skipped,
    failed: tally.failed,
    chunks: state.chunks,
    lastError: state.lastError,
    requestedBy: state.requestedBy,
    percent,
    minutesRemaining:
      minutesRemaining === null || !Number.isFinite(minutesRemaining)
        ? null
        : minutesRemaining,
    working: isLeaseHeld(state, now),
  };
};
