import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
} from 'twenty-sdk/define';

import {
  GATE_QUEUE_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  GATE_QUEUE_VIEW_UNIVERSAL_IDENTIFIER,
} from 'src/constants/gate-queue-identifiers';

// The gate queue is the one screen a rep opens daily, so it earns a sidebar
// entry of its own rather than living as an unlisted view on Person. Positions
// 0 and 1 are taken by configuration and the audit log; the queue and its
// fail-open counterpart follow at 2 and 3.
export default defineNavigationMenuItem({
  universalIdentifier: GATE_QUEUE_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  name: 'Greenlight Gate Queue',
  icon: 'IconGavel',
  position: 2,
  type: NavigationMenuItemType.VIEW,
  viewUniversalIdentifier: GATE_QUEUE_VIEW_UNIVERSAL_IDENTIFIER,
});
