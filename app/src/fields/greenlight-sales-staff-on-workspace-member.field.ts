import {
  defineField,
  FieldType,
  RelationType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS,
  SALES_STAFF_INVERSE_FIELD_UNIVERSAL_IDENTIFIERS,
  SALES_STAFF_OBJECT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/sales-team-identifiers';

/**
 * The inverse of `greenlightSalesStaff.workspaceMember`, minted on the core
 * `workspaceMember` object — the side Twenty refuses to create by implication.
 *
 * A relation in an app manifest is two fields that name each other by
 * `universalIdentifier`. The MANY_TO_ONE half on our own object is not enough:
 * the server's metadata sync (v2.29, `validateMorphOrRelationFlatFieldMetadata`)
 * resolves the reciprocal in "existing or about to be created field metadatas"
 * and fails the whole install with `FIELD_METADATA_NOT_FOUND` when it is absent
 * — which is exactly how 0.2.5 shipped broken while publishing clean, because
 * the local build does not run that check. This file is the missing half.
 *
 * The field is technically a collection (ONE_TO_MANY: a member could in
 * principle be linked to more than one staff record) but is intended as a
 * 0-or-1 backlink: managers set the relation from the staff record, and this
 * side exists so Twenty can render and traverse it. Nothing in the app writes
 * through it.
 *
 * The label avoids the word "Greenlight" for the 90px record-page label box —
 * see `greenlight-decision.field.ts` for why every label this app ships does.
 */
export default defineField({
  universalIdentifier:
    SALES_STAFF_INVERSE_FIELD_UNIVERSAL_IDENTIFIERS.workspaceMemberStaff,
  objectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.workspaceMember.universalIdentifier,
  type: FieldType.RELATION,
  name: 'workspaceMemberStaff',
  label: 'Sales team',
  description:
    'The Greenlight sales-team record linked to this workspace member, if they have one. Set from the staff record; read here.',
  icon: 'IconUserStar',
  relationTargetObjectMetadataUniversalIdentifier:
    SALES_STAFF_OBJECT_UNIVERSAL_IDENTIFIER,
  relationTargetFieldMetadataUniversalIdentifier:
    SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS.workspaceMember,
  universalSettings: {
    relationType: RelationType.ONE_TO_MANY,
  },
});
