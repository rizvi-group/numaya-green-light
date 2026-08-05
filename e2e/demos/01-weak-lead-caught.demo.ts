import { expect, test } from '@playwright/test';

import {
  createPerson,
  deletePerson,
  readPerson,
  waitForDecision,
  type ScoredPerson,
} from '../support/twenty-api';
import { sidebarEntry, tableRow, waitForShell } from '../support/ui';
import {
  clearCaption,
  clearSpotlight,
  dismissNoise,
  installDemoChrome,
  pointAndClick,
  restPointer,
  say,
  spotlight,
  spotlightUnion,
  saveDemoVideo,
  titleCard,
  traceCard,
} from './support/demo';

/**
 * Demo 1 — a weak lead is caught.
 *
 * The lead is created through the API, exactly as the test suite creates its
 * fixtures: a person arriving from a web form is not something a viewer learns
 * anything from watching be typed, and Greenlight's claim starts the moment the
 * record exists. Everything after that is the real product.
 *
 * The rule-by-rule trace is the point of this one. It is also the part the
 * product cannot currently show: `greenlightTrace` is a RAW_JSON column and
 * Twenty renders RAW_JSON as one truncated line in a 200px box, so a rep can see
 * that a trace exists and cannot read a word of it. The demo therefore reads the
 * column and prints it, and says on screen that the formatting is the demo's and
 * the words are the app's.
 */

const stamp = `${Date.now()}`.slice(-4);
const FIRST_NAME = 'Jordan';
const LAST_NAME = `Vale ${stamp}`;
const FULL_NAME = `${FIRST_NAME} ${LAST_NAME}`;

let personId = '';
let scored: ScoredPerson;

test.beforeAll(async () => {
  personId = await createPerson({
    name: { firstName: FIRST_NAME, lastName: LAST_NAME },
  });

  scored = await waitForDecision(personId);

  // Not a product assertion — a recording precondition. If the engine did not
  // gate this lead there is no scenario to record, and finding that out here is
  // far better than shipping ninety seconds of video narrating the wrong thing.
  expect(
    scored.greenlightDecision,
    'demo 1 needs a genuinely gated lead; the engine did not gate this one',
  ).toBe('GATE');
});

test.afterAll(async () => {
  if (personId !== '') {
    await deletePerson(personId);
  }
});

test('demo: a weak lead is caught', async ({ page }) => {
  await installDemoChrome(page);

  // The title card goes up before the shell is waited for, so it covers Twenty's
  // boot rather than the recording opening on five seconds of empty page.
  await page.goto('/');
  await titleCard(
    page,
    'A weak lead is caught',
    'Greenlight scores every lead as it arrives and holds the ones that are not worth a call.',
    5_500,
  );

  await waitForShell(page);
  await dismissNoise(page);

  await say(
    page,
    'This is Twenty, the CRM. Greenlight adds a quality gate inside it.',
    3_800,
  );

  // --- the lead as it arrived ------------------------------------------------
  await say(page, 'Every lead goes through it, the moment it is created.', 3_000);

  await page.goto(`/object/person/${personId}`);
  await waitForShell(page);
  await dismissNoise(page);
  await page.waitForTimeout(2_500);

  await say(
    page,
    `A lead came in a moment ago. This is everything we know about ${FIRST_NAME}.`,
    4_000,
  );

  await spotlightUnion(
    page,
    [
      page.getByText('Emails', { exact: true }).first(),
      page.getByText('Job Title', { exact: true }).first(),
    ],
    500,
  );
  await say(
    page,
    'No email address. No phone number. No company. No job title.',
    4_600,
  );
  await clearSpotlight(page);

  // --- the verdict, on the record --------------------------------------------
  await spotlightUnion(
    page,
    [
      page.getByText('Lead score', { exact: true }).first(),
      page.getByText('Gate', { exact: true }).first(),
    ],
    500,
  );

  const scoreText = String(scored.greenlightScore);
  await say(
    page,
    `Greenlight scored it the moment it landed: ${scoreText} out of 100.`,
    4_200,
  );
  await say(
    page,
    'The decision is "Gate" — held for a person to look at, not deleted and not passed on.',
    5_000,
  );
  await clearSpotlight(page);

  // --- the queue a reviewer works from ---------------------------------------
  await say(page, 'Held leads collect in one place.', 2_600);

  await page.goto('/');
  await waitForShell(page);
  await dismissNoise(page);
  await pointAndClick(page, sidebarEntry(page, 'Greenlight Gate Queue'));
  await restPointer(page);

  const row = tableRow(page, personId);
  await expect(row).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(1_800);

  await spotlight(page, row, 600);
  await say(
    page,
    'The gate queue. Every held lead, with its score and the reason it is here.',
    5_000,
  );
  await clearSpotlight(page);

  // --- why -------------------------------------------------------------------
  await say(
    page,
    'A score nobody can question is just a number. So Greenlight records why.',
    4_600,
  );

  // Read the trace back off the record at recording time rather than reusing the
  // value fetched in beforeAll, so what is displayed is what the record holds
  // now — including anything that has re-scored it since.
  const current = await readPerson(personId);

  await traceCard(
    page,
    current?.greenlightTrace ?? scored.greenlightTrace,
    FULL_NAME,
    current?.greenlightScore ?? scored.greenlightScore,
    17_000,
  );

  await say(
    page,
    'Eleven rules, each with its own verdict, in words a salesperson can argue with.',
    5_000,
  );

  await clearCaption(page);
  await titleCard(
    page,
    'Nothing was thrown away',
    'The lead is held, explained, and one click from being released. That is the next demo.',
    5_000,
  );

  await saveDemoVideo(page, '01-a-weak-lead-is-caught');
});
