import { defineView, ViewType } from 'twenty-sdk/define';

import {
  GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS,
  GREENLIGHT_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER,
  GREENLIGHT_CONFIG_VIEW_FIELD_UNIVERSAL_IDENTIFIERS,
  GREENLIGHT_CONFIG_VIEW_UNIVERSAL_IDENTIFIER,
} from 'src/constants/universal-identifiers';

/**
 * Index view for GreenlightConfig. Without one the object exists but is
 * unreachable from the UI, and the settings admins are supposed to tune would be
 * API-only.
 *
 * Columns are the four values a workspace actually changes plus the record
 * label. The RAW_JSON blobs (rules, weights, size bands, shelf lives) are
 * deliberately left off the table — they are unreadable at column width and
 * belong on the record page.
 */
export default defineView({
  universalIdentifier: GREENLIGHT_CONFIG_VIEW_UNIVERSAL_IDENTIFIER,
  name: 'Greenlight Configuration',
  objectUniversalIdentifier: GREENLIGHT_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER,
  type: ViewType.TABLE,
  icon: 'IconAdjustments',
  position: 0,
  fields: [
    {
      universalIdentifier: GREENLIGHT_CONFIG_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.name,
      fieldMetadataUniversalIdentifier:
        GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.name,
      position: 0,
      isVisible: true,
      size: 180,
    },
    {
      universalIdentifier:
        GREENLIGHT_CONFIG_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.isGateEnabled,
      fieldMetadataUniversalIdentifier:
        GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.isGateEnabled,
      position: 1,
      isVisible: true,
      size: 120,
    },
    {
      universalIdentifier:
        GREENLIGHT_CONFIG_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.gateThreshold,
      fieldMetadataUniversalIdentifier:
        GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.gateThreshold,
      position: 2,
      isVisible: true,
      size: 140,
    },
    {
      universalIdentifier:
        GREENLIGHT_CONFIG_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.leadObjectNameSingular,
      fieldMetadataUniversalIdentifier:
        GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.leadObjectNameSingular,
      position: 3,
      isVisible: true,
      size: 140,
    },
    {
      universalIdentifier:
        GREENLIGHT_CONFIG_VIEW_FIELD_UNIVERSAL_IDENTIFIERS.defaultShelfLifeDays,
      fieldMetadataUniversalIdentifier:
        GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.defaultShelfLifeDays,
      position: 4,
      isVisible: true,
      size: 160,
    },
  ],
});
