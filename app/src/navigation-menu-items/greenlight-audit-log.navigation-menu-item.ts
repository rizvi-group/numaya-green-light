import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
} from 'twenty-sdk/define';

import {
  GREENLIGHT_AUDIT_LOG_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  GREENLIGHT_AUDIT_LOG_VIEW_UNIVERSAL_IDENTIFIER,
} from 'src/constants/universal-identifiers';

export default defineNavigationMenuItem({
  universalIdentifier:
    GREENLIGHT_AUDIT_LOG_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  name: 'Greenlight Audit Log',
  icon: 'IconHistory',
  position: 1,
  type: NavigationMenuItemType.VIEW,
  viewUniversalIdentifier: GREENLIGHT_AUDIT_LOG_VIEW_UNIVERSAL_IDENTIFIER,
});
