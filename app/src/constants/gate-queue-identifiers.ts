/**
 * Universal identifiers for the gate queue and the human override — the
 * ARCHITECTURE.md "Path 4: Lead Override (Human Review)" surface.
 *
 * Same permanence rule as `src/constants/universal-identifiers.ts`: every value
 * here is written into the customer's workspace at install time. Changing one
 * does not rename an entity, it orphans the old one and creates a new one — a
 * user's column widths, sort and sidebar position silently reset. Adding is
 * safe; editing or removing is a breaking change.
 *
 * These live in their own file rather than in `universal-identifiers.ts` purely
 * so the gate-queue surface can be developed without touching the data-model
 * constants that the scoring engine and the schema objects depend on.
 */

/* -------------------------------------------------------------------------- */
/* Gate queue — the leads a human has to judge                                 */
/* -------------------------------------------------------------------------- */

export const GATE_QUEUE_VIEW_UNIVERSAL_IDENTIFIER =
  '09ba374e-5b2b-42db-8aa5-0029bd2e051f';

export const GATE_QUEUE_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER =
  '864dd25a-b6a2-44be-b59a-b1e505c3bf8e';

export const GATE_QUEUE_VIEW_FILTER_UNIVERSAL_IDENTIFIER =
  '2b32b3d7-bf02-4663-9687-25f6237002d3';

export const GATE_QUEUE_VIEW_SORT_UNIVERSAL_IDENTIFIER =
  'f8951745-619e-4b5e-b42d-ee2935a30821';

export const GATE_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS = {
  name: 'd56b3545-b95b-44da-9781-74d2b75c0065',
  greenlightScore: 'fca48afc-94b1-4d8a-80d6-a2c604b661fa',
  greenlightDecision: '8200f88b-5e4b-4edb-99e1-5cdb85625aa1',
  jobTitle: 'd9b0d26f-79df-4a7d-8ecc-4413db87952a',
  company: '4b765b33-dd7f-442a-97c8-91eeeb616a42',
  emails: '9a4e2ef4-e774-4716-9222-33fcbd0154ef',
  createdAt: '8247c042-c969-4f8b-a761-2e8ee4fc7bcd',
} as const;

/* -------------------------------------------------------------------------- */
/* Unscored queue — the leads the engine failed open on                        */
/* -------------------------------------------------------------------------- */

export const UNSCORED_QUEUE_VIEW_UNIVERSAL_IDENTIFIER =
  '31243a13-11a6-4000-8b3e-195031808425';

export const UNSCORED_QUEUE_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER =
  '54943a27-cbf6-41f8-92fa-b848d7a348f7';

export const UNSCORED_QUEUE_VIEW_FILTER_UNIVERSAL_IDENTIFIER =
  'a79d3182-44e2-4feb-8ecb-22081c89e2a8';

export const UNSCORED_QUEUE_VIEW_SORT_UNIVERSAL_IDENTIFIER =
  '487d8c98-7232-4f82-8495-14b980bff1a2';

export const UNSCORED_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS = {
  name: 'b0fedd30-f6fb-4309-ae4c-cc8a8e795d9e',
  greenlightDecision: 'e16b0c6f-599c-4962-90ba-38e8ca87e8f3',
  greenlightScore: '2c61b772-b3d8-4bd7-b58a-ea84e7775f22',
  company: '94bfea98-6ec1-4826-a0af-c63c16bb02a3',
  createdAt: '5e6892c9-2186-4894-9fa1-de88721dc2ff',
  updatedAt: '51ae2440-5921-421e-aeb3-f0bdfd57efce',
} as const;

/* -------------------------------------------------------------------------- */
/* Compliance-blocked queue — the leads a rep must not call                    */
/* -------------------------------------------------------------------------- */

export const BLOCKED_QUEUE_VIEW_UNIVERSAL_IDENTIFIER =
  '116ab2bc-074f-49b1-98cd-dc15e2d4f423';

export const BLOCKED_QUEUE_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER =
  '819393c2-dcab-4b7b-a0f5-02ec4206c105';

export const BLOCKED_QUEUE_VIEW_FILTER_UNIVERSAL_IDENTIFIER =
  '7b0406b7-d46b-4bb5-9045-f97c7a3d920d';

export const BLOCKED_QUEUE_VIEW_SORT_UNIVERSAL_IDENTIFIER =
  'fdd064dc-e6be-40fc-b87d-afa04290e275';

export const BLOCKED_QUEUE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS = {
  name: 'e3540759-1b28-4c2f-bef4-d00cdc2d4370',
  greenlightDecision: 'c30b0b2e-1baf-47b3-8e25-c73f437d38cd',
  greenlightScore: '73b638bd-a0d1-46b0-924f-b9ad32941ed4',
  company: '2e287ba3-a58f-4f96-bba2-21b926fa686f',
  emails: '44272c90-b26f-4e6d-b205-a4df7539836a',
  updatedAt: '68a75ac6-5900-4ab3-9dfb-0e1a1947239c',
  // Appended: the view used to say only *that* a lead was blocked. "Why, and
  // since when" is the question anyone auditing the list actually asks.
  greenlightSuppressionReason: '72ba174f-cdab-4bc5-97b4-b68224de0829',
  greenlightSuppressedAt: 'e4fbb8db-d634-4730-ba9d-42c48714ed5e',
} as const;

/* -------------------------------------------------------------------------- */
/* Suppression list — everyone Greenlight is refusing to contact               */
/* -------------------------------------------------------------------------- */

export const SUPPRESSION_LIST_VIEW_UNIVERSAL_IDENTIFIER =
  'da0e90cd-6a75-474b-9386-25a54485b8b6';

export const SUPPRESSION_LIST_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER =
  'c945216d-d6d2-4026-94de-fcfe51475661';

export const SUPPRESSION_LIST_VIEW_FILTER_UNIVERSAL_IDENTIFIER =
  '8cbb2f41-9bac-4e5f-b8f7-75868c0d9174';

export const SUPPRESSION_LIST_VIEW_SORT_UNIVERSAL_IDENTIFIER =
  '9fab9e4c-4c9e-487f-914e-cdf172edace8';

export const SUPPRESSION_LIST_VIEW_FIELD_UNIVERSAL_IDENTIFIERS = {
  name: '47a5e99b-4c65-4f2d-878c-1ecb907599cf',
  greenlightSuppressionReason: '68eb83c6-f68f-4677-955c-b29e5b2435f9',
  greenlightSuppressedAt: '6dd94606-a8e7-46e5-9cc9-f5b5b45a2bcc',
  greenlightSuppressionNote: '1f3be7ca-beaf-4f47-9af2-72c5721018dd',
  emails: '0b13ae97-0451-495d-bdb1-4c4ccf897ad9',
  company: '419019f6-bfcc-4f7c-8c57-27ea2d8f9c54',
  greenlightDecision: '08567499-13ed-4541-9853-4c91a73ee976',
} as const;

/* -------------------------------------------------------------------------- */
/* Override action — command menu item -> front component -> logic function    */
/* -------------------------------------------------------------------------- */

export const RELEASE_LEAD_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER =
  '0d3a5c2f-0f16-470a-bc58-e95995f4b6dd';

export const RELEASE_LEAD_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER =
  '12cff52f-5473-487b-a8f1-afa145c9ac79';

export const RELEASE_LEAD_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER =
  '8173aab9-2c24-4351-bb32-26022b70161b';

/**
 * HTTP route the override logic function listens on. The front component posts
 * to this path prefixed with `/s`, which is how `RestApiClient` recognises an
 * app route rather than a core REST call.
 *
 * Declared once, here, because a mismatch between the two sides is a 404 that
 * only shows up at runtime in a live workspace.
 */
export const RELEASE_LEAD_ROUTE_PATH = '/greenlight/release-lead';
export const RELEASE_LEAD_CLIENT_PATH = `/s${RELEASE_LEAD_ROUTE_PATH}`;

/* -------------------------------------------------------------------------- */
/* Suppression actions — add to and remove from the block list                 */
/* -------------------------------------------------------------------------- */

/**
 * Two actions rather than one toggle, and that is a deliberate cost.
 *
 * A single "manage do-not-contact" panel would be less code and one fewer
 * command in the menu. It would also make adding and removing a suppression the
 * same gesture, and they are not the same gesture: adding one stops outreach,
 * removing one *re-enables contact with someone who is on record asking us not
 * to*. Separate commands mean separate labels, separate confirmation copy, and
 * separate audit event types, so the sensitive one can never be reached by
 * muscle memory aimed at the safe one.
 */
export const SUPPRESS_LEAD_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER =
  'c5b4efd8-4471-4ec6-8f94-a013115598ef';

export const SUPPRESS_LEAD_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER =
  'b0a557fb-8ae2-4acb-81f6-1f5c70f1d0e0';

export const SUPPRESS_LEAD_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER =
  'df3f5e55-74bd-4b5c-96a0-87be363d622d';

export const UNSUPPRESS_LEAD_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER =
  '48eeda6a-2f2e-4892-8377-2efd0e460d43';

export const UNSUPPRESS_LEAD_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER =
  '75d0a79c-c6fc-497c-979c-b59181af88c9';

export const UNSUPPRESS_LEAD_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER =
  'c5e5f193-ecdc-4e33-aff0-0cfd1d9f6b70';

export const SUPPRESS_LEAD_ROUTE_PATH = '/greenlight/suppress-lead';
export const SUPPRESS_LEAD_CLIENT_PATH = `/s${SUPPRESS_LEAD_ROUTE_PATH}`;

export const UNSUPPRESS_LEAD_ROUTE_PATH = '/greenlight/unsuppress-lead';
export const UNSUPPRESS_LEAD_CLIENT_PATH = `/s${UNSUPPRESS_LEAD_ROUTE_PATH}`;
