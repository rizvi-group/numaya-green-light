import { expect, test } from '@playwright/test';

import {
  createPerson,
  deletePerson,
  traceCalibration,
  traceRule,
  waitForDecision,
  type ScoredPerson,
} from '../support/twenty-api';
import { errorBanners, sidebarEntry, waitForShell } from '../support/ui';

/**
 * Test (e): a licence delivers scoring calibration, and a lead scores
 * differently because of it.
 *
 * ===========================================================================
 * ## The control, and why the test needs one
 *
 * "The German title passed" only means something if we also know the rule works
 * at all. So two leads are created in the same run against the same config:
 *
 *   CONTROL   jobTitle "Chief Executive Officer" — matches the twenty-five
 *             titles shipped in `src/scoring/defaults.ts`, so it passes
 *             `contact.decision-maker` whether or not calibration is present.
 *
 *   SUBJECT   jobTitle "Geschäftsführer" — the German for managing director. It
 *             appears nowhere in the shipped list. It passes **only** if the
 *             licence-delivered vocabulary reached the rule.
 *
 * If calibration is off, CONTROL passes and SUBJECT fails, and the diff between
 * them is exactly what the licence bought. If the whole rule were broken, both
 * would fail and the control assertion would say so first, rather than leaving
 * a confusing "calibration is not working" on a run where nothing was working.
 *
 * `contact.decision-maker` is the highest-weighted rule in the product at 20
 * points, so the difference is visible in the score as well as in the trace.
 *
 * ## What is asserted in the browser
 *
 * The trace assertions below are read through the API because a RAW_JSON blob
 * is not something a human reads off a screen. But the *claim* being verified —
 * "an admin can tell whether they are running shipped defaults or calibration
 * vNN" — is a UI claim, so it is also asserted against the record page and
 * against the audit log, which is where an admin would actually look.
 * ===========================================================================
 */

const stamp = Date.now();

const CONTROL = {
  name: { firstName: 'GreenlightE2E', lastName: `Control${stamp}` },
  jobTitle: 'Chief Executive Officer',
};

const SUBJECT = {
  name: { firstName: 'GreenlightE2E', lastName: `Kalibriert${stamp}` },
  jobTitle: 'Geschäftsführer',
};

let controlId: string;
let subjectId: string;
let control: ScoredPerson;
let subject: ScoredPerson;

test.beforeAll(async () => {
  controlId = await createPerson(CONTROL);
  subjectId = await createPerson(SUBJECT);

  control = await waitForDecision(controlId);
  subject = await waitForDecision(subjectId);
});

test.afterAll(async () => {
  for (const id of [controlId, subjectId]) {
    if (id) {
      await deletePerson(id);
    }
  }
});

test.describe('a licence delivers calibration that changes a score', () => {
  test('the control lead passes on the shipped title list', () => {
    // Precondition, not the feature. If this fails the rule itself is broken and
    // every assertion below would be measuring the wrong thing.
    const rule = traceRule(control.greenlightTrace, 'contact.decision-maker');

    expect(rule, 'the decision-maker rule did not appear in the trace').not.toBeNull();
    expect(rule?.outcome).toBe('pass');
  });

  test('a German title passes only because calibration was delivered', () => {
    const rule = traceRule(subject.greenlightTrace, 'contact.decision-maker');

    expect(rule).not.toBeNull();
    expect(
      rule?.outcome,
      '"Geschäftsführer" is not in the twenty-five shipped decision-maker ' +
        'titles. A pass here means the licence-delivered vocabulary reached the ' +
        'rule; a fail means the workspace is on shipped defaults.',
    ).toBe('pass');

    // The matched keyword is the actual proof: it names the entry that fired,
    // and that entry only exists in the calibration pack.
    expect(JSON.stringify(rule)).toContain('geschäftsführer');
  });

  test('the trace records which calibration produced the score', () => {
    const calibration = traceCalibration(subject.greenlightTrace);

    expect(
      calibration,
      'every trace must carry a calibration stamp, including the ' +
        'shipped-defaults case — "we did not record it" and "we used the ' +
        'defaults" must not look the same months later',
    ).not.toBeNull();

    expect(calibration?.source).toBe('licensed');
    expect(typeof calibration?.version).toBe('number');
  });

  test('both leads scored, and the calibrated one is not penalised', () => {
    // The two leads differ only in job title, and both titles are
    // decision-maker titles once calibration is in play, so the scores match.
    // Without calibration the subject would be 20 points of weight worse off.
    expect(control.greenlightScore).not.toBeNull();
    expect(subject.greenlightScore).not.toBeNull();
    expect(subject.greenlightScore).toBe(control.greenlightScore);
  });

  test('the record page shows the score the calibration produced', async ({
    page,
  }) => {
    await page.goto(`/object/person/${subjectId}`);
    await waitForShell(page);

    await expect(
      page.getByText(`GreenlightE2E Kalibriert${stamp}`).first(),
    ).toBeVisible();

    const fieldsPanel = page
      .locator('div')
      .filter({ hasText: /^Fields/ })
      .first();

    await expect(fieldsPanel).toContainText('Greenlight score', {
      timeout: 60_000,
    });
    await expect(fieldsPanel).toContainText(String(subject.greenlightScore));

    await page.screenshot({
      path: 'shots/05-calibrated-record.png',
      fullPage: true,
    });
    expect(await errorBanners(page)).toEqual([]);
  });

  test('the audit log says which calibration the workspace is running', async ({
    page,
  }) => {
    await page.goto('/');
    await waitForShell(page);
    await sidebarEntry(page, 'Greenlight Audit Log').click();

    // The licence run stamps the row name with "calibration vNN" or "shipped
    // defaults" — the whole answer to "which vocabulary am I on", readable from
    // a list view without opening anything.
    //
    // Reached through the sidebar rather than by URL: the audit-log view is the
    // one an admin actually navigates to, and a direct `/object/...` route both
    // skips the navigation item under test and turned out not to render the
    // rows at all.
    await expect(page.getByText(/LICENCE ·/).first()).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText(/calibration v\d+/).first()).toBeVisible({
      timeout: 60_000,
    });

    await page.screenshot({
      path: 'shots/05-calibration-audit.png',
      fullPage: true,
    });
    expect(await errorBanners(page)).toEqual([]);
  });
});
