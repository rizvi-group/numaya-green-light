import { defineCommandMenuItem } from 'twenty-sdk/define';

import {
  STAFF_SELF_SERVICE_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  STAFF_SELF_SERVICE_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/sales-team-identifiers';

/**
 * "My work preferences" in the command menu.
 *
 * `GLOBAL`, and available to everybody — including the people who hold no
 * permission on any sales-team object. That is not an oversight: the command
 * opens a panel that asks a route about the caller, and the route answers only
 * about the caller. Someone with no team record gets a sentence saying so.
 *
 * A sidebar entry was the alternative and is wrong here. The sidebar is shared
 * furniture; this is a personal page, opened when somebody changes their hours
 * or goes on leave, which is a handful of times a year.
 */
export default defineCommandMenuItem({
  universalIdentifier: STAFF_SELF_SERVICE_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  label: 'My work preferences (Greenlight)',
  shortLabel: 'My work preferences',
  availabilityType: 'GLOBAL',
  frontComponentUniversalIdentifier:
    STAFF_SELF_SERVICE_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
});
