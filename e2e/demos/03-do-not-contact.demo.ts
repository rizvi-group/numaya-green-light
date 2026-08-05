import { expect, test } from '@playwright/test';

import {
  createPerson,
  deletePerson,
  readPerson,
  waitForDecision,
} from '../support/twenty-api';
import {
  openCommandMenu,
  selectRow,
  sidebarEntry,
  tableRow,
  waitForShell,
} from '../support/ui';
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
  spotlightUnion,
  titleCard,
} from './support/demo';

/**
 * Demo 3 — do not contact.
 *
 * Twenty has no email management at all: no send, no unsubscribe handling, no
 * suppression register. So a "they asked us to stop" fact has nowhere to live in
 * the CRM, and the first person to find that out is usually the one who emailed
 * somebody who had already asked twice.
 *
 * This is Greenlight's own register. What the recording has to make legible is
 * that it is not a checkbox: the block is a reason on record, the lead re-scores
 * to blocked without anyone asking it to, and it turns up on a list a compliance
 * reviewer can be handed.
 *
 * The lead is given an email address on purpose. A block is only interesting on
 * a lead somebody could otherwise have contacted.
 */

const stamp = `${Date.now()}`.slice(-4);
const FIRST_NAME = 'Rosa';
const LAST_NAME = `Bennett ${stamp}`;

let personId = '';

test.beforeAll(async () => {
  personId = await createPerson({
    name: { firstName: FIRST_NAME, lastName: LAST_NAME },
    emails: { primaryEmail: `rosa.bennett.${stamp}@example.com` },
    jobTitle: 'Chief Operating Officer',
  });

  await waitForDecision(personId);
});

test.afterAll(async () => {
  if (personId !== '') {
    await deletePerson(personId);
  }
});

test('demo: do not contact', async ({ page }) => {
  await installDemoChrome(page);

  await page.goto('/');
  await titleCard(
    page,
    'Do not contact',
    'Twenty does not manage email, so it has nowhere to record "stop contacting me". Greenlight does.',
    6_000,
  );

  await waitForShell(page);
  await dismissNoise(page);

  await say(page, 'A lead nobody would think twice about calling.', 3_000);

  await page.goto(`/object/person/${personId}`);
  await waitForShell(page);
  await dismissNoise(page);
  await page.waitForTimeout(2_500);

  const before = await readPerson(personId);

  await say(
    page,
    `${FIRST_NAME} is a good lead — a named contact, a real job title, a working address.`,
    5_000,
  );

  await spotlightUnion(
    page,
    [
      page.getByText('Lead score', { exact: true }).first(),
      page.getByText('Gate decision', { exact: true }).first(),
    ],
    500,
  );

  // Read out of the record rather than written into the script: if the engine
  // ever stops clearing a lead like this, the caption changes with it instead of
  // narrating something the screen is not showing.
  await say(
    page,
    `Greenlight scored her ${before?.greenlightScore ?? ''} out of 100 — ` +
      `${before?.greenlightDecision === 'PASS' ? 'cleared to work' : 'held for review'}.`,
    4_600,
  );
  await clearSpotlight(page);

  await say(page, 'Then she replies asking never to be emailed again.', 4_200);

  // --- the block -------------------------------------------------------------
  // "Do not contact (Greenlight)" is a RECORD_SELECTION command: it is offered
  // when exactly one row is ticked in a list, and never on a record page. So the
  // block is applied from the People list, which is also where a rep would be.
  await say(page, 'The block is applied from the list, on one person.', 3_800);

  await page.goto('/objects/people');
  await waitForShell(page);
  await dismissNoise(page);
  await say(page, 'Find her, tick her, open the command menu.', 3_200);
  await expect(tableRow(page, personId)).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(1_200);

  await selectRow(page, personId);
  await page.waitForTimeout(900);
  await openCommandMenu(page);
  await page.waitForTimeout(1_200);

  const suppressCommand = page.getByText('Do not contact (Greenlight)');
  await expect(suppressCommand).toBeVisible({ timeout: 60_000 });
  await spotlight(page, suppressCommand, 1_000);
  await clearSpotlight(page);
  await pointAndClick(page, suppressCommand);

  await expect(page.getByText('Do not contact this person')).toBeVisible({
    timeout: 60_000,
  });
  await page.waitForTimeout(1_600);

  await say(
    page,
    'The reason is required, and it is picked from a fixed list.',
    4_400,
  );

  await pointAndClick(page, page.getByText('Unsubscribed', { exact: true }));
  await page.waitForTimeout(1_000);

  const note = page.getByPlaceholder(
    'Replied to the March newsletter asking to be removed.',
  );
  await note.click();
  await note.pressSequentially(
    'Replied to the August campaign asking to be taken off the list.',
    { delay: 26 },
  );
  await page.waitForTimeout(1_200);

  await say(page, 'One person at a time. Never in bulk.', 3_400);

  await pointAndClick(
    page,
    page.getByRole('button', { name: 'Add to block list' }),
  );

  // --- it re-scores itself ---------------------------------------------------
  await say(
    page,
    'Nobody has to re-score her. The block does it.',
    3_800,
  );

  await expect
    .poll(async () => (await readPerson(personId))?.greenlightDecision, {
      timeout: 120_000,
      message: 'the block should re-score the lead to BLOCKED',
    })
    .toBe('BLOCKED');

  const after = await readPerson(personId);

  // A reload is the only way Twenty's cached record page shows the new values —
  // the same staleness the release panel warns about, and the reason this is a
  // navigation rather than a wait.
  await page.goto(`/object/person/${personId}`);
  await waitForShell(page);
  await dismissNoise(page);
  await page.waitForTimeout(3_000);

  // The label column and the value column are separate nodes, so the ring has to
  // span both or it highlights four words and none of the answers.
  await spotlightUnion(
    page,
    [
      page.getByText('Lead score', { exact: true }).first(),
      page.getByText('Blocked since', { exact: true }).first(),
      page.getByText('Unsubscribed', { exact: true }).first(),
    ],
    600,
  );
  await say(
    page,
    `Score ${before?.greenlightScore ?? ''} became ${after?.greenlightScore ?? ''}. The decision is now Blocked.`,
    5_400,
  );
  await say(
    page,
    'The reason, the note and the date it happened are all on the record.',
    5_000,
  );
  await clearSpotlight(page);

  // --- the register ----------------------------------------------------------
  await say(
    page,
    'And she is on the list you hand to whoever asks who you have stopped contacting.',
    5_400,
  );

  await page.goto('/');
  await waitForShell(page);
  await dismissNoise(page);
  await say(page, 'Greenlight keeps its own register.', 2_600);
  await pointAndClick(page, sidebarEntry(page, 'Greenlight Do Not Contact'));
  await restPointer(page);

  const row = tableRow(page, personId);
  await expect(row).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(2_000);

  await spotlight(page, row, 800);
  await say(
    page,
    'Greenlight Do Not Contact. Every block, with its reason and its date.',
    5_600,
  );
  await clearSpotlight(page);

  await clearCaption(page);
  await titleCard(
    page,
    'The register the CRM does not have',
    'A block cannot be lifted by hand: only the person themselves can ask to come back.',
    5_400,
  );

  await saveDemoVideo(page, '03-do-not-contact');
});
