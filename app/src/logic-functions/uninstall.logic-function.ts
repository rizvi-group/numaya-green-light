import { CoreApiClient } from 'twenty-client-sdk/core';
import {
  defineUninstallLogicFunction,
  type UninstallPayload,
} from 'twenty-sdk/define';

import { UNINSTALL_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER } from 'src/constants/logic-function-identifiers';
import { runUninstall } from 'src/logic-functions/install-run';

/**
 * Uninstall hook — and an honest account of what it can and cannot do.
 *
 * ## What the payload actually gives us
 *
 * `UninstallPayload` is `{ version?: string }`. Nothing else. It does not
 * enumerate the objects the app created, the fields it grafted onto Person, or
 * the records it wrote. Any design that assumed "the hook is told what to clean
 * up" has to be rewritten around that, and this one is.
 *
 * ## What this hook CANNOT clean up
 *
 * * **`GreenlightConfig` and `GreenlightAuditLog` objects and their records.**
 *   They are app-owned metadata; the deletion migration that runs immediately
 *   after this hook removes them. The hook could delete the rows first, which
 *   would achieve nothing except spending an uninstall's patience on rows that
 *   are about to be dropped anyway.
 * * **The three fields on Person (`greenlightScore`, `greenlightDecision`,
 *   `greenlightTrace`) and their values.** Same reason: they are app-owned field
 *   metadata on a standard object, and they go with the app. Nulling them first
 *   would mean an unbounded write over every Person in the workspace — hundreds
 *   of thousands of rows in a large CRM — inside a best-effort hook that must
 *   never delay an uninstall.
 * * **Preserving the audit trail past uninstall.** There is nowhere to put it.
 *   The hook can read the rows but has no destination that survives the app;
 *   exporting them to an external service would be a data-egress channel the DPA
 *   does not declare. A workspace that wants the trail must export it *before*
 *   uninstalling.
 * * **Listeners / trigger registrations.** Owned by the platform, removed with
 *   the app manifest.
 *
 * ## What this hook CAN do, and does
 *
 * * Emit one structured log line recording the version being removed and how
 *   much configuration was in place, so the server log retains a marker after
 *   every trace of the app is gone.
 * * Fail silently. It is documented as best-effort — "a failure is logged and
 *   never blocks the uninstall" — and this implementation never throws, so it
 *   cannot make the app hard to remove.
 *
 * ## Why ship it at all, then
 *
 * Two reasons, both about the future rather than v0.1. First, the
 * `universalIdentifier` is permanent, and minting it now means the hook can gain
 * behaviour in a later release without a new registration. Second, this is the
 * only place external deprovisioning can ever live: when licensing lands, the
 * licence must be *deactivated* here (freeing the customer's activation slot)
 * while the workspace id is still readable. That work cannot be moved to an
 * external scheduled job, because after uninstall there is no app data left to
 * tell the job which licence to release.
 *
 * ## ARCHITECTURE.md is wrong about this
 *
 * Its "Upgrade & Uninstall" section lists "Delete GreenlightConfig +
 * GreenlightAuditLog objects", "Remove score/gate fields from Lead object" and
 * "Unregister listeners" as uninstall steps. All three are the platform's work,
 * not the app's, and none of them is expressible from a hook holding only a
 * version string. Its final bullet — "Keep audit trail (Twenty CRM's
 * deleted-object backups retain it)" — is an unverified claim about Twenty's
 * retention behaviour and should not be repeated in a security or DPA document.
 */
const handler = async (payload: UninstallPayload) =>
  runUninstall({
    client: new CoreApiClient(),
    payload,
  });

export default defineUninstallLogicFunction({
  universalIdentifier: UNINSTALL_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
  name: 'greenlight-uninstall',
  description:
    'Records the uninstall in the server log. Greenlight v0.1 provisions no external resources, so there is nothing else to deprovision.',
  // 30s, well under the 300s default. This hook runs synchronously inside the
  // uninstall flow and does one read; anything longer would only extend how long
  // a user waits to remove an app that is already on its way out.
  timeoutSeconds: 30,
  handler,
});
