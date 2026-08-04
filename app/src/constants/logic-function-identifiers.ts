/**
 * Permanent identifiers for Greenlight's logic functions.
 *
 * Same permanence rule as `universal-identifiers.ts`: a logic function's
 * `universalIdentifier` is how Twenty recognises an existing registration across
 * upgrades. Change one and the workspace gets a *second* function registered
 * alongside the old one — for a database-event trigger that means every Person
 * event is handled twice, and every scored lead gets two audit rows. Never edit
 * a value in this file. Adding is fine.
 *
 * These live apart from `universal-identifiers.ts` purely so two workstreams can
 * add entities without fighting over the same file.
 */

export const POST_INSTALL_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER =
  'feb529fe-4048-49cd-a304-bef009952699';

export const UNINSTALL_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER =
  '4219d61c-c663-44d3-9978-758f89862ece';

/**
 * Scoring is registered twice because `databaseEventTriggerSettings.eventName`
 * is a single string, not a list — see `score-person-created.logic-function.ts`
 * for why two narrow registrations beat one `person.*` wildcard.
 */
export const SCORE_PERSON_CREATED_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER =
  '03736f42-ea80-4de7-9ae1-1264cc1adad0';

export const SCORE_PERSON_UPDATED_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER =
  'f3d817a4-806b-488a-9707-1988c58acee7';
