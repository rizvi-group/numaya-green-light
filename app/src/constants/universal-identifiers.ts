export const APP_DISPLAY_NAME = 'Numaya Greenlight';
export const APP_DESCRIPTION = 'Lead quality gate for Twenty CRM. Deterministic scoring plus optional AI and search enrichment.';
export const APPLICATION_UNIVERSAL_IDENTIFIER = '3b81b402-96bd-4ad5-b20a-21224b3d546c';
export const DEFAULT_ROLE_UNIVERSAL_IDENTIFIER = 'be5458e4-97de-4ae2-9d18-b1c5bc9cd767';
/**
 * Retired: the scaffolded app "main page".
 *
 * `yarn twenty dev:add` seeds every new app with a front component that says
 * "Was installed successfully. You can now add content to your app." above three
 * cards of links into docs.twenty.com — CUSTOM OBJECT, LOGIC FUNCTION, WIDGETS.
 * That page was never replaced, and it shipped at sidebar position -1, i.e.
 * above every real Greenlight surface, so it was the first thing a new user
 * clicked and it handed a salesperson an app-developer tutorial.
 *
 * It is not replaced with a Greenlight home page because there is nothing left
 * for one to do: the ICP page is the onboarding entry point, and Configuration,
 * the audit log and the six queues each already carry their own sidebar entry.
 * An empty shell above all of them is worse than no entry at all.
 *
 * The identifiers stay here, unused, for the same reason every other value in
 * this file is permanent: a workspace that installed an earlier build still has
 * these entities recorded against these ids, and reusing one for something else
 * would graft new meaning onto old rows. Never assign these to a new entity.
 */
export const RETIRED_UNIVERSAL_IDENTIFIERS = {
  mainPageFrontComponent: '4b385d65-bde7-4835-a377-304ad501474c',
  mainPageLayout: 'cfb6e694-88b3-4fa2-8015-aca06e8932b4',
  mainPageLayoutTab: 'cbf26396-ab4a-4013-a1b5-740dd96e6324',
  mainPageWidget: '2e3fb526-b637-49cf-a51c-17d166538d48',
  mainPageNavigationMenuItem: 'e687fd0d-f671-42ca-a721-83fbcc91daab',
} as const;

// Application variables — Configuration Layer 1.
// These identifiers are permanent: changing one orphans the stored value in
// every workspace that already has the app installed.
export const APP_VARIABLE_UNIVERSAL_IDENTIFIERS = {
  USE_TWENTY_AI: 'a61121b2-4113-41d6-a62f-d47d9ad1c2a7',
  LLM_BASE_URL: 'ead4a4b5-31a4-4821-bcdd-e96a80161907',
  LLM_API_KEY: 'dd7cd719-ea8c-4c85-b8f0-f3401423c404',
  LLM_MODEL: 'e5eb22ef-d1d5-45e0-800c-b66267a17c74',
  SEARCH_PROVIDER: 'dd4d5550-8178-48c1-b7e5-4c055e99c359',
  SEARCH_API_KEY: 'cafbbf6e-c682-4abe-ae08-10f795a70e0d',
  // Added with the SearXNG adapter. Only that provider reads it — Brave and
  // Serper are hosted at addresses this app already knows, so a base URL is
  // meaningless to them, and a self-hosted instance has no address it could
  // possibly know. Appending a variable is safe; the eight above it keep their
  // identifiers and every workspace keeps its stored values.
  SEARCH_BASE_URL: '784d8c5a-02d0-471b-ae30-fe586d629b18',
  MONTHLY_ENRICHMENT_CAP: '3dba836a-c7fe-4b87-a284-52fae3f3c014',
  LICENCE_KEY: 'a9d0f94f-3866-46ca-9c8b-d14d3f905a10',
} as const;

// ---------------------------------------------------------------------------
// Data model — Configuration Layers 2 and 3, the audit trail, and the score /
// gate fields we graft onto the standard lead-bearing object.
//
// Same permanence rule as above, only worse: a changed object or field
// identifier orphans *records*, not just a setting. Never edit a value here.
// Adding is fine; removing or renaming a key is a breaking schema change.
// ---------------------------------------------------------------------------

export const GREENLIGHT_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER =
  'ba224b5a-f895-4127-bdc6-0a8709613bc0';

export const GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS = {
  name: '263baf57-a852-43a1-b8e6-69197661807e',
  isGateEnabled: 'da7a24ab-0ba5-49cb-90e3-8c194fe19f98',

  // Layer 2 — ICP
  icpIndustries: '3789056f-8798-4ca1-a3d6-55b38b2ce453',
  icpRegions: '55073dd1-28db-44b6-a25a-ab93d1c9308f',
  icpSizeBands: '8f8af2f5-69da-45fe-bcff-4418bff5e7a6',

  // Layer 2 — rules and weights
  ruleSettings: 'a620296c-3924-4549-ad25-d30d4cf16dd3',
  scoreWeights: 'a3336869-fdf8-4bb4-8480-c6ef39b1613d',

  // Layer 2 — bands and the gate
  bandExcellentThreshold: '2be16770-ea53-480d-a17b-4112cd7168af',
  bandGoodThreshold: 'd7b99e99-1f19-422b-a8af-025a589d07e6',
  bandFairThreshold: 'e1f52ab2-667c-47d1-a215-af29c5c3aa0b',
  gateThreshold: 'fdc811bd-fc8f-40e1-a9fb-a4181f251993',

  // Layer 2 — caching
  defaultShelfLifeDays: '6967aaa9-ce67-4005-87b6-69407e7fd4a1',
  fieldShelfLives: '134dc2e4-4106-4659-b54f-a6e9336344b6',

  // Layer 3 — field mapping
  leadObjectNameSingular: 'b296545b-3d2b-4002-986e-70b18b4a0b59',
  decisionMakerFieldName: 'd209d84f-3b8e-4b1e-94b5-5b74ff2235d6',
  decisionMakerMatchValues: '7de369bd-b97f-4972-89d7-5a2be90f65df',
  readyForOutreachFieldName: '527489d0-d3bf-40ac-9a0e-0cb04394ecc7',
  readyForOutreachValue: '09bad187-7969-4b9c-95ec-4325db7797b3',
  optOutFieldNames: '55b6b8e7-a27d-4a91-9d1d-82e80367a68d',
} as const;

export const GREENLIGHT_AUDIT_LOG_OBJECT_UNIVERSAL_IDENTIFIER =
  'dcf2dd2b-691a-4da9-98d4-2ded52c03b92';

export const GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS = {
  name: '4e3e31f7-88ee-445c-9142-1b1ade0403c0',
  eventType: 'f1505139-832a-4883-8e4a-57e1f0889417',
  occurredAt: 'fbc0e556-8a35-495c-a74e-77c8bb176abb',

  // Polymorphic pointer at the scored record — see the object file for why this
  // is not a relation.
  leadObjectNameSingular: 'fde51183-b199-4852-b9be-6507d592197e',
  leadRecordId: '0ac1e94e-e060-4e24-9108-da5cb781a307',
  leadDisplayName: 'f49bbf33-9612-41b2-b97a-d8fbeccddb1d',

  actorType: '1a00504e-be6c-4211-a122-edc980d48736',
  actorDisplayName: '853752a4-ca53-4d4e-b299-e54088b1abfc',

  ruleTrace: '27f8fc24-303c-4a6a-a729-aaec2a261390',
  score: '0b776fea-932e-4c82-97e8-1ce432b46d61',
  band: 'e883031b-0ef6-4d12-9c1a-5a21df71c46f',
  decision: 'f4ed9cca-3f2e-4c22-b856-17fccb79643d',
  overrideReason: '64462690-d0b0-4e76-8984-450eb85946d3',
  traceId: '2a83c615-1f33-4fe2-8bc7-095ccc59aaa5',
} as const;

// Score / gate fields grafted onto the standard lead-bearing object (Person in
// v0.1 — see src/fields/README rationale in greenlight-score.field.ts).
export const LEAD_SCORE_FIELD_UNIVERSAL_IDENTIFIERS = {
  greenlightScore: '6c3cf523-dec9-48b5-9532-d1f9d0d5a082',
  greenlightDecision: '50e07b62-2295-42ed-8680-75744ca357d2',
  greenlightTrace: '6cc0f853-5b8a-4066-a849-bb9f0d0ec16b',
} as const;

/**
 * Suppression / block-list fields, also grafted onto the lead-bearing object.
 *
 * Kept in their own constant rather than folded into the score identifiers above
 * because the two sets have opposite ownership. The score fields are engine
 * output and are read-only in the UI; these four are **human-maintained input**
 * and are deliberately UI-editable — see `src/fields/greenlight-suppressed.field.ts`.
 *
 * They exist because Twenty ships no email management at all: no unsubscribe
 * handling, no bounce tracking, no do-not-contact list. Before these fields the
 * compliance rule read an opt-out flag through the customer's own field mapping,
 * which on a stock workspace resolves to nothing, so the one compliance check in
 * the product could never fire.
 */
export const LEAD_SUPPRESSION_FIELD_UNIVERSAL_IDENTIFIERS = {
  greenlightSuppressed: 'e41597b5-7918-4bf6-ba94-897b1c7a4a08',
  greenlightSuppressionReason: '7666cd33-648d-4bb3-8146-7a2a085ece1c',
  greenlightSuppressedAt: 'a8a2ed09-427c-4726-8a5e-aece04c00e57',
  greenlightSuppressionNote: '4f233ea9-28f4-4eda-99a6-481e6343310f',
} as const;

export const GREENLIGHT_CONFIG_VIEW_UNIVERSAL_IDENTIFIER =
  '4ceae7d1-347e-48cb-9a1d-7de69436d9e2';
export const GREENLIGHT_AUDIT_LOG_VIEW_UNIVERSAL_IDENTIFIER =
  '5a37b394-3050-4b8f-8194-ab937acf1874';

export const GREENLIGHT_CONFIG_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER =
  'c23f737c-3f60-4103-bc47-95c3e66ef956';
export const GREENLIGHT_AUDIT_LOG_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER =
  'c809f694-7b9e-4783-be1c-317737fd0c8f';

// View fields are syncable entities in their own right, so each column needs a
// stable identifier too — dropping one silently resets the user's column order.
export const GREENLIGHT_CONFIG_VIEW_FIELD_UNIVERSAL_IDENTIFIERS = {
  name: '53806ea1-80cf-4a44-be32-587073df9b5e',
  isGateEnabled: '4857ec63-e2eb-4283-9f69-7298bd9ef157',
  gateThreshold: '8ac6c4bf-c83d-4a4f-94b9-86d583e67074',
  leadObjectNameSingular: 'a2b7b8b0-cd13-402f-b2fa-576697897ac0',
  defaultShelfLifeDays: 'f6cc90d8-c2d2-4fd8-8596-d62c833493e1',
} as const;

export const GREENLIGHT_AUDIT_LOG_VIEW_FIELD_UNIVERSAL_IDENTIFIERS = {
  name: '1050ae0d-d062-46a6-a54a-80b5bc3b6786',
  occurredAt: '84bd973b-36db-4f58-87b6-823f8acb44a9',
  eventType: '383a393c-46da-42f6-ad8f-d31d60a9d61e',
  leadDisplayName: 'e757ba2f-0128-4bb6-bbbe-56b4539540e3',
  decision: '22b81fb2-fbcd-47c4-9365-3449bf2ff081',
  score: 'df4585f3-0747-482b-bfec-41767b902e66',
  band: 'cff37fb2-b6b7-4f4e-9d28-61bfc3bf7351',
  actorDisplayName: 'dc4081aa-582b-4aca-85d4-7796641b4936',
} as const;

// The audit log is only useful newest-first, so the view ships a sort. Sorts are
// syncable entities too and need their own permanent identifier.
export const GREENLIGHT_AUDIT_LOG_VIEW_SORT_UNIVERSAL_IDENTIFIER =
  '24d47dea-9516-4c60-b0dc-89ed8d6a4efd';

/**
 * Greenlight's columns in the **Person record page Fields panel**.
 *
 * ## The bug these fix
 *
 * `defineField` puts a field on Person's schema. It does not put it on Person's
 * record page. The Fields panel a rep reads is a `FIELDS_WIDGET` view —
 * "Person Record Page Fields" — and it renders only the view fields that view
 * holds, grouped into its four sections (General, Work, Social, System).
 * Confirmed against the live workspace rather than inferred: that view held
 * eighteen view fields and not one of them was a Greenlight field. So the app
 * wrote a score, a decision, a trace, four suppression fields and three
 * enrichment fields onto every Person, and none of them appeared on the record
 * a salesperson was looking at. The only place a score surfaced was a timeline
 * entry — "Numaya Greenlight updated 4 fields" — which nobody expands.
 *
 * A standalone `defineViewField` is how an app adds a column to a view it does
 * not own. Each one is a syncable entity, so each needs its own permanent
 * identifier, exactly like the view fields on the app's own views above.
 *
 * ## Why an existing section rather than a "Greenlight" one
 *
 * The SDK exposes no standalone way to add a *view field group*:
 * `ViewFieldGroupManifest` exists only nested inside `defineView`, which an app
 * cannot use against a view it does not own. So each field is assigned to one of
 * Twenty's four sections, and the assignment is by meaning:
 *
 *   - **General** — score, decision, and the four suppression fields. The verdict
 *     and "may we contact this person at all" are the first facts about a lead,
 *     and General is the section already open at the top of the record.
 *   - **Work** — the three enrichment fields. Enrichment is what Greenlight
 *     learned about the person's company and role, which is what Work holds.
 *   - **System** — the trace. It is diagnostic JSON, it is the one field a rep
 *     never needs, and System is where Twenty already keeps createdAt/updatedBy.
 *
 * Positions start at 100 so nothing renumbers a column the user already reads;
 * appending leaves the standard fields exactly where they are.
 */
export const PERSON_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS = {
  greenlightScore: '0b68d19a-9523-4c08-ae91-1330e47ee06e',
  greenlightDecision: '19177f8f-e067-4223-8d25-7f1e3088dc04',
  greenlightSuppressed: 'dbe452ac-96d6-49a5-bdbe-292e8fff20f3',
  greenlightSuppressionReason: '283ed7b6-4b9c-444d-b55c-14a068f7893c',
  greenlightSuppressionNote: '5d7c763f-1e05-4bd2-8810-6f6b4f230c39',
  greenlightSuppressedAt: 'b9b2c255-0cd2-4e07-b862-41710b160184',
  greenlightEnrichmentStatus: 'd435703c-a58f-4f46-b617-80ab0e21838d',
  greenlightEnrichedAt: 'd5e5e7c1-f1ce-4d57-b338-21cb1226f632',
  greenlightEnrichment: 'f9df4f58-36e7-49f7-8510-7fff3d04f97a',
  greenlightTrace: '94ed506e-ceb6-4462-8913-fcb65d2089d6',
} as const;
