import {
  defineObject,
  FieldType,
  OnDeleteAction,
  RelationType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS,
  SALES_STAFF_INVERSE_FIELD_UNIVERSAL_IDENTIFIERS,
  SALES_STAFF_OBJECT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/sales-team-identifiers';

/**
 * GreenlightSalesStaff — who is on the sales team, what they can handle, and
 * when they are available.
 *
 * Full design in `SALES_TEAM_SPEC.md`. Four decisions are worth having next to
 * the schema, because each of them is a thing a later change could quietly undo.
 *
 * ## 1. This object holds no sensitive HR data, and that is a constraint
 *
 * No date of birth, home address, national ID, tax number, bank details, next of
 * kin, or anything about health. Not because they would be hard to add — because
 * every one of them changes the consequence of a permission mistake from
 * "a colleague learned who covers Queensland" to a reportable breach. Employment
 * paperwork belongs in a system with the controls to match.
 *
 * The same reasoning removes reason-for-absence: `greenlightStaffAvailability`
 * records that somebody is on leave, never why, because "why" is frequently
 * health data and routing never needed it.
 *
 * ## 2. Hours are local strings plus an IANA zone, not timestamps
 *
 * "I prefer 9 to 5" is a recurring intent, not an instant. As a UTC timestamp it
 * is wrong for half the year anywhere that observes daylight saving, and wrong
 * immediately for anyone who relocates. As `09:00` plus `Australia/Sydney` it
 * stays true, and any reader has to render the zone beside it — which is exactly
 * what a manager in another country needs to see.
 *
 * ## 3. `coverageRegions` and `industryExpertise` share the ICP's vocabulary
 *
 * Deliberately the same values an admin types into `icpRegions` and
 * `icpIndustries` on GreenlightConfig. Nothing in v1 reads them together; the
 * point is that when routing arrives, "this lead is Australian professional
 * services" can meet "this rep covers Australian professional services" without
 * a translation table somebody has to maintain forever.
 *
 * ## 4. The relation to `workspaceMember` is a link, not a directory grant
 *
 * `src/default-role.ts` refuses read on `workspaceMember` — that grant is the
 * customer's entire staff directory handed to a scoring app. This object stores
 * the relation so a manager can say which user a record belongs to, but the
 * app's own self-service route never reads the directory: it resolves the
 * caller's own id through `currentUser` on the metadata API and filters this
 * object by it. The refusal in the default role stands.
 */
export default defineObject({
  universalIdentifier: SALES_STAFF_OBJECT_UNIVERSAL_IDENTIFIER,
  nameSingular: 'greenlightSalesStaff',
  namePlural: 'greenlightSalesStaffs',
  labelSingular: 'Sales Team Member',
  labelPlural: 'Sales Team',
  description:
    'A member of the sales team: their working preferences, what they are equipped to sell, and how much they can take on.',
  icon: 'IconUserStar',
  isSearchable: true,
  labelIdentifierFieldMetadataUniversalIdentifier:
    SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.name,
  fields: [
    {
      universalIdentifier: SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.name,
      type: FieldType.TEXT,
      name: 'name',
      label: 'Name',
      description: 'The team member’s name. This is the record label.',
      icon: 'IconUser',
      defaultValue: "''",
    },
    {
      universalIdentifier:
        SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.workspaceMember,
      type: FieldType.RELATION,
      name: 'workspaceMember',
      label: 'Workspace member',
      description:
        'The Twenty user this record belongs to. Set by a manager; it is what lets someone see their own record and nobody else’s.',
      icon: 'IconUserCircle',
      isNullable: true,
      relationTargetObjectMetadataUniversalIdentifier:
        STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.workspaceMember
          .universalIdentifier,
      relationTargetFieldMetadataUniversalIdentifier:
        SALES_STAFF_INVERSE_FIELD_UNIVERSAL_IDENTIFIERS.workspaceMemberStaff,
      universalSettings: {
        relationType: RelationType.MANY_TO_ONE,
        // SET_NULL, not CASCADE: when somebody leaves and their user account is
        // removed, the employment record and its contract history must survive.
        // Deleting the person's history because their login was deprovisioned
        // would destroy exactly the records that outlive employment.
        onDelete: OnDeleteAction.SET_NULL,
        joinColumnName: 'workspaceMemberId',
      },
    },
    {
      universalIdentifier:
        SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.employmentStatus,
      type: FieldType.SELECT,
      name: 'employmentStatus',
      label: 'Status',
      description:
        'Where this person is in their time with the team. Drives whether they are considered for new work.',
      icon: 'IconUserCheck',
      options: [
        { position: 0, label: 'Prospective', value: 'PROSPECTIVE', color: 'gray' },
        { position: 1, label: 'Active', value: 'ACTIVE', color: 'green' },
        { position: 2, label: 'On leave', value: 'ON_LEAVE', color: 'orange' },
        { position: 3, label: 'Notice', value: 'NOTICE', color: 'yellow' },
        { position: 4, label: 'Departed', value: 'DEPARTED', color: 'red' },
      ],
      defaultValue: "'ACTIVE'",
    },
    {
      universalIdentifier: SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.teamRole,
      type: FieldType.SELECT,
      name: 'teamRole',
      label: 'Team role',
      description:
        'What they do on the team. Distinct from their Twenty role, which is about permissions.',
      icon: 'IconBriefcase',
      options: [
        { position: 0, label: 'Sales rep', value: 'SALES_REP', color: 'blue' },
        { position: 1, label: 'Sales manager', value: 'SALES_MANAGER', color: 'purple' },
        { position: 2, label: 'Sales engineer', value: 'SALES_ENGINEER', color: 'turquoise' },
        { position: 3, label: 'SDR', value: 'SDR', color: 'sky' },
        { position: 4, label: 'Other', value: 'OTHER', color: 'gray' },
      ],
      defaultValue: "'SALES_REP'",
    },
    {
      universalIdentifier: SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.manager,
      type: FieldType.RELATION,
      name: 'manager',
      label: 'Manager',
      description: 'Who this person reports to on the sales team.',
      icon: 'IconUsers',
      isNullable: true,
      relationTargetObjectMetadataUniversalIdentifier:
        SALES_STAFF_OBJECT_UNIVERSAL_IDENTIFIER,
      relationTargetFieldMetadataUniversalIdentifier:
        SALES_STAFF_INVERSE_FIELD_UNIVERSAL_IDENTIFIERS.managerReports,
      universalSettings: {
        relationType: RelationType.MANY_TO_ONE,
        onDelete: OnDeleteAction.SET_NULL,
        joinColumnName: 'managerId',
      },
    },
    {
      universalIdentifier: SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.startedOn,
      type: FieldType.DATE_TIME,
      name: 'startedOn',
      label: 'Started on',
      description: 'When they joined the team.',
      icon: 'IconCalendarPlus',
      isNullable: true,
    },
    {
      universalIdentifier: SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.endedOn,
      type: FieldType.DATE_TIME,
      name: 'endedOn',
      label: 'Ended on',
      description: 'When they left, if they have.',
      icon: 'IconCalendarMinus',
      isNullable: true,
    },
    {
      universalIdentifier: SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.workEmail,
      type: FieldType.TEXT,
      name: 'workEmail',
      label: 'Work email',
      description:
        'Copied here rather than read from the user account, so the record still says who it was about after the account is deprovisioned.',
      icon: 'IconMail',
      defaultValue: "''",
    },

    /* ---------------------------------------------------------------- */
    /* Working preferences — the part a team member maintains themselves */
    /* ---------------------------------------------------------------- */

    {
      universalIdentifier: SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.timeZone,
      type: FieldType.TEXT,
      name: 'timeZone',
      label: 'Time zone',
      description:
        'IANA zone, e.g. Australia/Sydney. Every hour on this record is local to it — read them together or not at all.',
      icon: 'IconWorld',
      defaultValue: "''",
    },
    {
      universalIdentifier: SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.workingDays,
      type: FieldType.ARRAY,
      name: 'workingDays',
      label: 'Working days',
      description: 'Which days they normally work, e.g. MON, TUE, WED.',
      icon: 'IconCalendarWeek',
      defaultValue: [],
    },
    {
      universalIdentifier:
        SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.preferredHoursFrom,
      type: FieldType.TEXT,
      name: 'preferredHoursFrom',
      label: 'Preferred hours from',
      description: '24-hour local time, e.g. 09:00. Local to the time zone above.',
      icon: 'IconSunrise',
      defaultValue: "''",
    },
    {
      universalIdentifier:
        SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.preferredHoursTo,
      type: FieldType.TEXT,
      name: 'preferredHoursTo',
      label: 'Preferred hours to',
      description: '24-hour local time, e.g. 17:00. Local to the time zone above.',
      icon: 'IconSunset',
      defaultValue: "''",
    },
    {
      universalIdentifier:
        SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.preferredContactMode,
      type: FieldType.SELECT,
      name: 'preferredContactMode',
      label: 'Preferred contact',
      description: 'How to reach them first.',
      icon: 'IconMessage',
      options: [
        { position: 0, label: 'Email', value: 'EMAIL', color: 'blue' },
        { position: 1, label: 'Phone', value: 'PHONE', color: 'green' },
        { position: 2, label: 'Slack', value: 'SLACK', color: 'purple' },
        { position: 3, label: 'Teams', value: 'TEAMS', color: 'sky' },
        { position: 4, label: 'In person', value: 'IN_PERSON', color: 'orange' },
      ],
      defaultValue: "'EMAIL'",
    },
    {
      universalIdentifier:
        SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.preferredMeetingLength,
      type: FieldType.NUMBER,
      name: 'preferredMeetingLength',
      label: 'Preferred meeting length',
      description: 'Minutes.',
      icon: 'IconClock',
      isNullable: true,
    },
    {
      universalIdentifier:
        SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.outOfHoursContact,
      type: FieldType.SELECT,
      name: 'outOfHoursContact',
      label: 'Out of hours',
      description: 'Whether they can be contacted outside their preferred hours.',
      icon: 'IconMoon',
      options: [
        { position: 0, label: 'Never', value: 'NEVER', color: 'red' },
        { position: 1, label: 'Urgent only', value: 'URGENT_ONLY', color: 'orange' },
        { position: 2, label: 'Any time', value: 'ANY_TIME', color: 'green' },
      ],
      defaultValue: "'NEVER'",
    },

    /* ---------------------------------------------------------------- */
    /* Capabilities — what this person can be given                      */
    /* ---------------------------------------------------------------- */

    {
      universalIdentifier: SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.languages,
      type: FieldType.ARRAY,
      name: 'languages',
      label: 'Languages',
      description: 'Languages they can sell in.',
      icon: 'IconLanguage',
      defaultValue: [],
    },
    {
      universalIdentifier:
        SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.coverageRegions,
      type: FieldType.ARRAY,
      name: 'coverageRegions',
      label: 'Coverage regions',
      description:
        'Territories they sell into. Use the same words as the ICP regions on Greenlight Configuration — that is what lets a lead and a rep be compared later.',
      icon: 'IconMap',
      defaultValue: [],
    },
    {
      universalIdentifier:
        SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.industryExpertise,
      type: FieldType.ARRAY,
      name: 'industryExpertise',
      label: 'Industry expertise',
      description:
        'Industries they know. Use the same words as the ICP industries on Greenlight Configuration.',
      icon: 'IconBuildingFactory',
      defaultValue: [],
    },
    {
      universalIdentifier: SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.productLines,
      type: FieldType.ARRAY,
      name: 'productLines',
      label: 'Product lines',
      description: 'What they are cleared to sell.',
      icon: 'IconPackage',
      defaultValue: [],
    },
    {
      universalIdentifier:
        SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.certifications,
      type: FieldType.ARRAY,
      name: 'certifications',
      label: 'Certifications',
      description: 'Accreditations relevant to selling.',
      icon: 'IconCertificate',
      defaultValue: [],
    },
    {
      universalIdentifier: SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.seniority,
      type: FieldType.SELECT,
      name: 'seniority',
      label: 'Seniority',
      description: 'Pairs with deal size when work is being shared out.',
      icon: 'IconStairsUp',
      options: [
        { position: 0, label: 'Junior', value: 'JUNIOR', color: 'gray' },
        { position: 1, label: 'Mid', value: 'MID', color: 'blue' },
        { position: 2, label: 'Senior', value: 'SENIOR', color: 'purple' },
        { position: 3, label: 'Principal', value: 'PRINCIPAL', color: 'orange' },
      ],
      defaultValue: "'MID'",
    },
    {
      universalIdentifier:
        SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.maxActiveLeads,
      type: FieldType.NUMBER,
      name: 'maxActiveLeads',
      label: 'Max active leads',
      description:
        'How many live leads this person can carry well. A working capacity, not a target.',
      icon: 'IconStack',
      isNullable: true,
    },
    {
      universalIdentifier:
        SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.acceptingNewLeads,
      type: FieldType.BOOLEAN,
      name: 'acceptingNewLeads',
      label: 'Accepting new leads',
      description:
        'The switch to flip when somebody is swamped, without editing their capacity or their status.',
      icon: 'IconInbox',
      defaultValue: true,
    },
  ],
});
