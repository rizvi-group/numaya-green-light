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
