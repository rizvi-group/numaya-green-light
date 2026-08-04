import {
  defineCommandMenuItem,
  numberOfSelectedRecords,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  UNSUPPRESS_LEAD_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  UNSUPPRESS_LEAD_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/gate-queue-identifiers';

/**
 * "Allow contact again (Greenlight)" — lift a suppression.
 *
 * A command of its own rather than a toggle inside the suppress panel. The two
 * actions are not opposites of equal weight: one stops outreach, the other
 * re-enables contact with a person on record asking us to stop. Sharing a
 * surface would make them the same gesture and let the sensitive one be reached
 * by muscle memory aimed at the safe one.
 *
 * The label says what actually happens — "allow contact again" — rather than
 * "remove suppression". A rep skimming a command menu should not have to reason
 * about what removing a negative flag implies.
 *
 * Same one-record condition as its counterpart, and for the same reasons — and,
 * like its counterpart, no `objectPermissions` guard; see
 * `release-lead.command-menu-item.ts` for why that clause had to go. Bulk lifting is not merely unbuilt here; it is the single worst
 * operation this app could offer, so it is not something to make convenient by
 * accident.
 */
export default defineCommandMenuItem({
  universalIdentifier: UNSUPPRESS_LEAD_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  label: 'Allow contact again (Greenlight)',
  shortLabel: 'Allow contact again',
  availabilityType: 'RECORD_SELECTION',
  availabilityObjectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
  frontComponentUniversalIdentifier:
    UNSUPPRESS_LEAD_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  conditionalAvailabilityExpression: numberOfSelectedRecords === 1,
});
