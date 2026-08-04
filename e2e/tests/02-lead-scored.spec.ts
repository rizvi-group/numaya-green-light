import { expect, test } from '@playwright/test';

import {
  createPerson,
  deletePerson,
  waitForDecision,
  type ScoredPerson,
} from '../support/twenty-api';
import { errorBanners, sidebarEntry, tableRow, waitForShell } from '../support/ui';

/**
 * Test (b): a weak lead is scored, the outcome is visible to a human, and the
 * lead is in the queue a human works from.
 *
 * The lead is created through the API — a five-field form is not what is under
 * test — but every assertion below is against the browser.
 *
 * ## What "visible on the record" means, and what it used to mean
 *
 * It used to mean the timeline. The Fields panel renders the "Person Record
 * Page Fields" view, that view held no Greenlight view fields, and so the score,
 * the decision, the trace, the four suppression fields and the three enrichment
 * fields appeared nowhere on the record — the only place a score surfaced was a
 * collapsed timeline entry reading "Numaya Greenlight updated 4 fields". The
 * test below used to *pin* that: it asserted the panel did **not** contain the
 * word "Greenlight", with a message saying to rewrite it the day the record page
 * was fixed.
 *
 * That day is here. Ten standalone `defineViewField`s put every Greenlight field
 * into the panel, so the pin is inverted rather than deleted: the same panel,
 * the same locator, the opposite assertion. A future change that drops those
 * view fields fails here, loudly, in the place the original bug was found.
 */

const stamp = Date.now();
const WEAK_LEAD = {
  name: { firstName: 'GreenlightE2E', lastName: `Weak${stamp}` },
};

let personId: string;
let scored: ScoredPerson;

test.beforeAll(async () => {
  personId = await createPerson(WEAK_LEAD);
  scored = await waitForDecision(personId);
});

test.afterAll(async () => {
  if (personId) {
    await deletePerson(personId);
  }
});

test.describe('a weak lead is scored and held', () => {
  test('the engine gated it', () => {
    // Not a UI assertion — a precondition. If the engine did not gate this lead
    // the two UI tests below would be asserting the wrong thing, and the failure
    // should say so here rather than as a confusing "row not found" later.
    expect(scored.greenlightDecision).toBe('GATE');
    expect(scored.greenlightScore).not.toBeNull();
  });

  test('the record page shows the score and the decision', async ({ page }) => {
    await page.goto(`/object/person/${personId}`);
    await waitForShell(page);

    await expect(
      page.getByText(`GreenlightE2E Weak${stamp}`).first(),
    ).toBeVisible();

    const fieldsPanel = page
      .locator('div')
      .filter({ hasText: /^Fields/ })
      .first();

    // Read out of the Fields panel, not the timeline: this is the surface a rep
    // is actually looking at when they decide whether to call someone.
    await expect(fieldsPanel).toContainText('Greenlight score', {
      timeout: 60_000,
    });
    await expect(fieldsPanel).toContainText(String(scored.greenlightScore));
    await expect(fieldsPanel).toContainText('Greenlight decision');
    await expect(fieldsPanel).toContainText('Gate');

    await page.screenshot({ path: 'shots/02-record.png', fullPage: true });
    expect(await errorBanners(page)).toEqual([]);
  });

  test('the Fields panel carries every Greenlight field', async ({ page }) => {
    await page.goto(`/object/person/${personId}`);
    await waitForShell(page);

    const fieldsPanel = page
      .locator('div')
      .filter({ hasText: /^Fields/ })
      .first();

    await expect(fieldsPanel).toContainText('Greenlight score', {
      timeout: 60_000,
    });

    const panelText = await fieldsPanel.innerText();

    // The inversion of the old pin. Every field the app writes to a Person has
    // to be readable on that Person, by label, in the sections they were
    // assigned to: the verdict and the do-not-contact flags in General,
    // enrichment in Work, the rule trace in System.
    const EXPECTED_LABELS = [
      'Greenlight score',
      'Greenlight decision',
      'Do not contact',
      'Do not contact reason',
      'Do not contact note',
      'Do not contact since',
      'Enrichment status',
      'Last enriched',
      'Greenlight enrichment',
      'Greenlight trace',
    ];

    const missing = EXPECTED_LABELS.filter(
      (label) => !panelText.includes(label),
    );

    expect(
      missing,
      'every Greenlight field must be readable on the record itself — this is ' +
        'the inverted form of the pin that used to assert the panel omitted ' +
        'them all',
    ).toEqual([]);

    // The three sections they were filed under, so a regression that dumps them
    // all into one bucket is visible here too.
    for (const section of ['General', 'Work', 'System']) {
      expect(panelText, `the ${section} section is missing`).toContain(section);
    }

    await page.screenshot({ path: 'shots/02-record-fields.png', fullPage: true });
    expect(await errorBanners(page)).toEqual([]);
  });

  test('the lead is in the gate queue with its score and decision', async ({
    page,
  }) => {
    await page.goto('/');
    await waitForShell(page);
    await sidebarEntry(page, 'Greenlight Gate Queue').click();

    const row = tableRow(page, personId);
    await expect(row).toBeVisible({ timeout: 60_000 });
    await expect(row).toContainText(`GreenlightE2E Weak${stamp}`);
    await expect(row).toContainText(String(scored.greenlightScore));
    await expect(row).toContainText('Gate');

    await page.screenshot({ path: 'shots/02-gate-queue.png', fullPage: true });
    expect(await errorBanners(page)).toEqual([]);
  });
});
