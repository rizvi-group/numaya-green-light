import {
  defineField,
  FieldType,
  RelationType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  STAFF_NOTE_FIELD_UNIVERSAL_IDENTIFIERS,
  STAFF_NOTE_INVERSE_FIELD_UNIVERSAL_IDENTIFIERS,
  STAFF_NOTE_OBJECT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/sales-team-identifiers';

/**
 * The inverse of `greenlightStaffNote.author`, minted on the core
 * `workspaceMember` object.
 *
 * Same story as `greenlight-sales-staff-on-workspace-member.field.ts`: the
 * MANY_TO_ONE half lives on our object, but a relation is two fields that name
 * each other, and the server's metadata sync fails the install with
 * `FIELD_METADATA_NOT_FOUND` when the reciprocal is referenced by uuid and
 * never declared. This is that half.
 */
export default defineField({
  universalIdentifier:
    STAFF_NOTE_INVERSE_FIELD_UNIVERSAL_IDENTIFIERS.authorNotes,
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.workspaceMember.universalIdentifier,
  type: FieldType.RELATION,
  name: 'authorNotes',
  label: 'Notes written',
  description:
    'Greenlight team notes this workspace member has written. Read-only here; notes are created on the note record.',
  icon: 'IconPencil',
  relationTargetObjectMetadataUniversalIdentifier:
    STAFF_NOTE_OBJECT_UNIVERSAL_IDENTIFIER,
  relationTargetFieldMetadataUniversalIdentifier:
    STAFF_NOTE_FIELD_UNIVERSAL_IDENTIFIERS.author,
  universalSettings: {
    relationType: RelationType.ONE_TO_MANY,
  },
});
