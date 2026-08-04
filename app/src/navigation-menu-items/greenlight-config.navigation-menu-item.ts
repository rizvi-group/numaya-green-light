import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
} from 'twenty-sdk/define';

import {
  GREENLIGHT_CONFIG_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  GREENLIGHT_CONFIG_VIEW_UNIVERSAL_IDENTIFIER,
} from 'src/constants/universal-identifiers';

// A view with no navigation menu item never reaches the sidebar, so the
// configuration object would be findable only by URL. Positions 0 and 1 sit
// after the app's own overview page, which claims -1.
export default defineNavigationMenuItem({
  universalIdentifier:
    GREENLIGHT_CONFIG_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  name: 'Greenlight Configuration',
  icon: 'IconAdjustments',
  position: 0,
  type: NavigationMenuItemType.VIEW,
  viewUniversalIdentifier: GREENLIGHT_CONFIG_VIEW_UNIVERSAL_IDENTIFIER,
});
