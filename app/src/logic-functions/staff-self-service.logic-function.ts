import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';
import { Response, type RoutePayload } from 'twenty-sdk/logic-function';

import {
  STAFF_SELF_SERVICE_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
  STAFF_SELF_SERVICE_ROUTE_PATH,
} from 'src/constants/sales-team-identifiers';
import {
  describeError,
  logGreenlight,
} from 'src/logic-functions/greenlight-api';
import { metadataActorIdentity } from 'src/logic-functions/actor-identity';
import {
  buildSelfServiceView,
  isValidLocalTime,
  isValidWorkingDay,
  partitionSelfEdit,
  type SelfServiceAvailabilityEntry,
  type SelfServiceNote,
  type SelfServiceStaffRecord,
} from 'src/sales-team/self-service';

/**
 * "My work preferences" — the only way a team member reaches their own record.
 *
 * ## This route is the access control, and that is deliberate
 *
 * Team members hold **no object permission** on any sales-team object. Twenty's
 * row-level predicates, which would have expressed "each person sees their own
 * row", require an Enterprise plan and are unavailable on the target instance —
 * so rather than approximate them with a per-row flag, the design gives reps no
 * read grant at all and routes every question through here.
 *
 * The consequence worth stating: there is no record for one rep to reach by URL,
 * REST, search or view export, because there is no permission to reach it with.
 * The only identity this route will answer about is the one the platform put on
 * the request.
 *
 * ## How the caller is established
 *
 * `metadataActorIdentity.read(event.userWorkspaceId)` resolves `currentUser` on
 * the metadata API and refuses any identity whose `currentUserWorkspace.id` does
 * not equal the `userWorkspaceId` the platform derived for this request. Nothing
 * the client sends is consulted. If that resolution fails, this route returns
 * nothing rather than guessing — an unidentified caller is not served a record.
 *
 * It also means the app still holds no grant on `workspaceMember`: the caller's
 * own id arrives through `currentUser`, and the staff object is then filtered by
 * it. The directory refusal in `src/default-role.ts` stands.
 *
 * ## Compensation
 *
 * Never selected, never returned. See `src/sales-team/self-service.ts`.
 */

const STAFF_SELECTION = {
  id: true,
  name: true,
  employmentStatus: true,
  teamRole: true,
  timeZone: true,
  workingDays: true,
  preferredHoursFrom: true,
  preferredHoursTo: true,
  preferredContactMode: true,
  preferredMeetingLength: true,
  outOfHoursContact: true,
  languages: true,
  coverageRegions: true,
  industryExpertise: true,
  productLines: true,
  certifications: true,
  seniority: true,
  maxActiveLeads: true,
  acceptingNewLeads: true,
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readNodes = (response: unknown, connection: string): unknown[] => {
  if (!isRecord(response)) {
    return [];
  }

  const root = response[connection];

  if (!isRecord(root) || !Array.isArray(root['edges'])) {
    return [];
  }

  return root['edges']
    .map((edge) => (isRecord(edge) ? edge['node'] : null))
    .filter((node): node is Record<string, unknown> => isRecord(node));
};

const str = (value: unknown): string =>
  typeof value === 'string' ? value : '';

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const arr = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

const toStaff = (node: Record<string, unknown>): SelfServiceStaffRecord => ({
  id: str(node['id']),
  name: str(node['name']),
  employmentStatus: str(node['employmentStatus']),
  teamRole: str(node['teamRole']),
  timeZone: str(node['timeZone']),
  workingDays: arr(node['workingDays']),
  preferredHoursFrom: str(node['preferredHoursFrom']),
  preferredHoursTo: str(node['preferredHoursTo']),
  preferredContactMode: str(node['preferredContactMode']),
  preferredMeetingLength: num(node['preferredMeetingLength']),
  outOfHoursContact: str(node['outOfHoursContact']),
  languages: arr(node['languages']),
  coverageRegions: arr(node['coverageRegions']),
  industryExpertise: arr(node['industryExpertise']),
  productLines: arr(node['productLines']),
  certifications: arr(node['certifications']),
  seniority: str(node['seniority']),
  maxActiveLeads: num(node['maxActiveLeads']),
  acceptingNewLeads: node['acceptingNewLeads'] === true,
});

/** Reject a value the schema would accept but a reader would misunderstand. */
const validatePatch = (
  patch: Record<string, unknown>,
): { readonly ok: true } | { readonly ok: false; readonly message: string } => {
  for (const key of ['preferredHoursFrom', 'preferredHoursTo']) {
    const value = patch[key];

    if (value !== undefined && value !== '' && !isValidLocalTime(value)) {
      return {
        ok: false,
        message: `${key} must be a 24-hour local time such as 09:00.`,
      };
    }
  }

  const days = patch['workingDays'];

  if (days !== undefined) {
    if (!Array.isArray(days) || !days.every(isValidWorkingDay)) {
      return {
        ok: false,
        message: 'workingDays must be a list of MON, TUE, WED, THU, FRI, SAT or SUN.',
      };
    }
  }

  return { ok: true };
};

const handler = async (event: RoutePayload) => {
  const userWorkspaceId =
    typeof event.userWorkspaceId === 'string' ? event.userWorkspaceId : '';

  const identity =
    userWorkspaceId === ''
      ? null
      : await metadataActorIdentity.read(userWorkspaceId);

  if (identity === null) {
    // Not an error the caller can fix, and not a state that should degrade into
    // "here is somebody's record". An unidentified request gets nothing.
    logGreenlight('staff_self_service_unidentified', {
      note: 'the platform did not resolve a workspace member for this request',
    });

    return new Response(
      {
        outcome: 'no_record',
        message:
          'Greenlight could not confirm who you are signed in as, so it will not show a record. Reload and try again.',
        staff: null,
        availability: [],
        notes: [],
        editableFields: [],
      },
      { status: 200 },
    );
  }

  const client = new CoreApiClient();

  let staff: SelfServiceStaffRecord | null = null;

  try {
    const response = await client.query({
      greenlightSalesStaffs: {
        __args: {
          filter: { workspaceMemberId: { eq: identity.workspaceMemberId } },
          first: 1,
        },
        edges: { node: STAFF_SELECTION },
      },
    });

    const [node] = readNodes(response, 'greenlightSalesStaffs');

    staff = node === undefined ? null : toStaff(node as Record<string, unknown>);
  } catch (error) {
    logGreenlight('staff_self_service_read_failed', {
      error: describeError(error),
    });

    return new Response(
      {
        outcome: 'no_record',
        message:
          'Greenlight could not read your team record just now. Nothing has changed; try again shortly.',
        staff: null,
        availability: [],
        notes: [],
        editableFields: [],
      },
      { status: 200 },
    );
  }

  const action = isRecord(event.body) ? event.body['action'] : 'status';

  if (action === 'update' && staff !== null) {
    const raw = isRecord(event.body) && isRecord(event.body['patch'])
      ? event.body['patch']
      : {};
    const { accepted, rejected } = partitionSelfEdit(raw);
    const validation = validatePatch(accepted);

    if (!validation.ok) {
      return new Response(
        { outcome: 'invalid', message: validation.message },
        { status: 400 },
      );
    }

    if (rejected.length > 0) {
      // Refused, and recorded. A rep cannot set these, and an admin reading the
      // log later should be able to see that somebody's client tried.
      logGreenlight('staff_self_service_fields_refused', {
        staffId: staff.id,
        rejected,
      });
    }

    if (Object.keys(accepted).length > 0) {
      try {
        await client.mutation({
          updateGreenlightSalesStaff: {
            __args: { id: staff.id, data: accepted },
            id: true,
          },
        });
      } catch (error) {
        logGreenlight('staff_self_service_update_failed', {
          staffId: staff.id,
          error: describeError(error),
        });

        return new Response(
          {
            outcome: 'invalid',
            message: 'Greenlight could not save that just now. Try again shortly.',
          },
          { status: 500 },
        );
      }
    }

    staff = { ...staff, ...(accepted as Partial<SelfServiceStaffRecord>) };
  }

  const availability: SelfServiceAvailabilityEntry[] = [];
  const notes: SelfServiceNote[] = [];

  if (staff !== null) {
    try {
      const [availabilityResponse, notesResponse] = await Promise.all([
        client.query({
          greenlightStaffAvailabilities: {
            __args: { filter: { staffId: { eq: staff.id } }, first: 50 },
            edges: {
              node: {
                id: true,
                name: true,
                kind: true,
                startsOn: true,
                endsOn: true,
                note: true,
              },
            },
          },
        }),
        client.query({
          greenlightStaffNotes: {
            __args: { filter: { staffId: { eq: staff.id } }, first: 50 },
            edges: {
              node: {
                id: true,
                name: true,
                body: true,
                noteType: true,
                occurredOn: true,
              },
            },
          },
        }),
      ]);

      for (const node of readNodes(availabilityResponse, 'greenlightStaffAvailabilities')) {
        const row = node as Record<string, unknown>;

        availability.push({
          id: str(row['id']),
          name: str(row['name']),
          kind: str(row['kind']),
          startsOn: typeof row['startsOn'] === 'string' ? row['startsOn'] : null,
          endsOn: typeof row['endsOn'] === 'string' ? row['endsOn'] : null,
          note: str(row['note']),
        });
      }

      for (const node of readNodes(notesResponse, 'greenlightStaffNotes')) {
        const row = node as Record<string, unknown>;

        notes.push({
          id: str(row['id']),
          summary: str(row['name']),
          body: str(row['body']),
          noteType: str(row['noteType']),
          occurredOn:
            typeof row['occurredOn'] === 'string' ? row['occurredOn'] : null,
        });
      }
    } catch (error) {
      // Degrade to the record without its lists rather than failing the panel.
      logGreenlight('staff_self_service_lists_failed', {
        staffId: staff.id,
        error: describeError(error),
      });
    }
  }

  return new Response(
    buildSelfServiceView({ staff, availability, notes }),
    { status: 200 },
  );
};

export default defineLogicFunction({
  universalIdentifier: STAFF_SELF_SERVICE_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
  name: 'greenlight-my-work',
  description:
    'Returns the signed-in team member’s own sales team record — preferences, capabilities, availability and notes — and saves changes to the preferences they own.',
  timeoutSeconds: 15,
  handler,
  httpRouteTriggerSettings: {
    path: STAFF_SELF_SERVICE_ROUTE_PATH,
    httpMethod: 'POST',
    isAuthRequired: true,
  },
});
