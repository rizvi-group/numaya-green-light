/**
 * Permanent identifiers, storage keys and endpoint shapes for Path 2 —
 * enrichment.
 *
 * Same permanence rule as `universal-identifiers.ts`, `gate-queue-identifiers.ts`
 * and `backfill-identifiers.ts`: every UUID here is written into the customer's
 * workspace at install time, so changing one orphans the old entity rather than
 * renaming it. Adding is safe; editing or removing is a breaking schema change.
 *
 * They live in their own module for the same reason the other three do — so a
 * workstream can add entities without colliding in a file someone else is
 * editing. `src/enrichment/__tests__/enrichment-identifiers.test.ts` is the guard
 * that a *cross-file* collision cannot slip through the split.
 */

/* -------------------------------------------------------------------------- */
/* Agents — the Twenty-native reasoning path                                   */
/* -------------------------------------------------------------------------- */

/**
 * Two agents rather than one, and the split is the model-routing lever.
 *
 * `runAgent` (the only way an app reaches Twenty's own AI — see
 * `src/logic-functions/enrich-reasoning-client.ts` for the evidence) takes an
 * agent identifier, and `AgentManifest` carries an optional `modelId`. Declaring
 * one agent for extraction and one for verification is therefore the only way
 * the Twenty path can honour PRODUCT_SPEC's "cheap for verification, capable for
 * briefings" cost control at all: an admin points the verifier at a cheap model
 * in Twenty's own settings and the extractor at whatever the workspace uses for
 * real work.
 *
 * Neither manifest hard-codes a `modelId`. A model name is a per-workspace,
 * per-vendor string that we cannot know at build time, and shipping a guess
 * would mean every enrichment run failing on a workspace whose provider does not
 * publish that name. Unset means "the workspace default", which always resolves.
 */
export const ENRICHMENT_EXTRACTOR_AGENT_UNIVERSAL_IDENTIFIER =
  '9da8df23-1560-447a-a7c3-ff87179987a6';

export const ENRICHMENT_VERIFIER_AGENT_UNIVERSAL_IDENTIFIER =
  '4dbb0eb6-8695-47a0-9ba6-d169eaf6018d';

/* -------------------------------------------------------------------------- */
/* Logic functions                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The event-triggered run: fires when the scoring run writes a decision.
 *
 * ARCHITECTURE.md's trigger is "lead passed the deterministic gate OR an admin
 * explicitly requests enrichment". `greenlightDecision` is written by
 * `scoring-run.ts` at the end of every scored run, so a `person.updated` trigger
 * narrowed to that one field is exactly "the gate has just reached a verdict" —
 * expressed in the platform's own vocabulary rather than re-derived here.
 */
export const ENRICH_LEAD_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER =
  '7d042340-2553-48c5-a23d-fc36ebde9760';

/** The admin-requested run, behind the command menu item. */
export const ENRICH_LEAD_REQUEST_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER =
  'ff72c51c-ad2e-4d07-abaa-14d11809b2a6';

export const ENRICH_LEAD_REQUEST_ROUTE_PATH = '/greenlight/enrich-lead';

/**
 * What a front component calls. Twenty serves app HTTP routes under `/s`, so the
 * client path is the route path with that prefix — derived rather than written
 * twice, and asserted in the identifier test.
 */
export const ENRICH_LEAD_REQUEST_CLIENT_PATH = `/s${ENRICH_LEAD_REQUEST_ROUTE_PATH}`;

/* -------------------------------------------------------------------------- */
/* Fields — enriched-value provenance                                          */
/* -------------------------------------------------------------------------- */

/**
 * Three fields on Person, all engine-owned and all read-only in the UI.
 *
 * The shape argument is in `src/fields/greenlight-enrichment.field.ts`; the short
 * version is that enriched values are a **separate, lower-trust tier** that never
 * lands in a human's column, so provenance travels with the value instead of
 * being bolted onto it afterwards.
 */
export const ENRICHMENT_FIELD_UNIVERSAL_IDENTIFIERS = {
  greenlightEnrichment: '42cd17bf-9a88-4f12-bf58-9822f7229c55',
  greenlightEnrichedAt: '2f1efb43-c761-4009-82b6-55252b3f75ea',
  greenlightEnrichmentStatus: '9ff395cc-6508-4d94-8e02-fd9f3157063f',
} as const;

/* -------------------------------------------------------------------------- */
/* Admin surface                                                               */
/* -------------------------------------------------------------------------- */

export const ENRICHED_LEADS_VIEW_UNIVERSAL_IDENTIFIER =
  '03fb7d01-7e80-4008-8aa8-e84ac7269aab';
export const ENRICHED_LEADS_VIEW_FILTER_UNIVERSAL_IDENTIFIER =
  '5cdd21c5-053a-47bc-af90-591a316be51c';
export const ENRICHED_LEADS_VIEW_SORT_UNIVERSAL_IDENTIFIER =
  'fcfa4a92-32e2-4c03-9f20-6f5f92f49265';

export const ENRICHED_LEADS_VIEW_FIELD_UNIVERSAL_IDENTIFIERS = {
  name: '1577a068-2bb2-4f62-8819-d600546ea832',
  greenlightEnrichmentStatus: '879abe3a-b330-4ac1-81fa-8c41820bdb7a',
  greenlightEnrichedAt: '695c1f08-7210-48ee-a944-9d80b4133d1f',
  greenlightScore: '59513b16-12f3-4212-8bdf-eed48c55ba90',
  company: '96e13546-5be7-4ab6-afdc-cf077bf6d67d',
  jobTitle: 'bd3a1f00-a2af-47ae-bc4e-40db49c0d458',
} as const;

export const ENRICHED_LEADS_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER =
  '3c72cbc5-7268-4e7a-8ca0-8fef22a793b2';

export const ENRICH_LEAD_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER =
  'e30bda87-1ba7-434e-b2c9-11754b3bc7e8';
export const ENRICH_LEAD_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER =
  '0b12c057-9ca4-4d9a-b5ef-337583ec31ae';

/* -------------------------------------------------------------------------- */
/* App key-value storage                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `scope: 'WORKSPACE'` on every key below, and it is not a detail — it is the
 * spend cap.
 *
 * PRODUCT_SPEC requires a **per-tenant** cap. A counter read under the wrong
 * scope silently returns `null`, which reads as "nothing spent this month" and
 * would hand every workspace an unlimited budget while the code that was
 * supposed to stop it looks correct. The same failure on the breaker key would
 * mean a dead provider is retried on every lead forever.
 */
export const ENRICHMENT_BUDGET_KV_KEY = 'greenlight.enrichment.budget';

/** Per-provider circuit-breaker state. One record, keyed by provider name. */
export const ENRICHMENT_BREAKER_KV_KEY = 'greenlight.enrichment.breaker';

/**
 * Whether this workspace's Twenty AI is usable, and when we last checked.
 *
 * There is no metadata query that answers "does this workspace have AI
 * configured" — see `src/enrichment/providers.ts`. The answer is therefore
 * *learned* from a failed `runAgent` call and cached here, so a workspace with
 * no AI configured pays the probe once per TTL instead of once per lead.
 */
export const ENRICHMENT_TWENTY_AI_KV_KEY = 'greenlight.enrichment.twenty-ai';

/* -------------------------------------------------------------------------- */
/* Provider endpoints                                                          */
/* -------------------------------------------------------------------------- */

/** Brave Search's web endpoint. Key travels in `X-Subscription-Token`. */
export const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

/** Serper's Google endpoint. Key travels in `X-API-KEY`. */
export const SERPER_SEARCH_ENDPOINT = 'https://google.serper.dev/search';

/**
 * SearXNG's search path, appended to the customer's `SEARCH_BASE_URL`.
 *
 * A path and not an endpoint, and that is the whole difference between this
 * provider and the two above it. Brave and Serper are hosted services whose
 * address is a fact about the vendor, so it belongs in the source. SearXNG is
 * something the customer runs; its address is a fact about *their* estate, which
 * we cannot know and must not guess, so it is an application variable and only
 * the path is a constant.
 *
 * There is no API key line to write here because there is no API key. That is
 * the point of the provider.
 */
export const SEARXNG_SEARCH_PATH = '/search';

/** Path appended to `LLM_BASE_URL` for the OpenAI-compatible fallback. */
export const OPENAI_COMPATIBLE_CHAT_PATH = '/chat/completions';
