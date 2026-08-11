import {
  defineObject,
  FieldType,
  OnDeleteAction,
  RelationType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  SALES_STAFF_OBJECT_UNIVERSAL_IDENTIFIER,
  STAFF_NOTE_FIELD_UNIVERSAL_IDENTIFIERS,
  STAFF_NOTE_INVERSE_FIELD_UNIVERSAL_IDENTIFIERS,
  STAFF_NOTE_OBJECT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/sales-team-identifiers';

/**
 * GreenlightStaffNote — operational notes about a team member.
 *
 * ## The scope decision is enforced by the type list, and that is on purpose
 *
 * There is no `PERFORMANCE` and no `CONCERN` option, because this system does
 * not hold performance or disciplinary records. That was decided deliberately
 * (see `SALES_TEAM_SPEC.md` §1), and the absence of the option is what keeps it
 * decided: a manager reaching for "performance review" finds nothing that fits,
 * which is the moment to have the conversation about whether this app should
 * hold that at all.
 *
 * If it ever should, the answer is not a new option here. It is a second object
 * that team members have no access to, because the confidentiality rule for a
 * private note is different in kind — the subject may not read it — and a
 * per-row flag governing that is a rule that has to be right on every row
 * forever, failing silently toward disclosure. The spec describes that design;
 * it is deliberately not built.
 *
 * ## Team members can read their own notes
 *
 * Every note here is the sort a manager would be comfortable with the subject
 * reading, so the self-service route returns them — to the subject, and to
 * nobody else. One rep cannot read another's, because the route answers only
 * about its caller and reps hold no permission on this object at all.
 */
export default defineObject({
  universalIdentifier: STAFF_NOTE_OBJECT_UNIVERSAL_IDENTIFIER,
  nameSingular: 'greenlightStaffNote',
  namePlural: 'greenlightStaffNotes',
  labelSingular: 'Team Note',
  labelPlural: 'Team Notes',
  description:
    'An operational note about a team member — availability, capability, coverage or onboarding. Not a performance record.',
  icon: 'IconNotes',
  isSearchable: true,
  labelIdentifierFieldMetadataUniversalIdentifier:
    STAFF_NOTE_FIELD_UNIVERSAL_IDENTIFIERS.name,
  fields: [
    {
      universalIdentifier: STAFF_NOTE_FIELD_UNIVERSAL_IDENTIFIERS.name,
      type: FieldType.TEXT,
      name: 'name',
      label: 'Summary',
      description: 'One line. This is the record label.',
      icon: 'IconAbc',
      defaultValue: "''",
    },
    {
      universalIdentifier: STAFF_NOTE_FIELD_UNIVERSAL_IDENTIFIERS.body,
      type: FieldType.TEXT,
      name: 'body',
      label: 'Note',
      description: 'The note itself.',
      icon: 'IconFileText',
      defaultValue: "''",
    },
    {
      universalIdentifier: STAFF_NOTE_FIELD_UNIVERSAL_IDENTIFIERS.staff,
      type: FieldType.RELATION,
      name: 'staff',
      label: 'Team member',
      description: 'Who the note is about.',
      icon: 'IconUserStar',
      isNullable: true,
      relationTargetObjectMetadataUniversalIdentifier:
        SALES_STAFF_OBJECT_UNIVERSAL_IDENTIFIER,
      relationTargetFieldMetadataUniversalIdentifier:
        STAFF_NOTE_INVERSE_FIELD_UNIVERSAL_IDENTIFIERS.staffNotes,
      universalSettings: {
        relationType: RelationType.MANY_TO_ONE,
        onDelete: OnDeleteAction.CASCADE,
        joinColumnName: 'staffId',
      },
    },
    {
      universalIdentifier: STAFF_NOTE_FIELD_UNIVERSAL_IDENTIFIERS.noteType,
      type: FieldType.SELECT,
      name: 'noteType',
      label: 'Type',
      description:
        'What kind of operational note this is. There is no performance option, and that is deliberate.',
      icon: 'IconTag',
      options: [
        { position: 0, label: 'Availability', value: 'AVAILABILITY', color: 'orange' },
        { position: 1, label: 'Capability', value: 'CAPABILITY', color: 'blue' },
        { position: 2, label: 'Coverage', value: 'COVERAGE', color: 'turquoise' },
        { position: 3, label: 'Onboarding', value: 'ONBOARDING', color: 'green' },
        { position: 4, label: 'Admin', value: 'ADMIN', color: 'gray' },
      ],
      defaultValue: "'CAPABILITY'",
    },
    {
      universalIdentifier: STAFF_NOTE_FIELD_UNIVERSAL_IDENTIFIERS.occurredOn,
      type: FieldType.DATE_TIME,
      name: 'occurredOn',
      label: 'Date',
      description: 'When this was true or was discussed.',
      icon: 'IconCalendar',
      isNullable: true,
    },
    {
      universalIdentifier: STAFF_NOTE_FIELD_UNIVERSAL_IDENTIFIERS.author,
      type: FieldType.RELATION,
      name: 'author',
      label: 'Author',
      description: 'Who wrote it.',
      icon: 'IconPencil',
      isNullable: true,
      relationTargetObjectMetadataUniversalIdentifier:
        STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.workspaceMember
          .universalIdentifier,
      relationTargetFieldMetadataUniversalIdentifier:
        STAFF_NOTE_INVERSE_FIELD_UNIVERSAL_IDENTIFIERS.authorNotes,
      universalSettings: {
        relationType: RelationType.MANY_TO_ONE,
        onDelete: OnDeleteAction.SET_NULL,
        joinColumnName: 'authorId',
      },
    },
  ],
});
