/**
 * Resolving "which Twenty workspace is this" — the value Numaya stores as the
 * licence's `deviceFingerprint`.
 *
 * ## Why the workspace id is the fingerprint
 *
 * Greenlight's unit of installation is a workspace, not a machine: the app runs
 * inside the customer's Twenty instance, there is no hardware to fingerprint,
 * and a per-seat identifier would meter the wrong thing (the product plan sells
 * a per-workspace base fee, not seats). The workspace UUID is stable across
 * restarts, upgrades and reinstalls, which is exactly what makes `activate`
 * idempotent. `maxActivations: 1` then means "one workspace per licence".
 *
 * `deviceName` is the workspace display name — purely so Numaya's admin view
 * reads "Acme Corp" rather than a bare UUID when a customer calls about a slot.
 *
 * ## Why this lives on the metadata API
 *
 * `currentWorkspace` is a metadata-API query, not a core-API one, so this is the
 * only file in the app that instantiates `MetadataApiClient`. It is isolated
 * behind `WorkspaceIdentityPort` for the usual reason — the client reads its URL
 * and token from the process environment in its constructor, which no unit test
 * has — and for one more: this is the least-verified call in the licensing path,
 * and isolating it means a wrong guess costs a `null` rather than an exception.
 *
 * Returning `null` is a supported outcome throughout. `licence-run.ts` then
 * validates without a fingerprint and skips activation; the customer keeps their
 * entitlement and only the readable device name is lost.
 */

import { MetadataApiClient } from 'twenty-client-sdk/metadata';

import {
  describeError,
  logGreenlight,
} from 'src/logic-functions/greenlight-api';
import {
  type WorkspaceIdentity,
  type WorkspaceIdentityPort,
} from 'src/logic-functions/licence-run';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Tolerant to the point of paranoia, on purpose: the shape of this response is
 * the one thing in the licensing path that was never exercised against a live
 * instance, and the failure mode of getting it wrong must be "no fingerprint",
 * never "install hook throws".
 */
export const readWorkspaceIdentityFrom = (payload: unknown): WorkspaceIdentity | null => {
  if (!isRecord(payload)) {
    return null;
  }

  const workspace = payload['currentWorkspace'];

  if (!isRecord(workspace)) {
    return null;
  }

  const id = workspace['id'];

  if (typeof id !== 'string' || id.length === 0) {
    return null;
  }

  const displayName = workspace['displayName'];

  return {
    workspaceId: id,
    workspaceName:
      typeof displayName === 'string' && displayName.length > 0 ? displayName : null,
  };
};

export const metadataWorkspaceIdentity: WorkspaceIdentityPort = {
  read: async () => {
    try {
      const client = new MetadataApiClient();
      const response = (await client.query({
        currentWorkspace: { id: true, displayName: true },
      })) as unknown;

      const identity = readWorkspaceIdentityFrom(response);

      if (identity === null) {
        logGreenlight('licence_workspace_identity_unreadable', {
          note: 'currentWorkspace query returned an unexpected shape; validating without a device fingerprint',
        });
      }

      return identity;
    } catch (error) {
      logGreenlight('licence_workspace_identity_failed', {
        error: describeError(error),
      });

      return null;
    }
  },
};
