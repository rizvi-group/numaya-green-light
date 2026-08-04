import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
} from 'twenty-sdk/define';

import {
  ICP_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  ICP_PAGE_LAYOUT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/icp-identifiers';

/**
 * In the sidebar, permanently, and **above the queues** — position 0, ahead of
 * the gate queue at 1.
 *
 * That ordering is the point of this file. The queues are the surfaces an admin
 * reads a verdict from, and a verdict is only worth what the profile behind it is
 * worth. With an empty ICP, the three rules that decide whether a lead is a *fit*
 * report `not_applicable` and score 0/0 — correctly — and every number in those
 * queues is built from whether the record holds contact details. Putting the
 * profile after the queues would let somebody trust the queue before learning
 * what it was computed from, which is the exact sequence this feature exists to
 * break.
 *
 * A sidebar entry rather than only a command menu item because a command must be
 * searched for, and the defect here is that nobody knows to search. The entry is
 * present before anyone suspects anything, which is the only property that fixes
 * an invisibility bug.
 */
export default defineNavigationMenuItem({
  universalIdentifier: ICP_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  name: 'Greenlight ICP',
  icon: 'IconTargetArrow',
  position: 0,
  type: NavigationMenuItemType.PAGE_LAYOUT,
  pageLayoutUniversalIdentifier: ICP_PAGE_LAYOUT_UNIVERSAL_IDENTIFIER,
});
