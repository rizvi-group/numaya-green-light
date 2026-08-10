import { defineCommandMenuItem } from 'twenty-sdk/define';

import {
  LICENCE_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  LICENCE_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/licence-identifiers';

/**
 * "Greenlight licence" in the command menu.
 *
 * A command rather than a sidebar entry, for the same reason the backfill is
 * one: the sidebar is where a rep works all day, and neither of these is a
 * daily job. This is opened when somebody asks why enrichment is quiet, or when
 * a key needs buying — twice in the life of a workspace, and both times by
 * searching for the word "licence".
 *
 * `GLOBAL` availability because the question is not about a record. Enrichment
 * being off is a property of the workspace, and an admin who notices it while
 * looking at a Person should not have to navigate somewhere else to ask about
 * it.
 *
 * The label leads with "Greenlight" rather than the verb the other two commands
 * lead with, because there is no verb here that is honest: the panel mostly
 * tells you something, and "Buy a Greenlight licence" would promise a checkout
 * this does not have.
 */
export default defineCommandMenuItem({
  universalIdentifier: LICENCE_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  label: 'Greenlight licence and enrichment',
  shortLabel: 'Greenlight licence',
  availabilityType: 'GLOBAL',
  frontComponentUniversalIdentifier: LICENCE_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
});
