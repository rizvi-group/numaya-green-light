/**
 * Universal identifiers and route paths for the ICP review surface — the thing
 * that tells an admin their ideal-customer profile is empty *before* they start
 * trusting the scores.
 *
 * Same permanence rule as the other four constant files: every value here is
 * written into the customer's workspace at install time, so changing one does
 * not rename an entity, it orphans the old one and mints a second alongside it.
 * Adding is safe; editing is a breaking change.
 *
 * A fifth constants file rather than a section in one of the others, for the
 * reason the third and fourth exist: so this workstream can add entities without
 * touching a file another workstream is editing.
 * `src/icp/__tests__/icp-identifiers.test.ts` runs the uniqueness guard across
 * all five files at once, which is the failure mode splitting them introduces.
 */

/* -------------------------------------------------------------------------- */
/* Logic function                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One authenticated route behind the whole surface: read the inert state,
 * derive a proposal from the workspace's own data, preview what applying it
 * would do, apply it, or record that the workspace deliberately left the profile
 * open.
 *
 * A route rather than a cron for the same reason as the backfill control: these
 * are things a human does at a moment of their choosing, and the panel needs a
 * synchronous answer to render.
 */
export const ICP_REVIEW_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER =
  '4364eab9-7644-4896-9fca-888812048a09';

/* -------------------------------------------------------------------------- */
/* Admin surface                                                               */
/* -------------------------------------------------------------------------- */

export const ICP_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER =
  '76ed6b40-14dc-43d8-afbb-3403d923516e';

export const ICP_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER =
  '30d6de66-6bb7-44b6-9337-1994e512d701';

/**
 * The sidebar entry, and the standalone page it opens.
 *
 * A page rather than only a command menu item because a command menu item has
 * to be searched for, and nobody searches for a problem they do not know they
 * have. The whole defect is that the inert ICP is invisible; a surface you must
 * already suspect exists does not fix an invisibility bug.
 */
export const ICP_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER =
  '58ef8728-89b9-47a8-9090-159c11b53e28';

export const ICP_PAGE_LAYOUT_UNIVERSAL_IDENTIFIER =
  '97e2ff47-d59c-477a-ace1-74fd0f03b591';

export const ICP_PAGE_LAYOUT_TAB_UNIVERSAL_IDENTIFIER =
  '069e0b7d-fdfa-4f75-87de-f5b79d742ab1';

export const ICP_PAGE_WIDGET_UNIVERSAL_IDENTIFIER =
  'c7478dec-4b20-453a-93e6-a4e243194e37';

/* -------------------------------------------------------------------------- */
/* New GreenlightConfig fields                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Two fields, and they answer one question the config record could not answer
 * before: *has a human ever decided this?*
 *
 * An empty `icpIndustries` list is ambiguous today. It means either "nobody has
 * ever looked at this" or "we sell to everyone and left it open on purpose", and
 * those two are the difference between a broken install and a correct one. The
 * shipped permissive default is right; what was missing is any record of whether
 * it was *chosen*. Without that, a warning surface can only nag forever, and a
 * warning that cannot be answered is a warning people learn to ignore.
 *
 * Declared here rather than in `universal-identifiers.ts` alongside the other
 * `GreenlightConfig` fields purely to keep this workstream out of a shared file;
 * they are ordinary fields on that object and nothing else about them is special.
 */
export const GREENLIGHT_CONFIG_ICP_REVIEW_FIELD_UNIVERSAL_IDENTIFIERS = {
  icpReviewedAt: '80a3be71-f484-4a67-9ff9-6c68539bee24',
  icpReviewDecision: '28562f63-9d60-4048-9c91-5117eca9c8bf',
} as const;

/** SELECT values for `icpReviewDecision`. Identity derives from the value. */
export const ICP_REVIEW_DECISION_VALUES = {
  notReviewed: 'NOT_REVIEWED',
  applied: 'APPLIED',
  leftOpen: 'LEFT_OPEN',
} as const;

/* -------------------------------------------------------------------------- */
/* HTTP route                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Same two-constant shape as the gate-queue and backfill routes: the front
 * component posts to the `/s`-prefixed path, which is how `RestApiClient`
 * recognises an app route rather than a core REST call, and declaring both here
 * means a mismatch is a test failure rather than a 404 found in a live workspace.
 */
export const ICP_ROUTE_PATH = '/greenlight/icp';
export const ICP_CLIENT_PATH = `/s${ICP_ROUTE_PATH}`;
