import { expect, test } from '@playwright/test';

import { sidebarEntry, waitForShell } from '../support/ui';
import {
  clearCaption,
  clearSpotlight,
  dismissNoise,
  installDemoChrome,
  pointAndClick,
  restPointer,
  say,
  saveDemoVideo,
  spotlight,
  titleCard,
} from './support/demo';

/**
 * Demo 4 — the ideal customer profile page.
 *
 * The onboarding screen, and the one that has to be shown *without* being
 * improved. Greenlight ships the profile empty because it cannot know a
 * customer's market, and the honest consequence is that a third of the scoring
 * model does nothing until somebody fills it in. The page leads with that
 * arithmetic rather than burying it.
 *
 * ## Read-only, deliberately
 *
 * The recording clicks "Suggest a profile from my data", which only reads the
 * Company table. It never clicks "Apply this profile" or "Leave the profile
 * open, deliberately": both write workspace configuration, both would change
 * what every other demo and every test in `e2e/tests/` scores against, and the
 * suite asserts the exact "40 of 130" figure this screen is showing.
 *
 * What the suggestion returns on this workspace is nothing, because Twenty's
 * seeded companies carry no industry, region or headcount. That is the take —
 * a page that says "there is no evidence here" instead of inventing a profile
 * is worth more than one that always has an answer.
 */

test('demo: the ICP page', async ({ page }) => {
  await installDemoChrome(page);

  await page.goto('/');
  await titleCard(
    page,
    'What are you actually looking for?',
    'Greenlight ships with no idea of your market — and says so, in points.',
    5_800,
  );

  await waitForShell(page);
  await dismissNoise(page);

  await pointAndClick(page, sidebarEntry(page, 'Greenlight ICP'));
  await restPointer(page);

  await expect(page.getByText('Ideal customer profile')).toBeVisible({
    timeout: 90_000,
  });
  await page.waitForTimeout(2_000);

  await say(
    page,
    'Scoring judges two things: can we reach this lead, and is it a fit.',
    5_000,
  );

  const headline = page.getByText(/\d+ of \d+ scoring points are switched off/);
  await expect(headline).toBeVisible();
  await spotlight(page, headline, 800);

  await say(
    page,
    'Right now this workspace only answers the first one.',
    4_000,
  );
  await say(
    page,
    'Forty of the hundred and thirty points are switched off, and the page leads with that number.',
    6_000,
  );
  await clearSpotlight(page);

  await spotlight(page, page.getByText('not set · 20 pts idle').first(), 600);
  await say(
    page,
    'Industry, region and company size: not set, so they score nothing at all.',
    5_400,
  );
  await clearSpotlight(page);

  await say(
    page,
    'Rather than ask you to guess, Greenlight will read the companies you already have.',
    5_600,
  );

  await pointAndClick(
    page,
    page.getByText('Suggest a profile from my data'),
  );

  await expect(page.getByText('Where this comes from')).toBeVisible({
    timeout: 180_000,
  });
  await page.waitForTimeout(2_500);

  await say(page, 'And here it tells the truth about them.', 3_800);

  const evidence = page.getByText(
    /Based on the \d+ most recently added of your [\d,]+ companies/,
  );
  await spotlight(page, evidence, 800);
  await say(
    page,
    'It says exactly where it looked, so the claim can be checked rather than trusted.',
    5_600,
  );
  await clearSpotlight(page);

  const admission = page.getByText(
    /None of the \d+ companies examined has an industry recorded/,
  );
  await expect(admission).toBeVisible();
  await spotlight(page, admission, 800);
  await say(
    page,
    'None of the companies examined has an industry recorded. So it proposes nothing.',
    6_000,
  );
  await say(
    page,
    'A tool that invented a profile here would be worse than one that admits it cannot.',
    5_800,
  );
  await clearSpotlight(page);

  await say(
    page,
    'That missing company data is what the last demo is about.',
    4_200,
  );

  await clearCaption(page);
  await titleCard(
    page,
    'Nothing was written',
    'The suggestion is evidence, not a setting. This workspace is unchanged.',
    5_200,
  );

  await saveDemoVideo(page, '04-the-icp-page');
});
