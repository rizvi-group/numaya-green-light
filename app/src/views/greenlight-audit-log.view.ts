import { defineView, ViewSortDirection, ViewType } from 'twenty-sdk/define';

import {
  GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS,
  GREENLIGHT_AUDIT_LOG_OBJECT_UNIVERSAL_IDENTIFIER,
  GREENLIGHT_AUDIT_LOG_VIEW_FIELD_UNIVERSAL_IDENTIFIERS,
  GREENLIGHT_AUDIT_LOG_VIEW_SORT_UNIVERSAL_IDENTIFIER,
  GREENLIGHT_AUDIT_LOG_VIEW_UNIVERSAL_IDENTIFIER,
} from 'src/constants/universal-identifiers';

/**
 * Index view for GreenlightAuditLog — the "why was this lead gated" screen and
 * the compliance evidence in one place.
 *
 * Sorted newest-first: an append-only log read oldest-first is useless the day
 * after install. `ruleTrace` stays off the table for the same reason the config
 * blobs do; it is read on the record page.
 */
export default defineView({
  universalIdentifier: GREENLIGHT_AUDIT_LOG_VIEW_UNIVERSAL_IDENTIFIER,
  name: 'Greenlight Audit Log',
  objectUniversalIdentifier: GREENLIGHT_AUDIT_LOG_OBJECT_UNIVERSAL_IDENTIFIER,
  type: ViewType.TABLE,
  icon: 'IconHistory',
  position: 1,
  fields: [
    {
      universalIdentifier:
        GREENLIGHT_AUDIT_LOG_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.name,
      fieldMetadataUniversalIdentifier:
        GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS.name,
      position: 0,
      isVisible: true,
      size: 220,
    },
    {
      universalIdentifier:
        GREENLIGHT_AUDIT_LOG_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.occurredAt,
      fieldMetadataUniversalIdentifier:
        GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS.occurredAt,
      position: 1,
      isVisible: true,
      size: 160,
    },
    {
      universalIdentifier:
        GREENLIGHT_AUDIT_LOG_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.eventType,
      fieldMetadataUniversalIdentifier:
        GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS.eventType,
      position: 2,
      isVisible: true,
      size: 120,
    },
    {
      universalIdentifier:
        GREENLIGHT_AUDIT_LOG_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.leadDisplayName,
      fieldMetadataUniversalIdentifier:
        GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS.leadDisplayName,
      position: 3,
      isVisible: true,
      size: 180,
    },
    {
      universalIdentifier:
        GREENLIGHT_AUDIT_LOG_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.decision,
      fieldMetadataUniversalIdentifier:
        GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS.decision,
      position: 4,
      isVisible: true,
      size: 120,
    },
    {
      universalIdentifier:
        GREENLIGHT_AUDIT_LOG_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.score,
      fieldMetadataUniversalIdentifier:
        GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS.score,
      position: 5,
      isVisible: true,
      size: 100,
    },
    {
      universalIdentifier:
        GREENLIGHT_AUDIT_LOG_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.band,
      fieldMetadataUniversalIdentifier:
        GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS.band,
      position: 6,
      isVisible: true,
      size: 120,
    },
    {
      universalIdentifier:
        GREENLIGHT_AUDIT_LOG_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.actorDisplayName,
      fieldMetadataUniversalIdentifier:
        GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS.actorDisplayName,
      position: 7,
      isVisible: true,
      size: 160,
    },
  ],
  sorts: [
    {
      universalIdentifier: GREENLIGHT_AUDIT_LOG_VIEW_SORT_UNIVERSAL_IDENTIFIER,
      fieldMetadataUniversalIdentifier:
        GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS.occurredAt,
      direction: ViewSortDirection.DESC,
    },
  ],
});
