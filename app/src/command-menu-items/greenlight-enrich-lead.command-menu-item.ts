import {
  defineCommandMenuItem,
  numberOfSelectedRecords,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  ENRICH_LEAD_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  ENRICH_LEAD_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/enrichment-identifiers';

/**
 * "Enrich now (Greenlight)" — ARCHITECTURE.md's second Path 2 trigger, the one
 * a human pulls.
 *
 * Scoped to Person because that is where the enrichment fields physically ship,
 * and offered on record selection so it is reachable from a record page and from
 * a row in any list — including the gate queue, which is where an admin is most
 * likely to want it: a lead held at `GATE` with an empty industry is exactly the
 * case enrichment exists to resolve.
 *
 * ## One record at a time, and this one is about money
 *
 * `numberOfSelectedRecords === 1`. The block-list actions restrict to one record
 * because a shared reason across forty rows is an unusable audit trail; this one
 * restricts to one because every run spends part of a shared monthly allowance.
 * A rep who selects a page of leads and clicks a menu item should not be able to
 * consume a quarter of the workspace's month. Bulk enrichment is a real need and
 * the answer to it is the same as for bulk scoring — a paced, resumable,
 * budget-aware backfill, not a menu item that fans out.
 *
 * ## No `objectPermissions` clause
 *
 * There was one — the guard Twenty's own documentation recommends for a
 * `RECORD_SELECTION` action — and it hid every Greenlight record action from
 * every user. `objectPermissions` is absent from the expression context the
 * front end builds, so any expression reading it is false for everybody. The
 * bisect that established that is written up in
 * `release-lead.command-menu-item.ts`.
 *
 * Availability is deliberately *not* conditioned on the licence, the cap, or
 * whether a provider is configured. The command menu cannot read app variables
 * or key-value storage, so any such condition would be a guess — and a command
 * that quietly disappears teaches an admin nothing, whereas one that answers
 * "enrichment is not included in this licence" tells them exactly what to do.
 * Every one of those states is a sentence in the panel.
 */
export default defineCommandMenuItem({
  universalIdentifier: ENRICH_LEAD_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  label: 'Enrich now (Greenlight)',
  shortLabel: 'Enrich now',
  availabilityType: 'RECORD_SELECTION',
  availabilityObjectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
  frontComponentUniversalIdentifier:
    ENRICH_LEAD_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  conditionalAvailabilityExpression: numberOfSelectedRecords === 1,
});
