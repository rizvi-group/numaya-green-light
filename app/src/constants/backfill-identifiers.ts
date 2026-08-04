/**
 * Universal identifiers and durable keys for the backfill — the surface that
 * scores the leads which already existed when Greenlight was installed.
 *
 * Same permanence rule as `src/constants/universal-identifiers.ts` and
 * `src/constants/gate-queue-identifiers.ts`: every value here is written into
 * the customer's workspace at install time. Changing one does not rename an
 * entity, it orphans the old one and creates a second one alongside it — and for
 * a **cron** logic function that means two schedulers draining the same queue
 * against the same rate limit. Adding is safe; editing is a breaking change.
 *
 * A third constants file rather than a section in the second one, for the same
 * reason the second one exists: so the backfill can be developed without
 * touching a file the gate-queue and data-model workstreams are both editing.
 * `src/backfill/__tests__/backfill-identifiers.test.ts` runs the uniqueness
 * guard across all three files together, which is the failure mode splitting
 * them introduces.
 */

/* -------------------------------------------------------------------------- */
/* Logic functions                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The cron drain. One tick, one bounded chunk — see `BACKFILL_CHUNK_SIZE` in
 * `src/backfill/backfill-plan.ts` for the request arithmetic that sizes it.
 */
export const BACKFILL_CRON_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER =
  'cb419da0-360d-4539-90a7-18b9a95a87fc';

/**
 * The admin control surface: start, cancel, and read progress. An HTTP route
 * rather than a second cron because these are things a human does at a moment of
 * their choosing, and because the panel needs a synchronous answer to render.
 */
export const BACKFILL_CONTROL_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER =
  'b4ed46c6-db60-4994-b499-2257c3a0615b';

/* -------------------------------------------------------------------------- */
/* Admin surface — command menu item -> front component -> logic function       */
/* -------------------------------------------------------------------------- */

export const BACKFILL_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER =
  '31e867f6-c35f-415d-9bcd-014ba9e8b365';

export const BACKFILL_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER =
  'bf258f37-9673-4a8d-870f-fecc4ab44d43';

/**
 * HTTP route the control function listens on. Same two-constant shape as the
 * gate-queue actions: the front component posts to the `/s`-prefixed path, which
 * is how `RestApiClient` recognises an app route rather than a core REST call,
 * and declaring both here means a mismatch is a test failure rather than a 404
 * discovered in a live workspace.
 */
export const BACKFILL_ROUTE_PATH = '/greenlight/backfill';
export const BACKFILL_CLIENT_PATH = `/s${BACKFILL_ROUTE_PATH}`;

/* -------------------------------------------------------------------------- */
/* Never-scored view — the defect, made visible                                */
/* -------------------------------------------------------------------------- */

/**
 * Distinct from the existing "Greenlight Unscored (Failed Open)" view, and the
 * distinction is the whole bug report.
 *
 *   - `greenlightDecision = UNSCORED` means *the engine looked and could not
 *     score it*. That view is an error backlog.
 *   - `greenlightDecision` **empty** means *nothing has ever looked at it*.
 *     Before this feature existed there was no such view, so 1200 of 1205 people
 *     on a dev workspace sat in a state with no name and no surface, while the
 *     gate queue read empty — which looks exactly like "everything is clean".
 *
 * Collapsing the two into one view would have hidden the second inside the
 * first's error semantics. They are different questions with different answers.
 */
export const NEVER_SCORED_VIEW_UNIVERSAL_IDENTIFIER =
  'eff19c4d-408f-40f4-ab25-99b24658a191';

export const NEVER_SCORED_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER =
  '0b08bfea-6fc5-4219-ac28-d55775d36be5';

export const NEVER_SCORED_VIEW_FILTER_UNIVERSAL_IDENTIFIER =
  '4de7f659-091d-4fba-9488-4530b1a79ac0';

export const NEVER_SCORED_VIEW_SORT_UNIVERSAL_IDENTIFIER =
  '58b70c61-855c-4d4a-b824-91eed23c37c9';

export const NEVER_SCORED_VIEW_FIELD_UNIVERSAL_IDENTIFIERS = {
  name: '4b1f9d1c-3f13-4d36-913d-4a23b6a3895c',
  greenlightDecision: '4a6f7fc7-6a99-48be-9d52-af900b1a1900',
  emails: 'b7593fb9-d8fe-47b8-b0eb-6c84ef9c8d0a',
  company: '65fd67f1-da62-4b76-b64b-36933e03d02c',
  createdAt: '8d5e193c-dd82-46b6-b28b-9e1876a70f7f',
} as const;

/* -------------------------------------------------------------------------- */
/* Durable state keys                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Where the backfill's progress lives, in Twenty's app key-value storage.
 *
 * `scope: 'WORKSPACE'` is load-bearing and matches `release-marker-store.ts`:
 * progress is per-workspace, and a read under a different scope silently finds
 * nothing — which would read as "no backfill has ever run" and restart one.
 *
 * The key is versioned (`:v1`) because the stored shape is a contract between
 * releases. A future release that changes the state shape incompatibly bumps the
 * suffix rather than trying to migrate a half-finished run in place; the old key
 * is then simply an orphan, and an orphan is a much better failure than a run
 * that resumes against a cursor it no longer understands.
 */
export const BACKFILL_STATE_KEY = 'greenlight:backfill:state:v1';
