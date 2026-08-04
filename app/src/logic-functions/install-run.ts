/**
 * Install-lifecycle behaviour, separated from the `define*` wrappers so it can
 * be driven by a fake API client in unit tests.
 *
 * Twenty runs the post-install hook on a fresh install and — because this app
 * sets `shouldRunOnVersionUpgrade: true` — on every upgrade, asynchronously,
 * with up to three retries. Both facts make idempotency mandatory rather than
 * merely tidy: a retried run must create nothing new, and an upgrade must not
 * flatten a workspace's tuning back to shipped defaults.
 */

import {
  describeError,
  logGreenlight,
  oldestByCreatedAt,
  readConnectionNodes,
  type GreenlightApiClient,
} from 'src/logic-functions/greenlight-api';
import {
  buildConfigUpgradePatch,
  buildGreenlightConfigSeed,
  greenlightConfigSelection,
} from 'src/logic-functions/greenlight-config-record';
import { SCORING_ENGINE_VERSION } from 'src/scoring';

export interface InstallRunInput {
  readonly client: GreenlightApiClient;
  readonly payload: { previousVersion?: string; newVersion?: string };
}

export type PostInstallOutcome =
  | { status: 'seeded'; configId: string | null }
  | { status: 'already_seeded'; configCount: number }
  | { status: 'up_to_date'; configId: string | null }
  | { status: 'merged'; configId: string | null; mergedKeys: string[] };

const loadConfigRecords = async (
  client: GreenlightApiClient,
): Promise<Record<string, unknown>[]> => {
  const response = await client.query({
    greenlightConfigs: { edges: { node: greenlightConfigSelection() } },
  });

  return readConnectionNodes(response, 'greenlightConfigs');
};

const readCreatedId = (response: unknown, mutationName: string): string | null => {
  if (typeof response !== 'object' || response === null) {
    return null;
  }

  const created = (response as Record<string, unknown>)[mutationName];

  if (typeof created !== 'object' || created === null) {
    return null;
  }

  const id = (created as Record<string, unknown>)['id'];

  return typeof id === 'string' ? id : null;
};

/**
 * Best-effort provenance row. Not worth failing an install over, so every
 * failure is swallowed after being logged — but genuinely worth having, because
 * "when was this workspace seeded, and from which version" is the first question
 * every support conversation about a mis-scored lead starts with.
 */
const writeConfigAuditRow = async (
  client: GreenlightApiClient,
  summary: string,
  detail: Record<string, unknown>,
): Promise<void> => {
  try {
    await client.mutation({
      createGreenlightAuditLog: {
        __args: {
          data: {
            name: summary,
            eventType: 'CONFIG_CHANGED',
            occurredAt: new Date().toISOString(),
            leadObjectNameSingular: '',
            leadDisplayName: '',
            actorType: 'SYSTEM',
            actorDisplayName: `Greenlight engine ${SCORING_ENGINE_VERSION}`,
            ruleTrace: detail,
            score: null,
            band: 'UNSCORED',
            decision: 'UNSCORED',
            overrideReason: '',
            traceId: '',
          },
        },
        id: true,
      },
    });
  } catch (error) {
    logGreenlight('install_audit_write_failed', { error: describeError(error) });
  }
};

/**
 * Seed on a fresh install; merge newly-shipped keys on an upgrade.
 *
 * ## Idempotency
 *
 * The only creation happens when the workspace has **zero** config records. A
 * retry of a run whose create already succeeded sees one record and takes the
 * "already seeded" branch. There is no unique constraint available on a Twenty
 * object, so a create whose response was lost in flight could in principle
 * produce a second record on retry; that duplicate is inert, because every
 * reader in this app resolves the config by `oldestByCreatedAt`, and the
 * upgrade path patches that same oldest record. Duplicate-tolerant beats
 * duplicate-impossible when the platform offers no way to be the latter.
 *
 * ## Upgrade
 *
 * `previousVersion` is `undefined` on a fresh install and set on an upgrade —
 * this is the branch the ARCHITECTURE doc asks for. On an upgrade the seed is
 * never written wholesale; `buildConfigUpgradePatch` returns only the keys the
 * record is genuinely missing plus any rules the new release added, so a
 * workspace's thresholds, ICP and per-rule severities survive untouched. An
 * upgrade that adds nothing produces no mutation at all.
 *
 * ## Errors
 *
 * Deliberately **not** caught. Post-install runs async with three retries, so a
 * transient API failure should propagate and be retried by the platform —
 * swallowing it would turn a recoverable blip into a permanently unseeded
 * workspace. This is safe precisely because the run is idempotent. Nothing here
 * touches lead data, so a failed seed degrades to "the engine scores with its
 * built-in defaults", which is the documented fall-back anyway.
 */
export const runPostInstall = async ({
  client,
  payload,
}: InstallRunInput): Promise<PostInstallOutcome> => {
  const existing = await loadConfigRecords(client);

  if (existing.length === 0) {
    const seed = buildGreenlightConfigSeed();

    const response = await client.mutation({
      createGreenlightConfig: { __args: { data: seed }, id: true },
    });

    const configId = readCreatedId(response, 'createGreenlightConfig');

    logGreenlight('config_seeded', {
      configId,
      newVersion: payload.newVersion ?? null,
    });

    await writeConfigAuditRow(
      client,
      `CONFIG_CHANGED · Greenlight configuration seeded · ${payload.newVersion ?? 'unknown version'}`,
      {
        action: 'seeded',
        newVersion: payload.newVersion ?? null,
        engineVersion: SCORING_ENGINE_VERSION,
        ruleCount: Object.keys(
          (seed['ruleSettings'] as Record<string, unknown>) ?? {},
        ).length,
      },
    );

    return { status: 'seeded', configId };
  }

  const target = oldestByCreatedAt(existing);
  const configId =
    target !== null && typeof target['id'] === 'string' ? target['id'] : null;

  if (payload.previousVersion === undefined) {
    // Fresh install, but a record already exists: this is a retry of a run whose
    // create landed. Do nothing at all — in particular, do not "top up" missing
    // keys, because on a fresh install there are none to top up and any
    // difference is something the admin did in the window since.
    logGreenlight('config_seed_skipped', {
      configCount: existing.length,
      reason: 'config_already_present',
    });

    return { status: 'already_seeded', configCount: existing.length };
  }

  const patch = buildConfigUpgradePatch(target);
  const mergedKeys = Object.keys(patch);

  if (mergedKeys.length === 0 || configId === null) {
    logGreenlight('config_upgrade_noop', {
      configId,
      previousVersion: payload.previousVersion,
      newVersion: payload.newVersion ?? null,
    });

    return { status: 'up_to_date', configId };
  }

  await client.mutation({
    updateGreenlightConfig: { __args: { id: configId, data: patch }, id: true },
  });

  logGreenlight('config_upgraded', {
    configId,
    previousVersion: payload.previousVersion,
    newVersion: payload.newVersion ?? null,
    mergedKeys,
  });

  await writeConfigAuditRow(
    client,
    `CONFIG_CHANGED · Greenlight configuration merged on upgrade · ${payload.newVersion ?? 'unknown version'}`,
    {
      action: 'merged',
      previousVersion: payload.previousVersion,
      newVersion: payload.newVersion ?? null,
      mergedKeys,
    },
  );

  return { status: 'merged', configId, mergedKeys };
};

/* -------------------------------------------------------------------------- */
/* Uninstall                                                                   */
/* -------------------------------------------------------------------------- */

export interface UninstallRunOutcome {
  readonly version: string | null;
  readonly configRecordsObserved: number;
  readonly cleanupPerformed: 'none';
}

/**
 * Record what is about to disappear. That is genuinely all this hook can do —
 * see `uninstall.logic-function.ts` for the full argument.
 *
 * Never throws: a cleanup hook that can fail an uninstall makes an app
 * impossible to remove, and the platform documents the hook as best-effort for
 * exactly that reason.
 */
export const runUninstall = async ({
  client,
  payload,
}: {
  client: GreenlightApiClient;
  payload: { version?: string };
}): Promise<UninstallRunOutcome> => {
  let configRecordsObserved = 0;

  try {
    configRecordsObserved = (await loadConfigRecords(client)).length;
  } catch (error) {
    logGreenlight('uninstall_inventory_failed', {
      error: describeError(error),
    });
  }

  logGreenlight('uninstalled', {
    version: payload.version ?? null,
    engineVersion: SCORING_ENGINE_VERSION,
    configRecordsObserved,
    // Stated explicitly so the log is self-documenting a year from now.
    note: 'Greenlight v0.1 provisions no external resources; the platform removes all app-owned metadata and records.',
  });

  return {
    version: payload.version ?? null,
    configRecordsObserved,
    cleanupPerformed: 'none',
  };
};
