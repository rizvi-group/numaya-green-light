import { kv } from 'twenty-sdk/logic-function';

import {
  type ReleaseMarker,
} from 'src/gate/release-decision';
import { type ReleaseMarkerStore } from 'src/logic-functions/scoring-run';

/**
 * The real release-marker store: Twenty's app key-value storage.
 *
 * This is the only place in the scoring path that imports the SDK, which is why
 * it is three lines in a file of its own rather than a helper inside
 * `scoring-run.ts` — that module stays SDK-free so the whole run can be driven
 * by a fake in unit tests.
 *
 * `scope: 'WORKSPACE'` is not a detail: `release-lead.logic-function.ts` writes
 * the marker under that scope, and a read under a different scope silently finds
 * nothing. The key itself comes from `releaseMarkerKey` in
 * `src/gate/release-decision.ts` so neither side re-derives the string.
 */
export const kvReleaseMarkerStore: ReleaseMarkerStore = {
  get: (key) => kv.get<ReleaseMarker>(key, { scope: 'WORKSPACE' }),
  delete: async (key) => {
    await kv.delete(key, { scope: 'WORKSPACE' });
  },
};
