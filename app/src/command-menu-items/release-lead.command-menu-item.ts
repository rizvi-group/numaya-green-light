import {
  defineCommandMenuItem,
  numberOfSelectedRecords,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  RELEASE_LEAD_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  RELEASE_LEAD_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/gate-queue-identifiers';

/**
 * "Release lead" — the entry point to ARCHITECTURE.md Path 4.
 *
 * Scoped to Person because that is where v0.1 physically ships the gate fields.
 * Offered on record selection so it is reachable both from a record page and
 * from a row selected in the gate queue.
 *
 * The availability expression does two things:
 *
 *   - `numberOfSelectedRecords === 1` — the override is a per-lead human
 *     decision. Hiding the command for multi-selects is the cheapest way to
 *     stop a bulk release from ever being attempted; the panel refuses too, but
 *     an action that never appears is better than one that appears and refuses.
 *
 * ## Why there is no `objectPermissions` clause
 *
 * There was one — `everyEquals(objectPermissions, 'canUpdateObjectRecords',
 * true)`, exactly the guard Twenty's own command-menu-item documentation
 * recommends for a `RECORD_SELECTION` action. It made all four of Greenlight's
 * record actions invisible in the UI, on every page, for a workspace owner with
 * full permissions on Person.
 *
 * Bisected against the live 2020 dev server on 2026-08-04 by installing probe
 * command menu items through the metadata API and reading the command menu:
 *
 *   no expression                                                → visible
 *   numberOfSelectedRecords == 1                                 → visible
 *   everyEquals(objectPermissions, 'canUpdateObjectRecords', …)  → HIDDEN
 *   everyEquals(objectPermissions, 'canReadObjectRecords', …)    → HIDDEN
 *   objectPermissions != null                                    → HIDDEN
 *   everyEquals(objectPermissions, …) or true                    → visible
 *
 * The last two lines are the diagnosis. The expression parses and evaluates —
 * it does not throw, or the `or true` form would have been hidden too — and
 * `objectPermissions != null` is false, so `objectPermissions` is simply absent
 * from the evaluation context the front end builds. Any expression that reads
 * it is therefore false for everyone, regardless of their actual permissions.
 *
 * Dropping the clause loses nothing real. It was always documented here as a
 * UI-level courtesy rather than a security boundary: the logic function performs
 * the write under the app's own role, and it is Twenty's RBAC on that role, not
 * this expression, that decides what is permitted. A guard that hides the action
 * from *everybody* is not a weaker guard, it is a broken feature.
 *
 * Note that availability is deliberately *not* conditioned on the lead actually
 * being gated. The command menu cannot read a field value on the selected
 * record, and inventing a client-side guess would give a rep a command that
 * appears to work and quietly does nothing. Instead the logic function answers
 * honestly for every state — already released, never held, blocked — and the
 * panel reports what it said.
 */
export default defineCommandMenuItem({
  universalIdentifier: RELEASE_LEAD_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER,
  label: 'Release lead (Greenlight)',
  shortLabel: 'Release lead',
  availabilityType: 'RECORD_SELECTION',
  availabilityObjectUniversalIdentifier:
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
  frontComponentUniversalIdentifier:
    RELEASE_LEAD_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  conditionalAvailabilityExpression: numberOfSelectedRecords === 1,
});
