import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
} from 'twenty-sdk/define';

import {
  ENRICHED_LEADS_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  ENRICHED_LEADS_VIEW_UNIVERSAL_IDENTIFIER,
} from 'src/constants/enrichment-identifiers';

// In the sidebar rather than buried, for the same reason the unscored queue is:
// enrichment is the part of the product a customer is billed for by a third
// party, and a spend they cannot see at a glance is a spend they will be
// surprised by. The view carries the cap and failure states, not just the wins.
export default defineNavigationMenuItem({
  universalIdentifier:
    ENRICHED_LEADS_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  name: 'Greenlight Enrichment',
  icon: 'IconSparkles',
  position: 5,
  type: NavigationMenuItemType.VIEW,
  viewUniversalIdentifier: ENRICHED_LEADS_VIEW_UNIVERSAL_IDENTIFIER,
});
