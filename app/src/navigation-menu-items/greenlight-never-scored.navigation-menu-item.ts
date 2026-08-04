import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
} from 'twenty-sdk/define';

import {
  NEVER_SCORED_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  NEVER_SCORED_VIEW_UNIVERSAL_IDENTIFIER,
} from 'src/constants/backfill-identifiers';

// In the sidebar, permanently, and not tucked behind the gate queue. A workspace
// where this list is long has a gate that is only guarding the leads that
// arrived after it was installed — and the gate queue, being empty, says nothing
// about that at all. The count next to the name is the fastest honest answer to
// "is Greenlight actually covering my data".
export default defineNavigationMenuItem({
  universalIdentifier: NEVER_SCORED_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  name: 'Greenlight Never Scored',
  icon: 'IconEyeOff',
  position: 6,
  type: NavigationMenuItemType.VIEW,
  viewUniversalIdentifier: NEVER_SCORED_VIEW_UNIVERSAL_IDENTIFIER,
});
