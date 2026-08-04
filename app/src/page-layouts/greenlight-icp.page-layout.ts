import { definePageLayout, PageLayoutTabLayoutMode } from 'twenty-sdk/define';

import {
  ICP_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
  ICP_PAGE_LAYOUT_TAB_UNIVERSAL_IDENTIFIER,
  ICP_PAGE_LAYOUT_UNIVERSAL_IDENTIFIER,
  ICP_PAGE_WIDGET_UNIVERSAL_IDENTIFIER,
} from 'src/constants/icp-identifiers';

/**
 * The standalone page behind the sidebar entry.
 *
 * A page layout exists here only because `NavigationMenuItemType.PAGE_LAYOUT` is
 * what a sidebar entry pointing at a front component requires — the alternative,
 * `VIEW`, points at a record list, and "how much of your scoring model is idle"
 * is not a question a record list can answer. The whole content is the one front
 * component, exactly like the app's own main page.
 *
 * `CANVAS` rather than a fixed widget grid: the panel's height depends on how
 * many industries the workspace has, which is unknowable here, and the component
 * scrolls inside its own container rather than pushing the page around.
 */
export default definePageLayout({
  universalIdentifier: ICP_PAGE_LAYOUT_UNIVERSAL_IDENTIFIER,
  name: 'Greenlight ICP',
  type: 'STANDALONE_PAGE',
  tabs: [
    {
      universalIdentifier: ICP_PAGE_LAYOUT_TAB_UNIVERSAL_IDENTIFIER,
      title: 'Ideal customer profile',
      position: 0,
      icon: 'IconTargetArrow',
      layoutMode: PageLayoutTabLayoutMode.CANVAS,
      widgets: [
        {
          universalIdentifier: ICP_PAGE_WIDGET_UNIVERSAL_IDENTIFIER,
          title: ' ',
          type: 'FRONT_COMPONENT',
          gridPosition: { row: 0, column: 0, rowSpan: 12, columnSpan: 12 },
          configuration: {
            configurationType: 'FRONT_COMPONENT',
            frontComponentUniversalIdentifier:
              ICP_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER,
          },
        },
      ],
    },
  ],
});
