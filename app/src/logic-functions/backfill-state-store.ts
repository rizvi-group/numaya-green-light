import { kv } from 'twenty-sdk/logic-function';

import { BACKFILL_STATE_KEY } from 'src/constants/backfill-identifiers';
import type { BackfillStateStore } from 'src/logic-functions/backfill-run';

/**
 * The real backfill state store: Twenty's app key-value storage.
 *
 * Four lines in a file of its own, exactly like `release-marker-store.ts` and for
 * exactly the same reason: `kv` is only importable from
 * `twenty-sdk/logic-function`, and `backfill-run.ts` stays SDK-free so the whole
 * resume-after-crash story can be driven by a fake in unit tests. A backfill's
 * correctness is entirely about what happens across process boundaries, and a
 * test that cannot simulate a process boundary cannot test it.
 *
 * `scope: 'WORKSPACE'` is not a detail. Progress is per-workspace, and a read
 * under a different scope silently returns `null` — which this code reads as "no
 * backfill has ever run" and would answer by starting another one, forever.
 *
 * Neither method catches. The caller decides what an unreadable or unwritable
 * store means, and it decides differently for the two: a failed read is "there is
 * no run, do nothing this tick", while a failed *write* must abandon the tick
 * before it does any scoring, because work whose position cannot be recorded is
 * work that will be done again on every tick from now on.
 */
export const kvBackfillStateStore: BackfillStateStore = {
  read: () => kv.get<unknown>(BACKFILL_STATE_KEY, { scope: 'WORKSPACE' }),
  write: async (state) => {
    await kv.set(BACKFILL_STATE_KEY, state, { scope: 'WORKSPACE' });
  },
};
