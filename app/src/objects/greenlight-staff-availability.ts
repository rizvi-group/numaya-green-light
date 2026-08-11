import {
  defineObject,
  FieldType,
  OnDeleteAction,
  RelationType,
} from 'twenty-sdk/define';

import {
  SALES_STAFF_OBJECT_UNIVERSAL_IDENTIFIER,
  STAFF_AVAILABILITY_FIELD_UNIVERSAL_IDENTIFIERS,
  STAFF_AVAILABILITY_INVERSE_FIELD_UNIVERSAL_IDENTIFIER,
  STAFF_AVAILABILITY_OBJECT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/sales-team-identifiers';

/**
 * GreenlightStaffAvailability — the exceptions to somebody's normal week.
 *
 * Working preferences on the staff record describe the usual pattern. This
 * describes the departures from it: leave, a public holiday, a training week,
 * a stretch of reduced hours, or extra cover somebody has offered.
 *
 * ## Why a separate object rather than fields on the staff record
 *
 * Because it is a list with its own lifecycle, and because the question asked of
 * it is "who is available between these two dates" — a query, over rows, by
 * date. Modelled as fields it would be one absence per person, overwritten each
 * time, with no history and nothing to answer that question with.
 *
 * ## Why there is no reason field
 *
 * `kind` says `LEAVE`; it never says why somebody is on leave. Routing has never
 * needed the reason, and the reason is frequently health data — which the design
 * keeps out of this app deliberately (see `greenlight-sales-staff.ts`). A free
 * `note` exists for the operational remainder: "conference, email only".
 */
export default defineObject({
  universalIdentifier: STAFF_AVAILABILITY_OBJECT_UNIVERSAL_IDENTIFIER,
  nameSingular: 'greenlightStaffAvailability',
  namePlural: 'greenlightStaffAvailabilities',
  labelSingular: 'Availability',
  labelPlural: 'Availability',
  description:
    'A dated exception to a team member’s normal working pattern — leave, training, reduced hours or extra cover.',
  icon: 'IconCalendarTime',
  isSearchable: false,
  labelIdentifierFieldMetadataUniversalIdentifier:
    STAFF_AVAILABILITY_FIELD_UNIVERSAL_IDENTIFIERS.name,
  fields: [
    {
      universalIdentifier: STAFF_AVAILABILITY_FIELD_UNIVERSAL_IDENTIFIERS.name,
      type: FieldType.TEXT,
      name: 'name',
      label: 'Summary',
      description: 'One line, e.g. "Annual leave". This is the record label.',
      icon: 'IconAbc',
      defaultValue: "''",
    },
    {
      universalIdentifier: STAFF_AVAILABILITY_FIELD_UNIVERSAL_IDENTIFIERS.staff,
      type: FieldType.RELATION,
      name: 'staff',
      label: 'Team member',
      description: 'Whose availability this is.',
      icon: 'IconUserStar',
      isNullable: true,
      relationTargetObjectMetadataUniversalIdentifier:
        SALES_STAFF_OBJECT_UNIVERSAL_IDENTIFIER,
      relationTargetFieldMetadataUniversalIdentifier:
        STAFF_AVAILABILITY_INVERSE_FIELD_UNIVERSAL_IDENTIFIER,
      universalSettings: {
        relationType: RelationType.MANY_TO_ONE,
        // CASCADE here, unlike the workspace-member link on the staff record:
        // an availability entry describes a staff record and means nothing
        // without it, whereas the staff record has to outlive the user account.
        onDelete: OnDeleteAction.CASCADE,
        joinColumnName: 'staffId',
      },
    },
    {
      universalIdentifier: STAFF_AVAILABILITY_FIELD_UNIVERSAL_IDENTIFIERS.kind,
      type: FieldType.SELECT,
      name: 'kind',
      label: 'Kind',
      description:
        'What sort of exception this is. Deliberately says what it is, never why.',
      icon: 'IconCalendarEvent',
      options: [
        { position: 0, label: 'Leave', value: 'LEAVE', color: 'orange' },
        { position: 1, label: 'Public holiday', value: 'PUBLIC_HOLIDAY', color: 'gray' },
        { position: 2, label: 'Training', value: 'TRAINING', color: 'blue' },
        { position: 3, label: 'Reduced hours', value: 'REDUCED_HOURS', color: 'yellow' },
        { position: 4, label: 'Extra cover', value: 'EXTRA_COVER', color: 'green' },
      ],
      defaultValue: "'LEAVE'",
    },
    {
      universalIdentifier:
        STAFF_AVAILABILITY_FIELD_UNIVERSAL_IDENTIFIERS.startsOn,
      type: FieldType.DATE_TIME,
      name: 'startsOn',
      label: 'Starts',
      description: 'First day of the exception.',
      icon: 'IconCalendarPlus',
      isNullable: true,
    },
    {
      universalIdentifier: STAFF_AVAILABILITY_FIELD_UNIVERSAL_IDENTIFIERS.endsOn,
      type: FieldType.DATE_TIME,
      name: 'endsOn',
      label: 'Ends',
      description: 'Last day of the exception.',
      icon: 'IconCalendarMinus',
      isNullable: true,
    },
    {
      universalIdentifier: STAFF_AVAILABILITY_FIELD_UNIVERSAL_IDENTIFIERS.note,
      type: FieldType.TEXT,
      name: 'note',
      label: 'Note',
      description:
        'Operational detail only, e.g. "conference, email only". Not a place to record why somebody is away.',
      icon: 'IconNote',
      defaultValue: "''",
    },
  ],
});
