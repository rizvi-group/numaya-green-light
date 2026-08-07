import { expect, test } from '@playwright/test';

import {
  createCompany,
  deleteCompany,
  readIcpRegions,
  setIcpRegions,
} from '../support/twenty-api';
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
      page.getByText(/Based on the \d+ most recently added of your [\d,]+ companies/),
    ).toBeVisible();

    /*
     * Two mutually exclusive admissions, and which one is correct depends on the
     * workspace rather than on the app.
     *
     * This used to assert "Industry read from Company.industry" unconditionally,
     * and it passed for months against a workspace that has no industry field at
     * all. The page was wrong, not the test: `probeField` decided a candidate
     * existed by *selecting* it, and Twenty does not validate selection sets — an
     * unknown column is accepted and returns `null`. So every candidate reported
     * present, the panel named five Company fields the workspace does not have,
     * and the one note an admin could have acted on was unreachable by
     * construction. Fixed in the app; this assertion had been encoding the bug.
     *
     * Branching on the observed state rather than pinning either sentence,
     * because both are correct answers to different workspaces and a test that
     * demands one would fail the moment somebody adds a custom industry field —
     * which is precisely the thing the page is telling them to do.
     */
    const hasIndustryField = await page
      .getByText(/Industry read from Company\./)
      .isVisible();

    if (hasIndustryField) {
      // The article is asserted exactly, not with `an?`. "has a industry
      // recorded" was on this screen, next to the numbers an admin is being
      // asked to trust, and a loose regex is what let it sit there.
      await expect(
        page.getByText(
          /None of the \d+ companies examined has an industry recorded, so there is nothing to derive a profile from/,
        ),
        'the page must say outright that there is no industry data to work from',
      ).toBeVisible();
    } else {
      await expect(
        page.getByText(
          /This workspace has no industry field on Company .* Nothing can be proposed for industry until one exists and is filled in/,
        ),
        'a workspace with no industry column must be told that, not told which of five imaginary columns was read',
      ).toBeVisible();
    }
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

  /*
   * The one test in this file that writes anything.
   *
   * The rest are read-only on purpose — they must not change what the other
   * suites score against. This one has to configure a profile and create
   * companies, because the state it covers exists only when a profile is set
   * *and* the workspace holds values that profile rejects. Everything it
   * touches is undone in a `finally`, which is safe only because the suite runs
   * `workers: 1`; under any parallelism it would leak into whatever else was
   * scoring at the time.
   *
   * Region rather than industry: the seeded workspace's Company has no industry
   * column at all — the test above asserts exactly that — so the industry
   * dimension cannot be exercised here without adding a custom field to a
   * shared fixture. `address.addressCountry` ships with Twenty and is empty on
   * every seeded company, so three companies carrying one country is a
   * dimension this test fully controls.
   *
   * What it guards is the most confusing outcome the product can produce:
   * enrichment writes a value, the score refuses to move, and nothing says why.
   * The lead is not at fault and no work on the lead fixes it — matching is
   * exact set membership and the value is simply not on the list.
   */
  test('names the values the workspace holds that the profile rejects', async ({
    page,
  }) => {
    const before = await readIcpRegions();
    const created: string[] = [];

    try {
      for (const name of ['Reykjavik Fisheries', 'Akureyri Freight', 'Selfoss Steel']) {
        created.push(await createCompany(name, { addressCountry: 'Iceland' }));
      }

      // A region none of them is in, so Iceland is rejected and the panel has
      // exactly one thing to report.
      await setIcpRegions(['Antarctica']);

      await page.goto('/');
      await waitForShell(page);
      await sidebarEntry(page, 'Greenlight ICP').click();
      await expect(page.getByText('Ideal customer profile')).toBeVisible({
        timeout: 60_000,
      });

      await page.getByText('Suggest a profile from my data').click();
      await expect(page.getByText('Where this comes from')).toBeVisible({
        timeout: 90_000,
      });

      await expect(
        page.getByText(/\d+ regions? on your records that this profile rejects/),
        'a configured profile that rejects what the workspace holds must say so',
      ).toBeVisible();

      // The consequence, not just the count — this is the sentence that stops an
      // admin blaming enrichment for a score that will not move.
      await expect(
        page.getByText(/Matching is exact, so these score as a miss/),
      ).toBeVisible();

      // And the value itself, offered as something to accept in one click.
      await expect(
        page.getByRole('button', { name: /^\+ Iceland \(\d+\)$/ }),
        'each rejected value is a button that adds it to the profile',
      ).toBeVisible();

      await page.screenshot({
        path: 'shots/04-icp-unmatched.png',
        fullPage: true,
      });
      expect(await errorBanners(page)).toEqual([]);
    } finally {
      await setIcpRegions(before);
      for (const id of created) {
        await deleteCompany(id);
      }
    }
  });
});
