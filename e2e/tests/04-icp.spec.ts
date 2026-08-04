import { expect, test } from '@playwright/test';

import { errorBanners, sidebarEntry, waitForShell } from '../support/ui';

/**
 * Test (d): the ICP onboarding page tells the truth about this workspace.
 *
 * Two things have to be on screen. First, how much of the scoring model is idle
 * — the number that justifies the page existing at all. Second, once the page is
 * asked to propose a profile, an honest admission that it cannot: the seeded
 * workspace's companies carry no industry, region or headcount, so there is no
 * evidence to derive a profile from and the page has to say so rather than
 * inventing one.
 *
 * This test is deliberately read-only. It clicks "Suggest a profile from my
 * data", which only reads Companies, and never "Apply this profile" or "Leave
 * the profile open, deliberately" — both of those write workspace configuration
 * and would change what every other test in this suite scores against.
 */

test.describe('the ICP page', () => {
  test('reports how many scoring points are idle, and why', async ({ page }) => {
    await page.goto('/');
    await waitForShell(page);
    await sidebarEntry(page, 'Greenlight ICP').click();

    await expect(page.getByText('Ideal customer profile')).toBeVisible({
      timeout: 60_000,
    });

    // The headline figure. 40 of 130 with the profile unset: industry 20,
    // region 10, size 10 — asserted loosely on the shape so a weights change
    // shows up as a number difference rather than a broken test.
    const headline = page.getByText(/\d+ of \d+ scoring points are switched off/);
    await expect(headline).toBeVisible();
    await expect(headline).toHaveText('40 of 130 scoring points are switched off');

    // And the breakdown that makes the figure checkable.
    await expect(page.getByText('Target industry', { exact: true })).toBeVisible();
    await expect(page.getByText('not set · 20 pts idle')).toBeVisible();
    await expect(page.getByText('Target region', { exact: true })).toBeVisible();
    await expect(page.getByText('Target company size', { exact: true })).toBeVisible();
    await expect(page.getByText('not set · 10 pts idle').first()).toBeVisible();
    await expect(page.getByText('Nobody has reviewed this profile yet.')).toBeVisible();

    await page.screenshot({ path: 'shots/04-icp-idle-points.png', fullPage: true });
    expect(await errorBanners(page)).toEqual([]);
  });

  test('admits the workspace has no readable industry data', async ({ page }) => {
    await page.goto('/');
    await waitForShell(page);
    await sidebarEntry(page, 'Greenlight ICP').click();
    await expect(page.getByText('Ideal customer profile')).toBeVisible({
      timeout: 60_000,
    });

    await page.getByText('Suggest a profile from my data').click();

    // Where it looked, so an admin can check the claim rather than trust it.
    await expect(page.getByText('Where this comes from')).toBeVisible({
      timeout: 90_000,
    });
    await expect(
      page.getByText(/Industry read from Company\.industry/),
    ).toBeVisible();
    await expect(
      page.getByText(/Based on the \d+ most recently added of your [\d,]+ companies/),
    ).toBeVisible();

    // The admission itself, for all three dimensions.
    // The article is asserted exactly, not with `an?`. "has a industry
    // recorded" was on this screen, next to the numbers an admin is being asked
    // to trust, and a loose regex is what let it sit there.
    await expect(
      page.getByText(
        /None of the \d+ companies examined has an industry recorded, so there is nothing to derive a profile from/,
      ),
      'the page must say outright that there is no industry data to work from',
    ).toBeVisible();
    await expect(
      page.getByText(/None of the \d+ companies examined has a region recorded/),
    ).toBeVisible();
    await expect(
      page.getByText(/None of the \d+ companies examined has an employee count recorded/),
    ).toBeVisible();

    // Nothing was proposed, so nothing is offered to measure.
    await expect(
      page.getByText(
        'Nothing is ticked, so there is no profile to measure. An empty profile is the state you are already in.',
      ),
    ).toBeVisible();

    // The Industries and Regions cards each explain case-insensitive matching
    // with an example. They used to share one: the Regions card told an admin
    // that a region "recorded as SaaS" and one "recorded as saas" both match,
    // which is an example of a value that cannot appear in the column they are
    // looking at. Asserted as a pair so a future edit cannot quietly make both
    // cards say the same thing again.
    const hints = await page
      .getByText(/Matching is exact, ignoring case and spacing/)
      .allInnerTexts();

    expect(hints, 'both value cards should carry the matching hint').toHaveLength(2);
    expect(
      hints.filter((hint) => /SaaS/.test(hint)),
      'the SaaS example belongs to the Industries card only',
    ).toHaveLength(1);
    expect(
      hints.filter((hint) => /United Kingdom/.test(hint)),
      'the Regions card needs an example that is actually a region',
    ).toHaveLength(1);

    await page.screenshot({ path: 'shots/04-icp-no-evidence.png', fullPage: true });
    expect(await errorBanners(page)).toEqual([]);
  });
});
