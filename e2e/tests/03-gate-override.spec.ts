import { expect, test } from '@playwright/test';

import {
  createPerson,
  deletePerson,
  readPerson,
  waitForDecision,
} from '../support/twenty-api';
import {
  errorBanners,
  openCommandMenu,
  selectRow,
  sidebarEntry,
  tableRow,
  waitForShell,
} from '../support/ui';

/**
 * Test (c): the gate queue holds a lead, a human overrides the gate from the
 * command menu, and the lead leaves the queue.
 *
 * This is the whole product in one flow — the gate is advisory, and the proof
 * of that is a rep being able to let a lead through with a recorded reason.
 *
 * Note on how the command is reached: "Release lead (Greenlight)" is a
 * `RECORD_SELECTION` command, so it appears only once exactly one row is ticked.
 * It does **not** appear in the command menu on a record page, where nothing is
 * selected. That is Twenty's model, not a bug — but it does mean the override is
 * unreachable from the place a rep is most likely to look for it, which is worth
 * knowing.
 */

const stamp = Date.now();
const LEAD_NAME = `Held${stamp}`;

let personId: string;
let heldScore: number | null;

test.beforeAll(async () => {
  personId = await createPerson({
    name: { firstName: 'GreenlightE2E', lastName: LEAD_NAME },
  });

  const scored = await waitForDecision(personId);
  heldScore = scored.greenlightScore;

  expect(
    scored.greenlightDecision,
    'the fixture lead must be gated for this test to mean anything',
  ).toBe('GATE');
});

test.afterAll(async () => {
  if (personId) {
    await deletePerson(personId);
  }
});

test('the override releases a held lead and it leaves the gate queue', async ({
  page,
}) => {
  await page.goto('/');
  await waitForShell(page);
  await sidebarEntry(page, 'Greenlight Gate Queue').click();

  const row = tableRow(page, personId);
  await expect(row, 'the held lead should start in the gate queue').toBeVisible({
    timeout: 60_000,
  });
  await expect(row).toContainText('Gate');
  await page.screenshot({ path: 'shots/03-before-release.png', fullPage: true });

  await selectRow(page, personId);
  await openCommandMenu(page);

  const releaseCommand = page.getByText('Release lead (Greenlight)');
  await expect(
    releaseCommand,
    'the release command must be offered when one lead is selected',
  ).toBeVisible();
  await releaseCommand.click();

  // The side panel: a mandatory reason, an optional note, and a submit button
  // that stays disabled until a reason is chosen.
  await expect(page.getByText('Release this lead')).toBeVisible();
  await expect(page.getByText('Why are you releasing it?')).toBeVisible();

  const submit = page.getByRole('button', { name: 'Release lead', exact: true });
  await expect(
    submit,
    'submitting without a reason must not be possible',
  ).toBeDisabled();

  await page.getByText('Testing Greenlight').click();
  await page
    .getByPlaceholder('Context a colleague would need in six months.')
    .fill(`Playwright end-to-end verification ${stamp}.`);

  await expect(submit).toBeEnabled();
  await page.screenshot({ path: 'shots/03-release-panel.png', fullPage: true });
  await submit.click();

  // The panel reports what the server said, in words a rep can act on.
  await expect(page.getByText('Lead released')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/released/i).first()).toBeVisible();

  // And it tells the truth about the list behind it rather than closing and
  // leaving the reviewer with a queue that still shows the lead. Measured, not
  // assumed: releasing a lead and then counting the row shows it survives no
  // interaction, a click on the queue's own sidebar entry, and a trip to
  // another view and back. Only a full document load clears it, because
  // Twenty serves the record list from Apollo's cache and the front-component
  // host API has no refetch or invalidate channel to reach it.
  await expect(
    page.getByText('The queue behind this panel is out of date'),
    'the panel must not let a reviewer believe the queue behind it is fresh',
  ).toBeVisible();
  await expect(
    page.getByText(/Releasing it again from the stale row is safe/),
  ).toBeVisible();

  // The pin on the defect that could not be fixed. If Twenty ever gives an app
  // a way to invalidate the view, this fails and the panel's copy is a lie that
  // needs deleting.
  await expect(
    tableRow(page, personId),
    'the released row is expected to survive in the stale list — if it does ' +
      'not, the queue now refreshes itself and the panel copy must be rewritten',
  ).toHaveCount(1);

  await page.screenshot({ path: 'shots/03-release-result.png', fullPage: true });

  // The lead is no longer held.
  await expect
    .poll(
      async () => (await readPerson(personId))?.greenlightDecision,
      { timeout: 60_000, message: 'the release should clear the gate on the record' },
    )
    .not.toBe('GATE');

  // And the queue a rep works from no longer shows it.
  await page.goto('/');
  await waitForShell(page);
  await sidebarEntry(page, 'Greenlight Gate Queue').click();
  await expect(page.getByRole('button', { name: 'Greenlight Gate Queue' })).toBeVisible();
  await expect(
    tableRow(page, personId),
    'a released lead must leave the gate queue',
  ).toHaveCount(0, { timeout: 60_000 });

  await page.screenshot({ path: 'shots/03-after-release.png', fullPage: true });
  expect(await errorBanners(page)).toEqual([]);
});

test('the release is written to the Greenlight audit log', async ({ page }) => {
  await page.goto('/');
  await waitForShell(page);
  await sidebarEntry(page, 'Greenlight Audit Log').click();

  // The override is the one event a compliance reviewer has to be able to find,
  // so it has to be readable in the log's own table, not only through the API.
  const logRow = page.locator('[data-testid^="row-id-"]').filter({
    hasText: `GreenlightE2E ${LEAD_NAME}`,
  });

  await expect(logRow.first(), 'the release must appear in the audit log').toBeVisible({
    timeout: 60_000,
  });
  await expect(logRow.first()).toContainText(/override|release/i);

  await page.screenshot({ path: 'shots/03-audit-log.png', fullPage: true });
  expect(heldScore).not.toBeNull();

  // One lead, one band. The release path never wrote a band, so the RELEASED
  // row took the field's Unscored default while the GATED row for the same
  // lead — same score, same run — read Poor. A compliance record that states
  // two different bands for one decision is worse than one that states none,
  // because a reviewer cannot tell which row is lying.
  //
  // Asserted on every row this lead produced rather than on a fixed value, so
  // it is the *agreement* being tested and not the shipped thresholds.
  const BANDS = ['Excellent', 'Good', 'Fair', 'Poor', 'Unscored'];
  const rowTexts = await logRow.allInnerTexts();

  expect(
    rowTexts.length,
    'this lead should have produced at least a GATED row and a RELEASED row',
  ).toBeGreaterThanOrEqual(2);

  const bandsSeen = new Set(
    rowTexts.map(
      (text) => BANDS.find((band) => new RegExp(`\\b${band}\\b`).test(text)) ?? 'none',
    ),
  );

  expect(
    [...bandsSeen],
    'every audit row for one lead must agree on its band',
  ).toHaveLength(1);
  expect(
    [...bandsSeen],
    'the release must carry the band the scoring run recorded, not the ' +
      'Unscored default it used to fall back to',
  ).not.toContain('Unscored');
});
