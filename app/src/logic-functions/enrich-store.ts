/**
 * The real enrichment store: Twenty's app key-value storage.
 *
 * Same shape and the same reasoning as `licence-cache-store.ts` and
 * `backfill-state-store.ts` — this is the only enrichment module that imports
 * `kv`, which is what lets `enrich-run.ts` and the whole of `src/enrichment/` be
 * driven by a fake in unit tests.
 *
 * `scope: 'WORKSPACE'` throughout, and here it *is* the spend cap. A counter
 * read under a different scope silently returns `null`, which reads as "nothing
 * spent this month" — a per-tenant cap that quietly became no cap at all, with
 * every line of the code that enforces it still looking correct.
 *
 * ## Reads are tolerant, writes are best-effort — with one exception
 *
 * Every read validates the fields it depends on and degrades to a safe default,
 * because an upgrade can leave a shape this version has never seen and a
 * `TypeError` inside an event handler is worse than a cache miss.
 *
 * The exception is `writeBudget`. It swallows its error like the rest, but the
 * *caller* treats the spend as having happened regardless, and that asymmetry is
 * deliberate: retrying because the counter did not move is how a cap gets blown
 * through. Losing the record of one run is cheaper than losing the cap.
 */

import { kv } from 'twenty-sdk/logic-function';

import {
  ENRICHMENT_BREAKER_KV_KEY,
  ENRICHMENT_BUDGET_KV_KEY,
  ENRICHMENT_TWENTY_AI_KV_KEY,
} from 'src/constants/enrichment-identifiers';
import {
  toBreakerStates,
  type EnrichmentBudgetState,
  type EnrichmentStorePort,
  type TwentyAiAvailability,
  type TwentyAiProbe,
} from 'src/enrichment';
import {
  describeError,
  logGreenlight,
} from 'src/logic-functions/greenlight-api';

const SCOPE = { scope: 'WORKSPACE' } as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readBudgetState = (value: unknown): EnrichmentBudgetState | null => {
  if (!isRecord(value)) {
    return null;
  }

  const { monthKey, used } = value;

  // Without a month key the counter cannot be rolled over, and a counter that
  // never rolls over is a workspace whose enrichment stops permanently the first
  // month it hits the cap. Treating that as "no state" costs one month's
  // history and restores the feature.
  if (typeof monthKey !== 'string' || typeof used !== 'number') {
    return null;
  }

  return {
    monthKey,
    used,
    alertedAt:
      typeof value['alertedAt'] === 'number' ? value['alertedAt'] : 0,
  };
};

const readProbe = (value: unknown): TwentyAiProbe => {
  if (!isRecord(value)) {
    return { availability: 'unknown', checkedAt: null, detail: null };
  }

  const availability = value['availability'];

  return {
    availability: isAvailability(availability) ? availability : 'unknown',
    checkedAt: typeof value['checkedAt'] === 'string' ? value['checkedAt'] : null,
    detail: typeof value['detail'] === 'string' ? value['detail'] : null,
  };
};

const isAvailability = (value: unknown): value is TwentyAiAvailability =>
  value === 'unknown' || value === 'available' || value === 'unavailable';

export const kvEnrichmentStore: EnrichmentStorePort = {
  readBudget: async () => {
    try {
      return readBudgetState(
        await kv.get<unknown>(ENRICHMENT_BUDGET_KV_KEY, SCOPE),
      );
    } catch (error) {
      logGreenlight('enrichment_budget_read_failed', {
        error: describeError(error),
      });

      return null;
    }
  },

  writeBudget: async (state) => {
    try {
      await kv.set(ENRICHMENT_BUDGET_KV_KEY, state, SCOPE);
    } catch (error) {
      logGreenlight('enrichment_budget_write_failed', {
        error: describeError(error),
      });
    }
  },

  readBreakers: async () => {
    try {
      return toBreakerStates(
        await kv.get<unknown>(ENRICHMENT_BREAKER_KV_KEY, SCOPE),
      );
    } catch (error) {
      logGreenlight('enrichment_breaker_read_failed', {
        error: describeError(error),
      });

      return {};
    }
  },

  writeBreakers: async (states) => {
    try {
      await kv.set(ENRICHMENT_BREAKER_KV_KEY, states, SCOPE);
    } catch (error) {
      logGreenlight('enrichment_breaker_write_failed', {
        error: describeError(error),
      });
    }
  },

  readTwentyAiProbe: async () => {
    try {
      return readProbe(await kv.get<unknown>(ENRICHMENT_TWENTY_AI_KV_KEY, SCOPE));
    } catch (error) {
      logGreenlight('enrichment_twenty_ai_probe_read_failed', {
        error: describeError(error),
      });

      return { availability: 'unknown', checkedAt: null, detail: null };
    }
  },

  writeTwentyAiProbe: async (probe) => {
    try {
      await kv.set(ENRICHMENT_TWENTY_AI_KV_KEY, probe, SCOPE);
    } catch (error) {
      logGreenlight('enrichment_twenty_ai_probe_write_failed', {
        error: describeError(error),
      });
    }
  },
};

/**
 * Read the monthly counter for the admin panel.
 *
 * Deliberately not on `EnrichmentStorePort`: the port is the *writer's*
 * interface, and a read-only surface has no business being handed something it
 * could increment. Same argument as `readPublishedLicenceState`.
 */
export const readEnrichmentBudget = async (): Promise<EnrichmentBudgetState | null> => {
  try {
    return readBudgetState(await kv.get<unknown>(ENRICHMENT_BUDGET_KV_KEY, SCOPE));
  } catch (error) {
    logGreenlight('enrichment_budget_read_failed', { error: describeError(error) });

    return null;
  }
};
