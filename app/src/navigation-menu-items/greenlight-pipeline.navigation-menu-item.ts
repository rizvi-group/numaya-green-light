import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
} from 'twenty-sdk/define';

import {
  PIPELINE_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  PIPELINE_PAGE_LAYOUT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/pipeline-identifiers';

/**
 * First in the sidebar, above everything else Greenlight ships.
 *
 * ## Why first
 *
 * The ICP entry took position 0 on the argument that a verdict is only worth
 * what the profile behind it is worth, so nobody should meet a queue before
 * learning what it was computed from. That argument was right about the queues
 * and it is not an argument for the ICP page being the app's front door — it was
 * the least-bad front door available when the alternative was six queues.
 *
 * PIPELINE_SPEC.md changes what the front door should be. The queues, the ICP
 * page, the record trace and the command menu are four places a salesperson has
 * to visit to answer one question, and the connective tissue — *what do I do
 * about this lead, right now* — was left in their head. The board is that
 * answer, so it is the surface the app opens on. Everything below it is now
 * something you go to when the board has told you to.
 *
 * The ICP page keeps its own position and its own reasoning intact; it moves
 * from first to second, which is the correct relationship between "what should I
 * do today" and "is the model that decides that configured properly".
 *
 * ## Position -1, and why nothing is renumbered
 *
 * `position` is an ordering hint, not an identity, and Twenty does not require
 * it to be unique — this app already ships two entries at 0 (Configuration and
 * ICP) and two at 5 (Enriched and the suppression list), and they render in a
 * stable order regardless. So there are two ways to put an entry above them:
 * renumber every existing entry upward, or take a position below the current
 * minimum.
 *
 * Renumbering is rejected. Each of those numbers is written into a customer's
 * workspace at install, several carry a documented argument about *why* that
 * entry sits where it does, and shifting nine of them to make room for one is
 * nine chances to reorder a sidebar a user has already learned — for no gain,
 * since -1 achieves the identical result.
 *
 * -1 is deliberately not novel. The scaffolded main page shipped at -1 and sat
 * above every real Greenlight surface, which is documented in
 * `RETIRED_UNIVERSAL_IDENTIFIERS` as the bug it was: it put an app-developer
 * tutorial in front of a salesperson. That the *slot* worked is not in question
 * — it demonstrably sorted first — only what was put in it. The slot has been
 * empty since that page was retired, and this is the first surface that has any
 * business occupying it.
 *
 * A sidebar entry rather than only a command menu item, for the reason the ICP
 * entry gives: a command has to be searched for, and a primary working surface
 * that must be searched for is not a primary working surface.
 */
export default defineNavigationMenuItem({
  universalIdentifier: PIPELINE_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  name: 'Greenlight Pipeline',
  icon: 'IconLayoutKanban',
  position: -1,
  type: NavigationMenuItemType.PAGE_LAYOUT,
  pageLayoutUniversalIdentifier: PIPELINE_PAGE_LAYOUT_UNIVERSAL_IDENTIFIER,
});
