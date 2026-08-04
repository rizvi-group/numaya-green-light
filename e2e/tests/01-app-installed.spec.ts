import { expect, test } from '@playwright/test';

import { errorBanners, sidebarEntry, waitForShell } from '../support/ui';

/**
 * Test (a): the app is installed and a user can reach every screen it ships.
 *
 * The assertion is on the *sidebar*, not on the manifest, because a view that
 * exists in the metadata and has no navigation entry is a view no salesperson
 * will ever open. Note that the sidebar shows the **view's** name rather than
 * the navigation menu item's name — "Greenlight Unscored (Failed Open)", not
 * "Greenlight Unscored" — which is worth knowing before writing an assertion
 * against the wrong string.
 */

const SIDEBAR_ENTRIES = [
  'Greenlight ICP',
  'Greenlight Configuration',
  'Greenlight Audit Log',
  'Greenlight Gate Queue',
  'Greenlight Unscored (Failed Open)',
  'Greenlight Compliance Blocked',
  'Greenlight Enrichment',
  'Greenlight Do Not Contact',
  'Greenlight Never Scored',
];

test.describe('Greenlight is installed', () => {
  test('every Greenlight screen has a sidebar entry that opens', async ({ page }) => {
    await page.goto('/');
    await waitForShell(page);

    for (const entry of SIDEBAR_ENTRIES) {
      await expect(
        sidebarEntry(page, entry),
        `sidebar entry "${entry}" is missing`,
      ).toHaveCount(1);
    }

    await page.screenshot({ path: 'shots/01-sidebar.png', fullPage: true });
    expect(await errorBanners(page)).toEqual([]);
  });

  test('the scaffolded app page is gone from the sidebar', async ({ page }) => {
    // "Numaya Greenlight" used to sit at position -1, above every real surface,
    // and it opened `yarn twenty dev:add`'s untouched starter page: "Was
    // installed successfully. You can now add content to your app", above three
    // cards of links into docs.twenty.com. It was the first thing a new user
    // clicked and it handed a salesperson an app-developer tutorial. It was
    // removed rather than rewritten — the ICP page is the onboarding entry
    // point and every other surface already has its own entry.
    //
    // This asserts on the *sidebar entry*, because that is the thing that made
    // the scaffold reachable. If a Greenlight home page is ever built it will
    // need a new entry and this test should be rewritten to name it, not
    // deleted.
    await page.goto('/');
    await waitForShell(page);

    await expect(
      sidebarEntry(page, 'Numaya Greenlight'),
      'the scaffolded app page must not be reachable from the sidebar',
    ).toHaveCount(0);

    const body = await page.locator('body').innerText();
    expect(
      body,
      "the scaffold's own copy must not appear anywhere in the workspace",
    ).not.toContain('You can now add content to your app');
  });

  test('the gate queue opens and shows its held-leads filter', async ({ page }) => {
    await page.goto('/');
    await waitForShell(page);
    await sidebarEntry(page, 'Greenlight Gate Queue').click();

    // The view header, its filter chip, and the score/decision columns are what
    // make this a queue rather than a second copy of the People list.
    await expect(page.getByRole('button', { name: 'Greenlight Gate Queue' })).toBeVisible();
    await expect(page.getByText('Greenlight decision: Gate')).toBeVisible();
    await expect(page.getByText('Greenlight score', { exact: true }).first()).toBeVisible();

    await page.screenshot({ path: 'shots/01-gate-queue.png', fullPage: true });
    expect(await errorBanners(page)).toEqual([]);
  });

  test('the two workspace-level Greenlight commands are in the command menu', async ({
    page,
  }) => {
    await page.goto('/');
    await waitForShell(page);
    await page.keyboard.press('ControlOrMeta+KeyK');

    await expect(
      page.getByText('Score existing leads (Greenlight)'),
    ).toBeVisible();
    await expect(
      page.getByText('Set up your ideal customer profile (Greenlight)'),
    ).toBeVisible();

    await page.screenshot({ path: 'shots/01-command-menu.png', fullPage: true });
  });
});
