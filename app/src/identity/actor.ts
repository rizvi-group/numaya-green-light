/**
 * Numaya Greenlight — who a row in the audit log is about.
 *
 * Everything in this file is pure: no SDK import, no network, no clock read.
 * The lookup that produces the raw identity lives in
 * `src/logic-functions/actor-identity.ts`; this file decides what the identity
 * *reads* as, which is the part that has to be exhaustively testable without a
 * live workspace — for the same reason `src/gate/release-decision.ts` is pure.
 * The override row is the GDPR Art. 22 evidence that a named human overruled an
 * automated decision, and "named" is a property of the string this file builds.
 *
 * ## The mistake this corrects
 *
 * Every human-triggered action in this app used to write its actor as
 *
 *     Workspace member 20202020-9e3b-46d4-a556-88b9ddc2b035
 *
 * built in six separate `define*` shells from `event.userWorkspaceId`. The
 * reasoning recorded at the time — in `release-lead.logic-function.ts` — was that
 * resolving a friendly name "needs a workspace-member lookup whose API shape is
 * not documented for app-scoped tokens, and a wrong guess here would break every
 * override". The caution was right; the conclusion was not, and it survived two
 * rounds of demo recording because a UUID *looks* like a working audit trail.
 *
 * It is not one. The audit log exists to answer "who did this, and why" months
 * later, usually to somebody outside the sales team — a DPO, an auditor, a
 * customer asking why they were contacted. A UUID answers neither half. Worse,
 * the id in that string is not even the identifier a Twenty admin can look
 * up: `userWorkspaceId` is the id of the **user-workspace membership row**, not
 * of the workspace member, so the label was wrong as well as unreadable.
 *
 * ## What replaced it
 *
 *     Priya Raman (workspace member 3f2c1b6e-…)
 *
 * Both halves are load-bearing and neither is decoration:
 *
 *   - **The name** is what a human reads. It is the whole point of the change.
 *   - **The id** is what survives the name. "Priya Raman" is ambiguous across two
 *     employees with the same name, and across a member who has since left and
 *     been removed from the directory — at which point the name is all that is
 *     left of them and it no longer resolves to anybody. The workspace-member id
 *     is the durable account key, it is the same identifier Twenty stamps into
 *     its own `createdBy.workspaceMemberId` on the row, and it is deliberately
 *     not abbreviated: a truncated UUID in an audit trail is a UUID that cannot
 *     be pasted into a search box.
 *
 * ## Failing soft, on purpose
 *
 * `formatActor` takes `null` and answers with the *old* id-bearing string rather
 * than an empty actor or a thrown error. An audit row that names an id is poor.
 * An audit row that does not exist, because the name lookup failed and took the
 * write with it, is the thing this app promises never to produce — the same
 * fail-open reasoning `licence-workspace-identity.ts` applies to the workspace
 * fingerprint, and `release-lead.logic-function.ts` to the release marker.
 */

/**
 * A workspace member, reduced to the two things an audit row needs.
 *
 * `displayName` is already resolved to a non-empty string by the time it gets
 * here — see `readActorIdentityFrom`, which refuses to build an identity it
 * cannot name. That keeps `formatActor` free of a "what if the name is blank"
 * branch, which is the branch that would otherwise quietly emit
 * `" (workspace member 3f2c…)"` with a hole at the front of it.
 */
export interface ActorIdentity {
  readonly workspaceMemberId: string;
  readonly displayName: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

/**
 * "Priya Raman" from Twenty's `FullName` composite, or the address if the
 * directory has no name on the member.
 *
 * A workspace member created by invitation carries an email long before anybody
 * fills in a first and last name, so an address is a real and common state
 * rather than a defensive branch — and `priya@northwind.example` in an audit row
 * is still a person, where a blank is not. Joining with a filter rather than a
 * template keeps "Priya" (no surname recorded) reading as `Priya` and not as
 * `Priya ` with a trailing space that no reader can see and every string
 * comparison can.
 */
const nameFrom = (member: Record<string, unknown>): string => {
  const name = member['name'];
  const parts = isRecord(name)
    ? [readString(name['firstName']), readString(name['lastName'])]
    : [];
  const joined = parts.filter((part) => part !== '').join(' ');

  return joined !== '' ? joined : readString(member['userEmail']);
};

/**
 * The `currentUser` response, narrowed — and checked against the request that
 * asked for it.
 *
 * The check is the security property, not a nicety. The actor on an audit row
 * must be the human the platform authenticated, never a value the caller
 * supplied and never an ambient identity the runtime happened to have lying
 * around. `event.userWorkspaceId` is the server-derived half of that guarantee,
 * and this function will not return an identity unless the directory agrees:
 * `currentUser.currentUserWorkspace.id` has to equal the `userWorkspaceId` the
 * platform put on this request. If the two ever disagree — a pooled client, a
 * cached token, a future runtime that resolves `currentUser` from something
 * other than the caller — the answer is `null` and the row falls back to the id
 * that *is* known to belong to this request. Naming the wrong person in an audit
 * log is a worse failure than naming nobody, and it is a failure that would
 * never be noticed.
 *
 * Everything else here is shape-tolerance of the kind `readConnectionNodes` and
 * `readWorkspaceIdentityFrom` already apply: a schema drift degrades to "no
 * name", never to an exception.
 */
export const readActorIdentityFrom = (
  payload: unknown,
  userWorkspaceId: string,
): ActorIdentity | null => {
  if (!isRecord(payload)) {
    return null;
  }

  const currentUser = payload['currentUser'];

  if (!isRecord(currentUser)) {
    return null;
  }

  const userWorkspace = currentUser['currentUserWorkspace'];

  if (
    !isRecord(userWorkspace) ||
    readString(userWorkspace['id']) !== userWorkspaceId ||
    userWorkspaceId === ''
  ) {
    return null;
  }

  const member = currentUser['workspaceMember'];

  if (!isRecord(member)) {
    return null;
  }

  const workspaceMemberId = readString(member['id']);
  const displayName = nameFrom(member);

  return workspaceMemberId === '' || displayName === ''
    ? null
    : { workspaceMemberId, displayName };
};

/**
 * The one string every audit row, release marker and backfill record puts in
 * `actorDisplayName`.
 *
 * Three outcomes, and the two unhappy ones are byte-for-byte what this app wrote
 * before the name lookup existed. That is deliberate: the fallback is not a new
 * failure mode to be discovered in production, it is the state the product
 * shipped in, so the worst a broken lookup can do is put the audit trail back
 * where it already was.
 */
export const formatActor = (
  identity: ActorIdentity | null,
  userWorkspaceId: string | null | undefined,
): string => {
  if (identity !== null) {
    return `${identity.displayName} (workspace member ${identity.workspaceMemberId})`;
  }

  return userWorkspaceId === null ||
    userWorkspaceId === undefined ||
    userWorkspaceId === ''
    ? 'Unidentified workspace member'
    : `Workspace member ${userWorkspaceId}`;
};
