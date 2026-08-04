import { defineCommandMenuItem } from 'twenty-sdk/define';

import {
  BACKFILL_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  BACKFILL_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/backfill-identifiers';

/**
 * "Score existing leads (Greenlight)" — open the backfill panel.
 *
 * `availabilityType: 'GLOBAL'` and no conditional expression, and both are
 * deliberate departures from the release and suppression commands next door.
 *
 *   - **Global, not record selection.** This is not an action on a lead. It is a
 *     question about the workspace — "has anything actually looked at my data" —
 *     and the answer must be reachable from wherever the person is when they
 *     think to ask it, which is usually the gate queue they are staring at
 *     because it is suspiciously empty.
 *
 *   - **No `canUpdateObjectRecords` guard.** The other two commands carry one as
 *     a UI courtesy. Here it would hide the *diagnosis* behind the permission for
 *     the *cure*: somebody who cannot start a backfill still needs to be able to
 *     see that twelve hundred leads have never been scored, so they can tell
 *     somebody who can. The route itself is authenticated, and the logic function
 *     writes under the app's own role, so Twenty's RBAC remains the actual
 *     boundary — as it is for every other command in this app.
 *
 * The label leads with the verb rather than with "Backfill". Nobody outside this
 * codebase calls it that, and a command menu is searched by typing what you want,
 * not what the implementation is named.
 */
export default defineCommandMenuItem({
  universalIdentifier: BACKFILL_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  label: 'Score existing leads (Greenlight)',
  shortLabel: 'Score existing leads',
  // No `icon`: the CLI warns that a command menu item's icon is ignored in
  // favour of the application's, and the other two commands in this app leave it
  // off for the same reason.
  availabilityType: 'GLOBAL',
  frontComponentUniversalIdentifier:
    BACKFILL_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
});
