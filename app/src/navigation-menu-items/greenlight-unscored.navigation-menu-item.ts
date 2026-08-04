import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
} from 'twenty-sdk/define';

import {
  UNSCORED_QUEUE_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  UNSCORED_QUEUE_VIEW_UNIVERSAL_IDENTIFIER,
} from 'src/constants/gate-queue-identifiers';

// Deliberately visible in the sidebar rather than hidden behind the gate queue.
// A fail-open backlog nobody can see is a gate that has quietly stopped working.
export default defineNavigationMenuItem({
  universalIdentifier: UNSCORED_QUEUE_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  name: 'Greenlight Unscored',
  icon: 'IconAlertTriangle',
  position: 3,
  type: NavigationMenuItemType.VIEW,
  viewUniversalIdentifier: UNSCORED_QUEUE_VIEW_UNIVERSAL_IDENTIFIER,
});
