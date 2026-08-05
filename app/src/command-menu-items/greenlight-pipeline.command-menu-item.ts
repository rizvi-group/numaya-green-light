import { defineCommandMenuItem } from 'twenty-sdk/define';

import {
  PIPELINE_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  PIPELINE_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/pipeline-identifiers';

/**
 * "Open the pipeline (Greenlight)" — the board, from wherever somebody is
 * standing.
 *
 * This is a shortcut and nothing more, which makes it the odd one out among the
 * app's command menu items. The other five exist because the thing they open is
 * hard to find or applies to the record already on screen; the ICP command in
 * particular exists because nobody searches for a problem they do not know they
 * have. None of that is true here. The board is the first entry in the sidebar
 * and it is where the app expects people to start their day, so discoverability
 * is already solved.
 *
 * It ships anyway because the moment a rep most wants the board is while they
 * are on a lead record wondering what to do about it, and a keystroke that gets
 * them there is worth four lines.
 *
 * `availabilityType: 'GLOBAL'` and no permission guard, exactly as the others:
 * an `objectPermissions` guard was tried on the record actions and turned out to
 * be false for everybody, because that expression context is absent from the
 * front end. The route behind this is authenticated and Twenty's own RBAC is the
 * real boundary — see the note in `release-lead.command-menu-item.ts`.
 */
export default defineCommandMenuItem({
  universalIdentifier: PIPELINE_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  label: 'Open the pipeline (Greenlight)',
  shortLabel: 'Pipeline',
  availabilityType: 'GLOBAL',
  frontComponentUniversalIdentifier:
    PIPELINE_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
});
