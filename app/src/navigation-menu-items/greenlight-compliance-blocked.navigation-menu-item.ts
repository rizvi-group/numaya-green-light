import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
} from 'twenty-sdk/define';

import {
  BLOCKED_QUEUE_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  BLOCKED_QUEUE_VIEW_UNIVERSAL_IDENTIFIER,
} from 'src/constants/gate-queue-identifiers';

// Position 4, after the gate queue (2) and the fail-open backlog (3). Visible
// rather than buried for the same reason the unscored list is: a compliance
// stop nobody can count is a compliance stop nobody can evidence, and "how many
// contacts are we refusing to call, and why" is a question a DPO asks out loud.
export default defineNavigationMenuItem({
  universalIdentifier: BLOCKED_QUEUE_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  name: 'Greenlight Compliance Blocked',
  icon: 'IconBan',
  position: 4,
  type: NavigationMenuItemType.VIEW,
  viewUniversalIdentifier: BLOCKED_QUEUE_VIEW_UNIVERSAL_IDENTIFIER,
});
