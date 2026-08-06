/**
 * Resolving "which human is making this request" — once per run, and never from
 * anything the caller sent.
 *
 * The wording of the answer lives in `src/identity/actor.ts`, which is pure.
 * This file is the I/O half: one metadata query, one cache, and a promise that
 * every failure ends in a string rather than an exception.
 *
 * ## Why `currentUser`, and why no new permission
 *
 * The obvious way to turn an id into a name is to read the workspace-member
 * directory, and it is the wrong one. `default-role.ts` records that argument in
 * full under "grants that were argued down"; the short version is that reading
 * every member of a customer's workspace to put one name on one row is the same
 * bad trade the `calendarEvent` grant was refused for.
 *
 * `currentUser` on the **metadata** API is the narrow alternative. It is not an
 * object query and it is not covered by `objectPermissions` at all: it returns
 * the identity of whoever authenticated the call and nothing else, so it cannot
 * be pointed at another member, cannot enumerate the directory, and needs no
 * grant on `workspaceMember`. Greenlight already reaches the metadata API for
 * exactly one other thing — `currentWorkspace` in `licence-workspace-identity.ts`
 * — and this is the second and last.
 *
 * That it works from inside a logic function was proved against a live instance
 * rather than assumed, which is what the previous attempt at this feature did
 * not do: the note it left behind said the lookup's "API shape is not documented
 * for app-scoped tokens", concluded the risk was not worth taking, and shipped a
 * UUID for two release cycles. The probe answered in one deploy. The request
 * carries the caller's own context, `currentUser.currentUserWorkspace.id` comes
 * back equal to `event.userWorkspaceId`, and `workspaceMember` on it is the same
 * record Twenty stamps into `createdBy.workspaceMemberId` on the audit row it
 * writes. An undocumented surface is a reason to verify, not a reason to guess.
 *
 * ## One lookup per run, not one per row
 *
 * A backfill writes thousands of audit rows and the ICP apply writes one per
 * decision; a lookup on each of them would turn a name into a rate limit. It
 * cannot happen by construction — each `define*` shell resolves the actor once,
 * before any work starts, and passes the resulting string down — but the cache
 * below makes it structurally impossible rather than merely conventional, and it
 * also collapses the burst of `status` polls the backfill and ICP panels make
 * while a run is in flight.
 *
 * The cache is keyed on `userWorkspaceId` because two different people using the
 * same warm container must not share an answer, and it stores only *successful*
 * resolutions: a transient metadata failure has to be retryable on the next
 * request rather than pinned into the container for its lifetime. Its staleness
 * window is the life of one function container — minutes — against a workspace
 * member renaming themselves, which is rare and whose worst outcome is one row
 * carrying the name that person had a few minutes earlier. An audit log records
 * what was true at the time; that is the correct trade in the direction it is
 * already made.
 *
 * ## Every failure is a string
 *
 * `resolveActorDisplayName` never throws and never returns an empty actor. A
 * metadata outage, a schema drift, an unauthenticated request, a runtime whose
 * `currentUser` disagrees with the request's own `userWorkspaceId` — all of them
 * land on the id-bearing string this app wrote before names existed. Losing the
 * name costs readability. Losing the row costs the evidence.
 */

import { MetadataApiClient } from 'twenty-client-sdk/metadata';

import {
  formatActor,
  readActorIdentityFrom,
  type ActorIdentity,
} from 'src/identity/actor';
import {
  describeError,
  logGreenlight,
} from 'src/logic-functions/greenlight-api';

/**
 * The lookup, isolated for the usual reason: `MetadataApiClient` reads its URL
 * and token from the process environment in its constructor, which no unit test
 * has. Same shape and same motivation as `WorkspaceIdentityPort`.
 */
export interface ActorIdentityPort {
  read: (userWorkspaceId: string) => Promise<ActorIdentity | null>;
}

export const metadataActorIdentity: ActorIdentityPort = {
  read: async (userWorkspaceId) => {
    try {
      const client = new MetadataApiClient();
      const response = (await client.query({
        currentUser: {
          // Asked for so `readActorIdentityFrom` can refuse an identity that is
          // not this request's. See the security note on that function.
          currentUserWorkspace: { id: true },
          workspaceMember: {
            id: true,
            name: { firstName: true, lastName: true },
            userEmail: true,
          },
        },
      })) as unknown;

      const identity = readActorIdentityFrom(response, userWorkspaceId);

      if (identity === null) {
        logGreenlight('actor_identity_unresolved', {
          note: 'currentUser did not return a named workspace member for this request; the audit row will carry the id instead',
        });
      }

      return identity;
    } catch (error) {
      logGreenlight('actor_identity_failed', { error: describeError(error) });

      return null;
    }
  },
};

/**
 * Successful resolutions only, keyed by the id the platform put on the request.
 *
 * Module scope, so it lives exactly as long as the function container does.
 * Nothing invalidates it and nothing needs to: see the staleness argument in the
 * file header.
 */
const resolved = new Map<string, string>();

/** Exposed for tests, which must not inherit a name from the case before. */
export const clearActorCache = (): void => {
  resolved.clear();
};

/**
 * The actor for this request, as it will appear on every row the request writes.
 *
 * Takes the whole event rather than the id so that no caller can pass one it
 * assembled itself. `userWorkspaceId` is the only server-derived identity on a
 * `RoutePayload`, and keeping the read of it inside this function is what makes
 * "the actor never comes from the request body" a property of the code rather
 * than of six shells all remembering the same rule.
 */
export const resolveActorDisplayName = async (
  event: { readonly userWorkspaceId?: string | null },
  port: ActorIdentityPort = metadataActorIdentity,
): Promise<string> => {
  const userWorkspaceId = event.userWorkspaceId ?? null;

  if (userWorkspaceId === null || userWorkspaceId === '') {
    return formatActor(null, userWorkspaceId);
  }

  const cached = resolved.get(userWorkspaceId);

  if (cached !== undefined) {
    return cached;
  }

  // The supplied port already swallows its own failures. Catching here as well
  // is not belt-and-braces for its own sake: this function's contract is that it
  // returns a string, and a contract that holds only while every implementation
  // of a pluggable port remembers to be quiet is not a contract.
  const identity = await port
    .read(userWorkspaceId)
    .catch((error: unknown): null => {
      logGreenlight('actor_identity_failed', { error: describeError(error) });

      return null;
    });

  const actor = formatActor(identity, userWorkspaceId);

  if (identity !== null) {
    resolved.set(userWorkspaceId, actor);
  }

  return actor;
};
