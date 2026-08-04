import { defineCommandMenuItem } from 'twenty-sdk/define';

import {
  ICP_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  ICP_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/icp-identifiers';

/**
 * "Set up your ideal customer profile (Greenlight)" — the same panel the sidebar
 * page shows, reachable from wherever somebody happens to be standing.
 *
 * The command menu is the *second* surface, not the first. A command has to be
 * searched for, and nobody searches for a problem they do not know they have —
 * which is the entire defect being fixed here. The sidebar page is what makes the
 * idle profile visible without being looked for; this exists because the moment
 * an admin doubts a score they are usually on a lead record or in the gate queue,
 * and making them navigate away to check the profile is how the check does not
 * get made.
 *
 * `availabilityType: 'GLOBAL'`, and no `canUpdateObjectRecords` guard, for the
 * same reasons as "Score existing leads": this is a question about the workspace
 * rather than an action on a record, and somebody who cannot change the profile
 * still needs to be able to see that 31% of the scoring model is switched off, so
 * they can tell somebody who can. The route is authenticated and Twenty's RBAC
 * remains the actual boundary.
 */
export default defineCommandMenuItem({
  universalIdentifier: ICP_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  label: 'Set up your ideal customer profile (Greenlight)',
  shortLabel: 'Ideal customer profile',
  availabilityType: 'GLOBAL',
  frontComponentUniversalIdentifier: ICP_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
});
