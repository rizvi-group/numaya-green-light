import {
  defineCommandMenuItem,
  numberOfSelectedRecords,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  SUPPRESS_LEAD_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  SUPPRESS_LEAD_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/gate-queue-identifiers';

/**
 * "Do not contact (Greenlight)" — add one person to the block list.
 *
 * Scoped to Person because that is where the suppression fields physically ship,
 * and offered on record selection so it is reachable both from a record page and
 * from a row in any list.
 *
 * Availability mirrors the release override deliberately:
 *
 *   - `numberOfSelectedRecords === 1`. Bulk suppression is the one shape of this
 *     action that would be genuinely useful — a bounce file, an import of a
 *     partner's do-not-contact list — and it is also the one that would put
 *     forty rows in the audit trail under a single reason with no way to tell
 *     afterwards which of them was actually justified. If bulk suppression is
 *     ever built it should be an import, with its own event type, not this
 *     command widened.
 *
 *   - No `objectPermissions` clause. There was one — the guard Twenty's own
 *     documentation recommends for a `RECORD_SELECTION` action — and it hid
 *     every Greenlight record action from every user. `objectPermissions` is
 *     absent from the expression context the front end builds, so any
 *     expression reading it is false for everybody. The bisect that established
 *     that is written up in `release-lead.command-menu-item.ts`.
 *
 * Availability is *not* conditioned on the person not already being suppressed —
 * the command menu cannot read a field value on the selected record, and a
 * client-side guess would give a rep a command that appears to work and quietly
 * does nothing. The logic function answers honestly for every state instead,
 * including "already on the list under this reason" and "already on the list
 * under a different one, so the reason was amended".
 */
export default defineCommandMenuItem({
  universalIdentifier: SUPPRESS_LEAD_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  label: 'Do not contact (Greenlight)',
  shortLabel: 'Do not contact',
  availabilityType: 'RECORD_SELECTION',
  availabilityObjectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
  frontComponentUniversalIdentifier:
    SUPPRESS_LEAD_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  conditionalAvailabilityExpression: numberOfSelectedRecords === 1,
});
