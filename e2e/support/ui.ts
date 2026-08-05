import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Locators for the bits of Twenty this suite drives.
 *
 * Twenty's record table is a div grid, not a `<table>`, so `getByRole('row')`
 * finds nothing. Rows do carry `data-testid="row-id-<uuid>"`, which is the most
 * stable hook available and the one used throughout.
 */

/** The workspace shell has finished loading. */
export const waitForShell = async (page: Page): Promise<void> => {
  await expect(page.getByRole('link', { name: 'People' })).toBeVisible({
    timeout: 60_000,
  });
};

/** A sidebar entry, matched on the leading text — the sidebar truncates labels. */
export const sidebarEntry = (page: Page, name: string): Locator =>
  page.locator('a').filter({ hasText: new RegExp(`^${escapeRegExp(name)}`) });

export const tableRow = (page: Page, personId: string): Locator =>
  page.getByTestId(`row-id-${personId}`);

/** Select exactly one row, which is what the record-selection commands require. */
export const selectRow = async (page: Page, personId: string): Promise<void> => {
  const row = tableRow(page, personId);
  await expect(row).toBeVisible();
  await row.hover();
  await row.locator('input[type="checkbox"]').first().click({ force: true });
  await expect(page.getByText('1 selected')).toBeVisible();
};

export const openCommandMenu = async (page: Page): Promise<void> => {
  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(page.getByPlaceholder('Type anything...')).toBeVisible();
};

/**
 * Every visible leaf-node text on the page.
 *
 * Twenty renders the command menu and the app's front components into panels
 * whose text `innerText` reports inconsistently once they overflow; reading the
 * leaves is the reliable way to ask "is this string on screen".
 */
export const visibleText = async (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const out = new Set<string>();
    document.querySelectorAll('*').forEach((element) => {
      if (element.children.length > 0) {
        return;
      }
      const text = (element as HTMLElement).innerText?.trim();
      if (text) {
        out.add(text);
      }
    });
    return [...out];
  });

/**
 * Record-page field labels that do not fit the box Twenty gives them.
 *
 * The Fields panel puts every label in a hard 90px div and clamps it to one line
 * with `-webkit-line-clamp`. That clamp breaks on **words**, so an over-long
 * label silently loses its trailing words — and, critically, `innerText` still
 * reports the whole string, so a `toContainText` assertion passes while the user
 * sees "Greenlight …". Four fields once rendered as those same eight characters.
 *
 * Measuring the rendered line boxes is the only way to see it from a test. A
 * label occupying more than one line box has had everything after the first line
 * clipped away.
 */
export const clampedFieldLabels = async (
  page: Page,
  labels: string[],
): Promise<string[]> =>
  page.evaluate((wanted) => {
    const clipped: string[] = [];

    document.querySelectorAll('[data-testid="tooltip"]').forEach((element) => {
      const text = element.textContent ?? '';

      if (!wanted.includes(text) || element.childNodes.length !== 1) {
        return;
      }

      const node = element.firstChild;

      if (!node || node.nodeType !== Node.TEXT_NODE) {
        return;
      }

      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, text.length);

      const tops = new Set(
        [...range.getClientRects()].map((rect) => Math.round(rect.top)),
      );

      if (tops.size > 1) {
        clipped.push(text);
      }
    });

    return [...new Set(clipped)];
  }, labels);

/**
 * Table column headings that are ellipsised.
 *
 * A different component from the record page and a tighter budget: a `<span>`
 * with `text-overflow: ellipsis` whose width is the view field's `size` less
 * 28px of icon and gutter. Here `scrollWidth` does exceed `clientWidth`, so the
 * check is the ordinary one.
 */
export const truncatedColumnHeaders = async (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const clipped: string[] = [];

    document.querySelectorAll('span').forEach((element) => {
      if (
        element.children.length === 0 &&
        getComputedStyle(element).textOverflow === 'ellipsis' &&
        element.scrollWidth > element.clientWidth + 1 &&
        element.textContent
      ) {
        clipped.push(element.textContent);
      }
    });

    return [...new Set(clipped)];
  });

/**
 * Anything on screen that reads as an error.
 *
 * A test that passes while an error toast is up is worse than no test, so every
 * spec calls this before it finishes.
 */
export const errorBanners = async (page: Page): Promise<string[]> => {
  const texts = await visibleText(page);
  return texts.filter((text) =>
    /(^|\s)(error|failed|went wrong|could not|unable to|unexpected)/i.test(text),
  );
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
