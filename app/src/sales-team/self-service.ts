/**
 * What a team member is allowed to learn about themselves.
 *
 * This module is the whole of the confidentiality rule for the self-service
 * panel, expressed as a pure function so it can be tested exhaustively without a
 * workspace, a network or a clock. The route around it does I/O and nothing
 * else.
 *
 * ## Why the rule lives here rather than in a permission
 *
 * Twenty's row-level permission predicates — "a member sees only rows where the
 * owner is them" — require an Enterprise plan (`enterprisePlanService.isValid()`
 * gates the whole module, verified against 2.29 and against the target instance,
 * which reports `ENTERPRISE_KEY: null`). So the platform cannot express "each
 * rep sees only their own row" here at all.
 *
 * The answer is not to approximate it with a flag on each row. Team members hold
 * **no permission on these objects**, and the only way to any of it is this
 * route, which is handed a caller id by the platform and can ask about nobody
 * else. That is a stronger guarantee than the permission would have been: there
 * is no record to reach by URL, by REST, by search or by exporting a view,
 * because there is no read grant to reach it with.
 *
 * ## Compensation is absent by construction
 *
 * `SelfServiceView` has no field for it and `buildSelfServiceView` is never
 * given it. This is deliberate over the alternative of fetching a contract and
 * omitting the field on the way out: a value that never enters the function
 * cannot leave it through a later edit, a spread, or a log line. A team member
 * asking about their own pay is a conversation with their manager.
 */

import type { WorkingDay } from 'src/constants/sales-team-identifiers';

/** The staff row, narrowed to what the panel may see. Compensation is not here. */
export interface SelfServiceStaffRecord {
  readonly id: string;
  readonly name: string;
  readonly employmentStatus: string;
  readonly teamRole: string;
  readonly timeZone: string;
  readonly workingDays: readonly string[];
  readonly preferredHoursFrom: string;
  readonly preferredHoursTo: string;
  readonly preferredContactMode: string;
  readonly preferredMeetingLength: number | null;
  readonly outOfHoursContact: string;
  readonly languages: readonly string[];
  readonly coverageRegions: readonly string[];
  readonly industryExpertise: readonly string[];
  readonly productLines: readonly string[];
  readonly certifications: readonly string[];
  readonly seniority: string;
  readonly maxActiveLeads: number | null;
  readonly acceptingNewLeads: boolean;
}

export interface SelfServiceAvailabilityEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly note: string;
}

export interface SelfServiceNote {
  readonly id: string;
  readonly summary: string;
  readonly body: string;
  readonly noteType: string;
  readonly occurredOn: string | null;
}

export type SelfServiceOutcome = 'ok' | 'no_record';

export interface SelfServiceView {
  readonly outcome: SelfServiceOutcome;
  readonly message: string;
  readonly staff: SelfServiceStaffRecord | null;
  readonly availability: readonly SelfServiceAvailabilityEntry[];
  readonly notes: readonly SelfServiceNote[];
  /** Which fields this person may edit about themselves. */
  readonly editableFields: readonly string[];
}

/**
 * The fields a team member maintains about themselves.
 *
 * Preferences and capacity, and nothing structural. A rep saying "I prefer 9 to
 * 5, I speak Mandarin, I am at capacity" is reporting something only they know.
 * A rep editing their own `teamRole`, `manager`, `employmentStatus` or
 * `maxActiveLeads` is deciding something their manager decides — so those are
 * absent, and the route refuses any key not on this list.
 */
export const SELF_EDITABLE_FIELDS: readonly string[] = [
  'timeZone',
  'workingDays',
  'preferredHoursFrom',
  'preferredHoursTo',
  'preferredContactMode',
  'preferredMeetingLength',
  'outOfHoursContact',
  'languages',
  'certifications',
  'acceptingNewLeads',
];

const NO_RECORD_MESSAGE =
  'No sales team record is linked to your account yet. A sales team manager creates it and links it to you; until then there is nothing here to show or edit.';

/**
 * Build the panel's answer.
 *
 * `staff === null` is an ordinary state, not an error: plenty of workspace
 * members are not on the sales team, and somebody newly hired has an account
 * days before anybody fills in their record. Saying so plainly beats an empty
 * form that looks broken.
 */
export const buildSelfServiceView = ({
  staff,
  availability,
  notes,
}: {
  readonly staff: SelfServiceStaffRecord | null;
  readonly availability: readonly SelfServiceAvailabilityEntry[];
  readonly notes: readonly SelfServiceNote[];
}): SelfServiceView => {
  if (staff === null) {
    return {
      outcome: 'no_record',
      message: NO_RECORD_MESSAGE,
      staff: null,
      // Not "whatever was passed in". If there is no record for this caller then
      // any rows reaching this function belong to somebody else, and returning
      // them would be the exact disclosure this module exists to prevent.
      availability: [],
      notes: [],
      editableFields: [],
    };
  }

  return {
    outcome: 'ok',
    message: '',
    staff,
    availability,
    notes,
    editableFields: SELF_EDITABLE_FIELDS,
  };
};

/**
 * Filter a proposed edit down to what this person may change about themselves.
 *
 * Returns the accepted subset and the rejected keys, rather than throwing on the
 * first bad key: the panel sends a whole form, and an admin reading the audit
 * row later is better served by "these three were refused" than by a failure
 * that names one.
 */
export const partitionSelfEdit = (
  patch: Record<string, unknown>,
): {
  readonly accepted: Record<string, unknown>;
  readonly rejected: readonly string[];
} => {
  const accepted: Record<string, unknown> = {};
  const rejected: string[] = [];

  for (const [key, value] of Object.entries(patch)) {
    if (SELF_EDITABLE_FIELDS.includes(key)) {
      accepted[key] = value;
    } else {
      rejected.push(key);
    }
  }

  return { accepted, rejected };
};

/** `HH:mm`, 24-hour. Anything else is refused rather than stored and rendered wrong. */
export const isValidLocalTime = (value: unknown): value is string =>
  typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

export const isValidWorkingDay = (value: unknown): value is WorkingDay =>
  typeof value === 'string' &&
  ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].includes(value);
