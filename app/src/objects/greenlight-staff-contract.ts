import {
  defineObject,
  FieldType,
  OnDeleteAction,
  RelationType,
} from 'twenty-sdk/define';

import {
  SALES_STAFF_OBJECT_UNIVERSAL_IDENTIFIER,
  STAFF_CONTRACT_FIELD_UNIVERSAL_IDENTIFIERS,
  STAFF_CONTRACT_INVERSE_FIELD_UNIVERSAL_IDENTIFIER,
  STAFF_CONTRACT_OBJECT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/sales-team-identifiers';

/**
 * GreenlightStaffContract — the agreed terms, not the signed document.
 *
 * Decided 2026-08-12: this object records *what was agreed* — type, status,
 * dates, compensation, quota, notice — and `documentUrl` is a plain link to
 * wherever the executed PDF actually lives. No upload, no file storage, and no
 * pretence that this app is the system of record for a signed instrument. A CRM
 * object holding a link is honest about what it is; one holding a PDF invites
 * somebody to believe it is the contract.
 *
 * ## Amend by superseding, never by editing
 *
 * A new set of terms is a new row, with the previous one moved to `SUPERSEDED`.
 * Editing the numbers on last year's plan destroys the only record of what
 * somebody was actually working to at the time, which is precisely the question
 * a contract record exists to answer.
 *
 * ## This is the one confidential thing left in the feature
 *
 * With performance notes out of scope, compensation is the only field here whose
 * disclosure would matter. Two consequences, both deliberate:
 *
 *  - This object is the reason the deny rules in `SALES_TEAM_SPEC.md` §5.3 are
 *    not optional. Sales Rep and Member both hold "See Records on All Objects"
 *    on a stock workspace.
 *  - The self-service route never returns compensation, even to the person it
 *    belongs to. A rep asking about their own pay is a conversation with their
 *    manager, and a route that cannot return the field cannot leak it to the
 *    wrong caller through a bug in matching.
 */
export default defineObject({
  universalIdentifier: STAFF_CONTRACT_OBJECT_UNIVERSAL_IDENTIFIER,
  nameSingular: 'greenlightStaffContract',
  namePlural: 'greenlightStaffContracts',
  labelSingular: 'Team Contract',
  labelPlural: 'Team Contracts',
  description:
    'The agreed terms for a team member — employment, contractor or commission plan. Links to the signed document; does not store it.',
  icon: 'IconFileDescription',
  isSearchable: true,
  labelIdentifierFieldMetadataUniversalIdentifier:
    STAFF_CONTRACT_FIELD_UNIVERSAL_IDENTIFIERS.name,
  fields: [
    {
      universalIdentifier: STAFF_CONTRACT_FIELD_UNIVERSAL_IDENTIFIERS.name,
      type: FieldType.TEXT,
      name: 'name',
      label: 'Name',
      description: 'e.g. "2026 commission plan". This is the record label.',
      icon: 'IconAbc',
      defaultValue: "''",
    },
    {
      universalIdentifier: STAFF_CONTRACT_FIELD_UNIVERSAL_IDENTIFIERS.staff,
      type: FieldType.RELATION,
      name: 'staff',
      label: 'Team member',
      description: 'Whose terms these are.',
      icon: 'IconUserStar',
      isNullable: true,
      relationTargetObjectMetadataUniversalIdentifier:
        SALES_STAFF_OBJECT_UNIVERSAL_IDENTIFIER,
      relationTargetFieldMetadataUniversalIdentifier:
        STAFF_CONTRACT_INVERSE_FIELD_UNIVERSAL_IDENTIFIER,
      universalSettings: {
        relationType: RelationType.MANY_TO_ONE,
        onDelete: OnDeleteAction.CASCADE,
        joinColumnName: 'staffId',
      },
    },
    {
      universalIdentifier:
        STAFF_CONTRACT_FIELD_UNIVERSAL_IDENTIFIERS.contractType,
      type: FieldType.SELECT,
      name: 'contractType',
      label: 'Type',
      description: 'What sort of agreement this is.',
      icon: 'IconFileText',
      options: [
        { position: 0, label: 'Employment', value: 'EMPLOYMENT', color: 'blue' },
        { position: 1, label: 'Contractor', value: 'CONTRACTOR', color: 'purple' },
        { position: 2, label: 'Commission plan', value: 'COMMISSION_PLAN', color: 'green' },
        { position: 3, label: 'Amendment', value: 'AMENDMENT', color: 'orange' },
      ],
      defaultValue: "'EMPLOYMENT'",
    },
    {
      universalIdentifier: STAFF_CONTRACT_FIELD_UNIVERSAL_IDENTIFIERS.status,
      type: FieldType.SELECT,
      name: 'status',
      label: 'Status',
      description:
        'Amend by adding a new row and moving this one to Superseded, rather than editing the terms somebody was working to.',
      icon: 'IconCircleCheck',
      options: [
        { position: 0, label: 'Draft', value: 'DRAFT', color: 'gray' },
        { position: 1, label: 'Active', value: 'ACTIVE', color: 'green' },
        { position: 2, label: 'Superseded', value: 'SUPERSEDED', color: 'yellow' },
        { position: 3, label: 'Terminated', value: 'TERMINATED', color: 'red' },
      ],
      defaultValue: "'DRAFT'",
    },
    {
      universalIdentifier:
        STAFF_CONTRACT_FIELD_UNIVERSAL_IDENTIFIERS.effectiveFrom,
      type: FieldType.DATE_TIME,
      name: 'effectiveFrom',
      label: 'Effective from',
      description: 'When these terms start applying.',
      icon: 'IconCalendarPlus',
      isNullable: true,
    },
    {
      universalIdentifier:
        STAFF_CONTRACT_FIELD_UNIVERSAL_IDENTIFIERS.effectiveTo,
      type: FieldType.DATE_TIME,
      name: 'effectiveTo',
      label: 'Effective to',
      description: 'When they stop, if there is an end date.',
      icon: 'IconCalendarMinus',
      isNullable: true,
    },
    {
      universalIdentifier:
        STAFF_CONTRACT_FIELD_UNIVERSAL_IDENTIFIERS.baseCompensation,
      type: FieldType.CURRENCY,
      name: 'baseCompensation',
      label: 'Base compensation',
      description:
        'Confidential. Never returned by the self-service panel, even to the person it belongs to.',
      icon: 'IconCoin',
      isNullable: true,
    },
    {
      universalIdentifier:
        STAFF_CONTRACT_FIELD_UNIVERSAL_IDENTIFIERS.variableCompensation,
      type: FieldType.CURRENCY,
      name: 'variableCompensation',
      label: 'Variable compensation',
      description:
        'Commission or bonus at target. Confidential, on the same terms as base.',
      icon: 'IconCoins',
      isNullable: true,
    },
    {
      universalIdentifier:
        STAFF_CONTRACT_FIELD_UNIVERSAL_IDENTIFIERS.quotaAmount,
      type: FieldType.CURRENCY,
      name: 'quotaAmount',
      label: 'Quota',
      description: 'The number they are carrying for this period.',
      icon: 'IconTarget',
      isNullable: true,
    },
    {
      universalIdentifier:
        STAFF_CONTRACT_FIELD_UNIVERSAL_IDENTIFIERS.noticePeriodDays,
      type: FieldType.NUMBER,
      name: 'noticePeriodDays',
      label: 'Notice period (days)',
      description: 'Notice either side must give.',
      icon: 'IconClock',
      isNullable: true,
    },
    {
      universalIdentifier:
        STAFF_CONTRACT_FIELD_UNIVERSAL_IDENTIFIERS.documentUrl,
      type: FieldType.TEXT,
      name: 'documentUrl',
      label: 'Signed document',
      description:
        'A link to where the executed document lives. This app stores the pointer, never the file.',
      icon: 'IconLink',
      defaultValue: "''",
    },
  ],
});
