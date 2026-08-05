import { definePageLayout, PageLayoutTabLayoutMode } from 'twenty-sdk/define';

import {
  PIPELINE_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  PIPELINE_PAGE_LAYOUT_TAB_UNIVERSAL_IDENTIFIER,
  PIPELINE_PAGE_LAYOUT_UNIVERSAL_IDENTIFIER,
  PIPELINE_PAGE_WIDGET_UNIVERSAL_IDENTIFIER,
} from 'src/constants/pipeline-identifiers';

/**
 * The standalone page behind the sidebar entry — the app's primary working
 * surface.
 *
 * Same three-part shape as `greenlight-icp.page-layout.ts`, and for the same
 * reasons, which are worth restating rather than inherited by resemblance:
 *
 *   - A page layout exists at all because `NavigationMenuItemType.PAGE_LAYOUT`
 *     is what a sidebar entry pointing at a front component requires. The
 *     alternative, `VIEW`, points at a record list, and a record list cannot
 *     answer this page's question. Nine lanes across two different objects, four
 *     of them derived from Person state and never stored, is not a shape any
 *     view can express — that is precisely the defect PIPELINE_SPEC.md opens
 *     with, and the eight Greenlight views that already exist are the evidence.
 *
 *   - `CANVAS` rather than a fixed widget grid: the board's height depends on
 *     how many cards the busiest lane holds, which is unknowable here, and the
 *     component manages its own scrolling inside the widget rather than pushing
 *     the page around. A kanban board is the canonical case for this.
 *
 *   - One `FRONT_COMPONENT` widget filling the tab. The board, the capture
 *     drawer and the card detail are one component because they share one
 *     payload: the board is a single logic-function call for the whole
 *     workspace, and splitting the surface into widgets would mean either
 *     splitting that call or passing its result between widgets that have no
 *     channel to do so.
 *
 * The tab title is the user-facing name of the feature and the widget title is a
 * single space — the same trick the ICP page uses, because a canvas widget draws
 * its title bar above a component that already has its own heading, and two
 * headings stacked is the visual signature of a page assembled rather than
 * designed.
 *
 * `PIPELINE_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER` names a component that does
 * not exist yet — the runtime workstream is building it concurrently. The
 * identifier is declared in `src/constants/pipeline-identifiers.ts` for exactly
 * that reason: this file has to name it now, and a page layout pointing at an
 * identifier nobody ever defines renders as an empty widget in a live workspace
 * rather than failing the build, so agreeing the value in one place beforehand
 * is the only thing that makes the mismatch impossible.
 */
export default definePageLayout({
  universalIdentifier: PIPELINE_PAGE_LAYOUT_UNIVERSAL_IDENTIFIER,
  name: 'Greenlight Pipeline',
  type: 'STANDALONE_PAGE',
  tabs: [
    {
      universalIdentifier: PIPELINE_PAGE_LAYOUT_TAB_UNIVERSAL_IDENTIFIER,
      title: 'Pipeline',
      position: 0,
      icon: 'IconLayoutKanban',
      layoutMode: PageLayoutTabLayoutMode.CANVAS,
      widgets: [
        {
          universalIdentifier: PIPELINE_PAGE_WIDGET_UNIVERSAL_IDENTIFIER,
          title: ' ',
          type: 'FRONT_COMPONENT',
          gridPosition: { row: 0, column: 0, rowSpan: 12, columnSpan: 12 },
          configuration: {
            configurationType: 'FRONT_COMPONENT',
            frontComponentUniversalIdentifier:
              PIPELINE_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
          },
        },
      ],
    },
  ],
});
