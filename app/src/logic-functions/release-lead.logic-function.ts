import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';
import { kv, Response, type RoutePayload } from 'twenty-sdk/logic-function';

import {
  RELEASE_LEAD_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
  RELEASE_LEAD_ROUTE_PATH,
} from 'src/constants/gate-queue-identifiers';
import {
  auditBandValue,
  auditDecisionValue,
  buildAuditSummary,
  DECISION_PASS,
  decideRelease,
  parseReleaseRequest,
  releaseMarkerKey,
  type CurrentLeadState,
  type ReleaseMarker,
  type ReleaseRequest,
} from 'src/gate/release-decision';
import { resolveActorDisplayName } from 'src/logic-functions/actor-identity';

/**
 * Path 4 of ARCHITECTURE.md — the human override that releases a held lead.
 *
 * This function is deliberately a shell. Every rule about what may be released
 * lives in `src/gate/release-decision.ts`, which is pure and exhaustively unit
 * tested; everything here is I/O and error handling. If you are looking for the
 * compliance-block refusal, the mandatory-reason policy, or the double-release
 * guard, they are all in that module.
 *
 * ## What it writes
 *
 * 1. `Person.greenlightDecision = 'PASS'` — clears the gate, nothing else.
 * 2. One `GreenlightAuditLog` row: who, when, and the reason.
 * 3. A release marker in app key-value storage, for the scoring function.
 *
 * It deliberately does **not** write the workspace's own "ready for outreach"
 * stage field, even though ARCHITECTURE.md Path 4 step 1 mentions moving the
 * lead there. Two reasons: that field is a Layer 3 mapping onto the customer's
 * own schema, so writing it is a much larger blast radius than clearing our own
 * flag; and it is a scoring *input* field, so writing it would re-trigger the
 * scoring run this override is trying not to provoke. Clearing the gate is the
 * part Greenlight owns.
 *
 * ## The contract with the scoring function
 *
 * The scoring function is owned by another workstream and fires on Person
 * create/update. This function writes to Person. Without a contract, the write
 * below re-triggers scoring, the score is unchanged, and the lead is instantly
 * re-gated — an override that silently undoes itself.
 *
 * Two things must hold, and only the second is in this file's power:
 *
 *   **(A) The scoring trigger must ignore Greenlight's own fields.** Its
 *   `databaseEventTriggerSettings` for `person.updated` must declare
 *   `updatedFields`, and that list must contain only scoring *inputs* (`name`,
 *   `jobTitle`, `emails`, `phones`, `city`, `companyId`, …). It must NOT contain
 *   `greenlightScore`, `greenlightDecision` or `greenlightTrace`. With that in
 *   place, the write below does not wake the scorer at all. This is the primary
 *   fix and it belongs on the scoring side.
 *
 *   **(B) The scoring function must not downgrade a released lead.** Even with
 *   (A), a rep editing `jobTitle` seconds after a release triggers a legitimate
 *   re-score that would re-gate the lead. Before writing a `GATE` decision, the
 *   scoring function should read
 *   `kv.get<ReleaseMarker>(releaseMarkerKey('person', recordId))`; if a marker
 *   is present it may update the score and the trace, but must leave
 *   `greenlightDecision` at `PASS`. The one case where the marker loses is a
 *   *newly* blocking compliance failure — a later opt-out outranks an earlier
 *   human release, and the scoring function should delete the marker then.
 *
 * Both the key builder and the marker type are exported from
 * `src/gate/release-decision.ts` so the scoring side imports them rather than
 * re-deriving the string.
 *
 * Both halves are now in place: (A) is `SCORING_TRIGGER_PERSON_FIELDS` in
 * `scoring-run.ts`, (B) is `pinReleasedDecision` in the same file, which reads
 * the marker written below and pins the decision to PASS while still updating
 * the score and the trace.
 */

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

const displayNameOf = (person: Record<string, unknown> | null): string => {
  const name = person?.['name'];

  if (typeof name !== 'object' || name === null) {
    return '';
  }

  const { firstName, lastName } = name as Record<string, unknown>;

  return [firstName, lastName]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' ');
};

const fetchLeadState = async (
  client: CoreApiClient,
  recordId: string,
): Promise<CurrentLeadState | null> => {
  const result = await client.query({
    people: {
      __args: { filter: { id: { eq: recordId } }, first: 1 },
      edges: {
        node: {
          id: true,
          name: { firstName: true, lastName: true },
          greenlightScore: true,
          greenlightDecision: true,
          greenlightTrace: true,
        },
      },
    },
  });

  const node = result?.people?.edges?.[0]?.node ?? null;

  if (node === null) {
    return null;
  }

  return {
    recordId,
    displayName: displayNameOf(node),
    decision:
      typeof node.greenlightDecision === 'string' ? node.greenlightDecision : null,
    score: typeof node.greenlightScore === 'number' ? node.greenlightScore : null,
    trace: node.greenlightTrace ?? null,
  };
};

/**
 * The previous release, if any. A key-value miss and a key-value *failure* are
 * treated the same on purpose: the marker is an optimisation for the duplicate
 * window and a hint for the scoring function, never a correctness dependency.
 * The authoritative "is this lead held" answer is the decision field.
 */
const readMarker = async (
  request: ReleaseRequest,
): Promise<ReleaseMarker | null> => {
  try {
    return await kv.get<ReleaseMarker>(
      releaseMarkerKey(request.leadObjectNameSingular, request.recordId),
      { scope: 'WORKSPACE' },
    );
  } catch (error) {
    console.warn(
      `greenlight: could not read the release marker for ${request.recordId}; continuing without it. ${errorMessage(error)}`,
    );

    return null;
  }
};

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

const clearGate = async (
  client: CoreApiClient,
  recordId: string,
): Promise<void> => {
  await client.mutation({
    updatePerson: {
      __args: { id: recordId, data: { greenlightDecision: DECISION_PASS } },
      id: true,
    },
  });
};

const appendAuditRow = async (
  client: CoreApiClient,
  data: Record<string, unknown>,
): Promise<void> => {
  // `greenlightAuditLog` is the object's nameSingular, so Twenty exposes the
  // mutation as `createGreenlightAuditLog`.
  await client.mutation({
    createGreenlightAuditLog: {
      __args: { data },
      id: true,
    },
  });
};

const writeMarker = async (
  marker: ReleaseMarker,
): Promise<void> => {
  try {
    await kv.set(
      releaseMarkerKey(marker.leadObjectNameSingular, marker.recordId),
      marker,
      { scope: 'WORKSPACE' },
    );
  } catch (error) {
    // Fail-open: the release itself already happened and is already audited.
    // Losing the marker means the scoring function may re-gate this lead on its
    // next legitimate run — bad, but strictly better than refusing a release
    // that the reviewer has already been told succeeded.
    console.warn(
      `greenlight: released ${marker.recordId} but could not persist the release marker; a later re-score may re-gate it. ${errorMessage(error)}`,
    );
  }
};

/* -------------------------------------------------------------------------- */
/* Handler                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Who did it — by name, and this is the row where that matters most.
 *
 * `userWorkspaceId` comes off the authenticated request, so it is server-derived
 * and not something the caller can assert. That has always been true here. What
 * was not true was the conclusion this comment used to draw from it: that a
 * friendly name "needs a workspace-member lookup whose API shape is not
 * documented for app-scoped tokens, and a wrong guess here would break every
 * override", so the row would carry the raw id instead and Twenty's own
 * `createdBy` would have to do the rest.
 *
 * Every clause of that is defensible except the last step. This row is the
 * GDPR Art. 22 evidence that a *human* overruled an automated decision, and the
 * question it is produced to answer — months later, to somebody who was not
 * there — is "who released this lead, and why". `Workspace member
 * 20202020-9e3b-…` answers neither, and the id in it was not even the one an
 * admin can look up: `userWorkspaceId` identifies the membership row, not the
 * member. An undocumented API surface is a reason to verify it against a live
 * instance, which took one deploy, not a reason to ship a UUID.
 *
 * `resolveActorDisplayName` now does the lookup — from the request's own
 * identity and never from its body — and falls back to exactly the string above
 * if it cannot. See `src/logic-functions/actor-identity.ts` for why it needs no
 * new permission, and `src/identity/actor.ts` for why the id stays in the
 * string next to the name.
 */
const handler = async (event: RoutePayload) => {
  const parsed = parseReleaseRequest(event.body);

  if (!parsed.ok) {
    return new Response(
      { outcome: 'invalid_request', message: parsed.message },
      { status: 400 },
    );
  }

  const request = parsed.request;
  const client = new CoreApiClient();

  let lead: CurrentLeadState | null;

  try {
    lead = await fetchLeadState(client, request.recordId);
  } catch (error) {
    return new Response(
      {
        outcome: 'lookup_failed',
        message:
          'Greenlight could not read this lead to check whether it is held. Nothing was changed — try again.',
        detail: errorMessage(error),
      },
      { status: 502 },
    );
  }

  if (lead === null) {
    return new Response(
      {
        outcome: 'record_not_found',
        message: 'That lead no longer exists.',
      },
      { status: 404 },
    );
  }

  const now = new Date();
  const marker = await readMarker(request);
  const decision = decideRelease({ request, lead, marker, now });
  // Once, and reused by both the audit row and the release marker. They are two
  // records of one act by one person, and they must not be able to disagree
  // about who that was.
  const actor = await resolveActorDisplayName(event);

  if (decision.shouldClearGate) {
    try {
      await clearGate(client, request.recordId);
    } catch (error) {
      return new Response(
        {
          outcome: 'release_failed',
          message:
            'Greenlight could not clear the gate on this lead. Nothing was changed and nothing was logged — try again.',
          detail: errorMessage(error),
        },
        { status: 502 },
      );
    }
  }

  if (decision.shouldWriteAuditRow && decision.auditEventType !== null) {
    try {
      await appendAuditRow(client, {
        name: buildAuditSummary(decision.auditEventType, lead),
        eventType: decision.auditEventType,
        occurredAt: now.toISOString(),
        leadObjectNameSingular: request.leadObjectNameSingular,
        leadRecordId: request.recordId,
        leadDisplayName: lead.displayName,
        actorType: 'HUMAN',
        actorDisplayName: actor,
        ruleTrace: lead.trace ?? { rules: [] },
        score: lead.score,
        // Carried out of the trace rather than left to the field's UNSCORED
        // default, which used to make every RELEASED row contradict the GATED
        // row for the same lead. See `auditBandValue`.
        band: auditBandValue(lead.trace),
        // The audit row records the state the gate was left in: PASS on a real
        // release, and otherwise whatever the record still says — GATE for a
        // judgement call, BLOCKED for a compliance stop.
        decision: auditDecisionValue(lead.decision, decision.shouldClearGate),
        overrideReason: decision.overrideReason,
        traceId: `release-${request.recordId}-${now.getTime()}`,
      });
    } catch (error) {
      // The gate is already open at this point. Surfacing this loudly matters:
      // an unlogged override is exactly the thing the Art. 22 argument cannot
      // afford, so the reviewer is told rather than shown a clean success.
      console.error(
        `greenlight: released ${request.recordId} but failed to write the audit row. ${errorMessage(error)}`,
      );

      return new Response(
        {
          outcome: decision.outcome,
          released: decision.shouldClearGate,
          message: `${decision.message} Warning: the audit entry could not be written — report this before releasing more leads.`,
          auditWritten: false,
        },
        { status: 207 },
      );
    }
  }

  if (decision.shouldWriteMarker) {
    await writeMarker({
      leadObjectNameSingular: request.leadObjectNameSingular,
      recordId: request.recordId,
      releasedAt: now.toISOString(),
      releasedBy: actor,
      reasonCode: request.reasonCode,
    });
  }

  return new Response(
    {
      outcome: decision.outcome,
      released: decision.shouldClearGate,
      message: decision.message,
      auditWritten: decision.shouldWriteAuditRow,
    },
    { status: decision.outcome === 'refused_compliance_block' ? 409 : 200 },
  );
};

export default defineLogicFunction({
  universalIdentifier: RELEASE_LEAD_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
  name: 'release-lead',
  description:
    'Releases a lead held by the Greenlight gate: clears the gate flag and appends the human override to the audit log.',
  timeoutSeconds: 15,
  handler,
  httpRouteTriggerSettings: {
    path: RELEASE_LEAD_ROUTE_PATH,
    httpMethod: 'POST',
    isAuthRequired: true,
  },
});
