/**
 * Universal identifiers for the Greenlight Pipeline — the board, the fields the
 * board writes, and the standalone page it lives on.
 *
 * PIPELINE_SPEC.md states the defect this feature exists to close: the engine
 * scores, gates, enriches and explains, and then leaves the salesperson to work
 * out what to *do* about it across four separate surfaces. The pipeline is the
 * one surface that answers that question, so these identifiers describe the
 * app's primary working screen rather than another admin panel.
 *
 * ## Permanence
 *
 * Identical rule to the other five constant files, and it is not a style note.
 * Every value below is written into the customer's workspace at install time and
 * is how Twenty recognises an entity it has already seen. Changing one does not
 * rename anything — it orphans the entity that already exists and mints a second
 * one beside it. For a field that means the column the board has been writing to
 * for six weeks goes quiet and a fresh, empty column appears next to it, with no
 * error anywhere. **Never edit a value in this file. Adding is safe.**
 *
 * ## Why a sixth constants file
 *
 * The same reason the third, fourth and fifth exist: so a workstream can add
 * entities without touching a file another workstream is editing. That matters
 * more here than it has before, because the pipeline is being built by two
 * concurrent efforts — the metadata (this file, `src/fields`, `src/page-layouts`,
 * `src/navigation-menu-items`, `src/view-fields`) and the runtime
 * (`src/pipeline`, `src/logic-functions`, `src/front-components`).
 *
 * ## This file is the contract between those two efforts
 *
 * The front component does not exist yet. The page layout below still has to
 * point at it, and a page layout that points at a UUID nobody ever defines is a
 * blank widget rather than a build error, so the identifier has to be agreed
 * *before* either side writes its half. It is agreed here, once:
 *
 *   - `PIPELINE_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER` — the runtime workstream
 *     passes this to `defineFrontComponent`. It must not mint its own.
 *   - `NEXT_ACTION_KIND_VALUES` — the ranking in `src/pipeline/next-action.ts`
 *     must emit exactly these strings, because they are the SELECT's stored
 *     values. A typo there is a rejected write, not a wrong colour.
 *
 * What is deliberately **not** here: the pipeline's logic-function identifiers
 * and route paths. Those belong to the runtime workstream and it is minting them
 * in its own file. Declaring them speculatively on this side would risk the one
 * failure this whole file is written to avoid — the same function registered
 * twice under two identifiers, which for a database-event trigger means every
 * event handled twice.
 */

/* -------------------------------------------------------------------------- */
/* Fields — Opportunity                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The five fields that make an Opportunity card able to state its own next move.
 *
 * All five are `greenlight`-prefixed and all five are removed when the app is
 * uninstalled, which is the promise PIPELINE_SPEC.md opens with: a workspace
 * that drops Greenlight keeps every Opportunity intact.
 *
 * Note what is *not* here. There is no `greenlightStage` and no
 * `greenlightPipelineStage`. Lanes five to nine are `opportunity.stage`, Twenty's
 * own field, written by Twenty's own kanban as readily as by ours; lanes one to
 * four are derived from Person state on every read. A stored copy of either would
 * be a second source of truth for a value the workspace can already change behind
 * our back, and the first drag a rep performed in Twenty's own UI would put the
 * two out of step permanently.
 */
export const PIPELINE_OPPORTUNITY_FIELD_UNIVERSAL_IDENTIFIERS = {
  greenlightReadiness: 'b6ec07f2-bce0-4685-9c0e-8f8f7c7671c8',
  greenlightNextAction: 'fa50cb89-b79e-4009-ab0a-43e88a8f1186',
  greenlightNextActionKind: 'd284df1c-5e9b-44d9-a525-4ea6ee99bf29',
  greenlightCriteria: '8fca7520-dfa8-4ece-8b04-068a057de0ba',
  greenlightAdvisedAt: '52fe9af0-7a21-40a3-98e2-4fca56915d32',
} as const;

/* -------------------------------------------------------------------------- */
/* Fields — Person                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The same three advice fields again, on Person, under **different**
 * identifiers.
 *
 * This is not duplication that could be tidied away. `defineField` binds one
 * field to one object; there is no form of it that attaches a field to two. A
 * field on Person and a field on Opportunity are two rows in Twenty's field
 * metadata, two columns in two tables, and therefore two permanent identifiers.
 * Reusing `PIPELINE_OPPORTUNITY_FIELD_UNIVERSAL_IDENTIFIERS.greenlightNextAction`
 * for the Person copy would not create one shared field — it would collide, and
 * the collision is caught by the identifier tests rather than by the platform.
 *
 * Person carries advice at all because lanes one to four of the board are Person
 * records that have no Opportunity yet. "Held: role inbox, no decision-maker on
 * the record" is advice about a lead, and there is nowhere else to cache it.
 *
 * Person does **not** get `greenlightReadiness` or `greenlightCriteria`: both are
 * arithmetic over a *stage's* exit criteria, and a lead with no Opportunity is
 * not in a stage. A readiness percentage on a Captured lead would be a number
 * with nothing behind it, which is the failure mode the spec calls a progress bar.
 */
export const PIPELINE_PERSON_FIELD_UNIVERSAL_IDENTIFIERS = {
  greenlightNextAction: 'ea223d31-25fc-4d8b-9a01-26df12a62db2',
  greenlightNextActionKind: '5fefafd2-e586-4647-9d36-2229da2c300d',
  greenlightAdvisedAt: '6c79da15-17ee-48e1-9831-6da65c9f95ca',
} as const;

/* -------------------------------------------------------------------------- */
/* SELECT values for greenlightNextActionKind                                  */
/* -------------------------------------------------------------------------- */

/**
 * The machine-readable half of the next action: one value per category in
 * PIPELINE_SPEC.md § "How the action is chosen", plus one meaning the card is
 * healthy.
 *
 * Declared here rather than only inside the field definition because three
 * places have to agree on them and only one of the three is a field file: the
 * ranking in `src/pipeline/next-action.ts` emits them, the board component keys
 * its button off them, and the SELECT stores them. A string literal repeated in
 * three modules is a typo waiting to become a silent write failure.
 *
 * The ordering is the ranking order, blockers first, and that is load-bearing in
 * a way alphabetical order would not be — see the option list in
 * `src/fields/greenlight-next-action-kind.field.ts` for why `position` is the
 * thing a rep actually reads.
 *
 * `HEALTHY` rather than `NONE` for the nothing-to-do case. `NONE` reads as
 * "unset" next to a nullable column, and the two states are genuinely different:
 * null means the advice has never been computed for this record, `HEALTHY` means
 * it was computed and the answer was that there is nothing to fix. Collapsing
 * them would make "which cards has the engine never looked at" unanswerable.
 *
 * ## Why this is a re-export and not a declaration
 *
 * It was a declaration for about an hour, and it held the wrong vocabulary.
 *
 * The metadata and runtime workstreams were built concurrently against this
 * file as their contract, and both correctly concluded that the action kind had
 * to be declared exactly once. They then declared it in different places: six
 * *tier* names here (`MISSING_CRITERION`, `SCORE_BAND`) and fourteen *action*
 * names in `ACTION_KINDS` in `src/pipeline/types.ts` (`set_the_close_date`,
 * `find_the_buyer`). Two single sources of truth is not one.
 *
 * The engine's list won on merit, not on order of arrival. A tier names the
 * category of obstacle; an action names the move. "Set the close date" is what a
 * rep filters a board by and what decides which button the card renders, and the
 * tier is recoverable from the action while the action is not recoverable from
 * the tier. So the ranking's own vocabulary is the vocabulary, and this file
 * re-exports it rather than restating it — a restatement is what produced the
 * divergence in the first place.
 *
 * That this cost nothing is a fact about timing, not about care: none of these
 * fields had reached a workspace yet. The permanence rule at the top of this
 * file is exactly why the reconciliation had to happen before the first install
 * and could not have been tidied up afterwards.
 */
export { ACTION_KINDS as NEXT_ACTION_KIND_VALUES } from 'src/pipeline/types';
export type { ActionKind as NextActionKind } from 'src/pipeline/types';

/* -------------------------------------------------------------------------- */
/* The board surface                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The board itself.
 *
 * Consumed by `src/front-components/greenlight-pipeline.tsx`, which the runtime
 * workstream owns and which does not exist at the time this file was written.
 * That is exactly why the identifier is declared on this side: the page layout
 * has to name it now, and a page layout pointing at an undefined front component
 * renders an empty widget in a live workspace rather than failing the build.
 */
export const PIPELINE_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER =
  '9949124c-a7c4-4d4c-90e6-b1a0465d6423';

/**
 * The sidebar entry, and the standalone page behind it.
 *
 * The entry sorts above every other Greenlight entry. See
 * `src/navigation-menu-items/greenlight-pipeline.navigation-menu-item.ts` for how
 * that is expressed without renumbering an entry a user already reads.
 */
export const PIPELINE_NAVIGATION_MENU_ITEM_UNIVERSAL_IDENTIFIER =
  'f4a8e8e5-6a5d-4fed-b22c-2d63bdeb65e6';

export const PIPELINE_PAGE_LAYOUT_UNIVERSAL_IDENTIFIER =
  '4b67dfce-5b4c-4494-95c5-e82f6c61911b';

export const PIPELINE_PAGE_LAYOUT_TAB_UNIVERSAL_IDENTIFIER =
  'e005b5f8-ae52-4e9c-9b21-1d31aaaf6c48';

export const PIPELINE_PAGE_WIDGET_UNIVERSAL_IDENTIFIER =
  '850a6b58-43c9-40ad-a43e-61176a383cf9';

/* -------------------------------------------------------------------------- */
/* Record-page view fields                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Greenlight's columns in the **Opportunity record page Fields panel**.
 *
 * The lesson recorded against `PERSON_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS`
 * in `universal-identifiers.ts`, applied before it can be relearned:
 * `defineField` puts a field on the object's schema and on the API, and does
 * **not** put it on the record page. That panel renders a `FIELDS_WIDGET` view —
 * "Opportunity Record Page Fields" — and draws only the view fields that view
 * holds. Ten Person fields shipped invisible for exactly this reason and had to
 * be rescued by ten standalone `defineViewField` files afterwards. These five
 * ship alongside their fields instead.
 *
 * Twenty's Opportunity record page offers three sections — Deal, Relations,
 * System — and the SDK still exposes no standalone way to add a fourth, so the
 * assignment is by meaning:
 *
 *   - **Deal** — readiness, the next action, its kind, and the advice date. All
 *     four are statements about where this deal stands and what moves it, which
 *     is what a rep opens the Deal section to read.
 *   - **System** — the criteria document. It is raw JSON, and System is where
 *     Twenty already keeps the fields you go looking for only when the number
 *     above them looks wrong. The same argument as the score trace on Person:
 *     hiding it entirely is how a scoring product becomes unarguable-with.
 *
 * Positions start at 100 so nothing renumbers a column the user already reads.
 */
export const OPPORTUNITY_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS = {
  greenlightReadiness: 'af3322a5-6673-4b9e-8765-4c9115b39c89',
  greenlightNextAction: '9e2307cd-7dd9-4a35-b342-6442c2b7f7f8',
  greenlightNextActionKind: '8fbf3b8b-d3dd-4f92-9456-b5d42dbb97e1',
  greenlightCriteria: 'b6cf8d95-8dbe-4c38-9c8e-4522f845b9fb',
  greenlightAdvisedAt: 'd657491e-070d-4ad4-98ef-675e6c0af6ba',
} as const;

/**
 * The three Person advice fields on the **Person record page**, in General.
 *
 * Declared here rather than appended to
 * `PERSON_RECORD_PAGE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS` for the file-ownership
 * reason at the top of this module: that constant lives in the shared data-model
 * file, these belong to the pipeline workstream, and nothing about a view field
 * cares which module its identifier was declared in.
 *
 * General rather than Work: "what do I do about this person next" is the first
 * fact about a lead, and General is the section already open at the top of the
 * record. It sits directly under the score and the gate decision that produced it.
 */
export const PERSON_RECORD_PAGE_PIPELINE_VIEW_FIELD_UNIVERSAL_IDENTIFIERS = {
  greenlightNextAction: '5a48f5bb-9bb7-41a7-b4fb-89deeb8db198',
  greenlightNextActionKind: '201c8b01-4529-4431-a995-2f0ce0e6eb8a',
  greenlightAdvisedAt: '06d49fa6-e75a-4b60-a9a7-154c380b0832',
} as const;

/* -------------------------------------------------------------------------- */
/* Runtime — appended by the runtime workstream                                */
/* -------------------------------------------------------------------------- */

/**
 * The board's one logic function.
 *
 * The header above says the runtime workstream would mint its route identifiers
 * "in its own file". It is minting them here instead, and the reason is the
 * failure that header exists to prevent rather than an exception to it: the
 * identifier-collision guard in `src/constants/__tests__/identifier-uniqueness.test.ts`
 * discovers `src/constants/*.ts` by glob and asserts the discovered list by
 * name, so a seventh constants file is a change to that list — while an
 * *addition* to this file is inside the guard from the moment it is written.
 * Nothing about a logic-function identifier cares which module it was declared
 * in, and the risk the header names (one function registered twice under two
 * identifiers) is a risk of *duplicating* a declaration, not of co-locating one.
 *
 * There is exactly one. `wire.ts` sets out the argument for a single route with
 * a discriminated `action` over four routes, and it is the same argument
 * `icp-control` and `backfill-control` already settled: board, capture, advance
 * and advise share an authentication check, a configuration read and a licence
 * read, and four routes means four copies of that preamble of which three will
 * eventually be missing something the fourth has.
 */
export const PIPELINE_CONTROL_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER =
  '7c1e0b34-9d52-4a86-b0f3-6e2a4d5c81f7';

/**
 * The narrative agent — a model handle, exactly as
 * `ENRICHMENT_EXTRACTOR_AGENT_UNIVERSAL_IDENTIFIER` is.
 *
 * `runAgent` takes an agent identifier and there is no other route from a logic
 * function to Twenty's own AI, so the agent has to exist for the narrative
 * rewrite to be reachable at all. Every word that shapes an answer is built in
 * `src/logic-functions/pipeline-run.ts` and passed as the `prompt` argument;
 * see `src/agents/greenlight-next-action.agent.ts` for why the manifest carries
 * one sentence and not the instruction.
 */
export const PIPELINE_NEXT_ACTION_AGENT_UNIVERSAL_IDENTIFIER =
  '2b93d5c1-4f08-4e7a-9c16-8a5f3d0e6b24';

/* -------------------------------------------------------------------------- */
/* HTTP route                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Same two-constant shape as the gate-queue, backfill and ICP routes: the front
 * component posts to the `/s`-prefixed path, which is how `RestApiClient`
 * recognises an app route rather than a core REST call, and declaring both here
 * means a mismatch between the two halves is a compile-time import of one
 * constant rather than a 404 discovered in a live workspace.
 *
 * Singular `/greenlight/pipeline` and not `/greenlight/board`: three of the four
 * actions behind it are not the board.
 */
export const PIPELINE_ROUTE_PATH = '/greenlight/pipeline';
export const PIPELINE_CLIENT_PATH = `/s${PIPELINE_ROUTE_PATH}`;

/* -------------------------------------------------------------------------- */
/* Command menu                                                                */
/* -------------------------------------------------------------------------- */

/**
 * "Open the pipeline (Greenlight)".
 *
 * Minted here, late, because the front-component workstream needed it and
 * correctly declined to invent one in its own file — a UUID for a permanent
 * entity created outside the constants files would sit outside the collision
 * guard that globs this directory, which is the one place a duplicate is caught
 * before it reaches a workspace.
 *
 * Unlike the ICP command, this is genuinely a shortcut rather than a second way
 * in. The board is the first sidebar entry and nobody needs to be told it is
 * there; the command exists for the rep who is standing on a lead record and
 * wants the board without reaching for the mouse.
 */
export const PIPELINE_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER =
  '7339f71a-e63c-4f0e-a79d-48facae95e87';
