import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
} from 'twenty-sdk/define';

import {
  SUPPRESSION_LIST_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  SUPPRESSION_LIST_VIEW_UNIVERSAL_IDENTIFIER,
} from 'src/constants/gate-queue-identifiers';

// Position 5, immediately after the compliance-blocked queue (4) — the last
// entry Greenlight adds. The two compliance surfaces belong next to each other:
// blocked is "what the engine is holding today", this is "who we have promised
// not to contact", and reading one without the other is how a workspace comes to
// believe its do-not-contact list is smaller than it is.
//
// Sidebar-visible rather than buried behind a filter for the same reason the
// blocked queue is: a do-not-contact list nobody can find is a do-not-contact
// list nobody checks before a send, and "show me everyone we must not email" is
// a question asked out loud, by people who do not use the CRM daily, usually
// with a deadline attached.
export default defineNavigationMenuItem({
  universalIdentifier:
    SUPPRESSION_LIST_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  name: 'Greenlight Do Not Contact',
  icon: 'IconHandStop',
  position: 5,
  type: NavigationMenuItemType.VIEW,
  viewUniversalIdentifier: SUPPRESSION_LIST_VIEW_UNIVERSAL_IDENTIFIER,
});
