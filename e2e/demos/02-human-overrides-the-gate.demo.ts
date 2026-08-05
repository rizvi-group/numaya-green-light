import { expect, test } from '@playwright/test';

import {
  createPerson,
  deletePerson,
  readAuditRowsForLead,
  waitForDecision,
  type ScoredPerson,
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
  showCard,
  spotlight,
  titleCard,
} from './support/demo';

/**
 * Demo 2 — a human overrides the gate.
 *
 * The GDPR Article 22 story. What has to be visible is not that a lead can be
 * let through, but that letting it through is a considered decision with a name
 * and a reason attached to it: the reason list is closed, the submit button is
 * dead until a reason is picked, one lead at a time, and the result is a row in
 * an append-only log.
 *
 * Recorded from the gate queue rather than the record page because that is where
 * the command lives — "Release lead (Greenlight)" is a RECORD_SELECTION command
 * and only appears once exactly one row is ticked.
 */

const stamp = `${Date.now()}`.slice(-4);
const FIRST_NAME = 'Marcus';
const LAST_NAME = `Ilic ${stamp}`;
const FULL_NAME = `${FIRST_NAME} ${LAST_NAME}`;

let personId = '';
let scored: ScoredPerson;

test.beforeAll(async () => {
  personId = await createPerson({
    name: { firstName: FIRST_NAME, lastName: LAST_NAME },
  });

  scored = await waitForDecision(personId);

  expect(
    scored.greenlightDecision,
    'demo 2 needs a genuinely held lead to release',
  ).toBe('GATE');
});

test.afterAll(async () => {
  if (personId !== '') {
    await deletePerson(personId);
  }
});

test('demo: a human overrides the gate', async ({ page }) => {
  await installDemoChrome(page);

  await page.goto('/');
  await titleCard(
    page,
    'A human overrides the gate',
    'The gate is advice, not a verdict. Anyone can let a lead through — on the record.',
    5_500,
  );

  await waitForShell(page);
  await dismissNoise(page);

  await say(
    page,
    'Greenlight never has the last word. A person always can.',
    3_800,
  );

  await pointAndClick(page, sidebarEntry(page, 'Greenlight Gate Queue'));
  await restPointer(page);

  const row = tableRow(page, personId);
  await expect(row).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(1_500);

  await spotlight(page, row, 400);
  await say(
    page,
    `${FIRST_NAME} was held at ${scored.greenlightScore} out of 100. A rep thinks that is wrong.`,
    4_600,
  );
  await clearSpotlight(page);

  // --- reaching the override -------------------------------------------------
  await say(page, 'They tick the lead and open the command menu.', 3_200);

  await selectRow(page, personId);
  await page.waitForTimeout(900);
  await openCommandMenu(page);
  await page.waitForTimeout(1_400);

  const releaseCommand = page.getByText('Release lead (Greenlight)');
  await expect(releaseCommand).toBeVisible({ timeout: 60_000 });
  await spotlight(page, releaseCommand, 1_200);
  await say(page, 'Release lead.', 2_400);
  await clearSpotlight(page);

  await pointAndClick(page, releaseCommand);

  // --- the panel -------------------------------------------------------------
  await expect(page.getByText('Release this lead')).toBeVisible({
    timeout: 60_000,
  });
  await page.waitForTimeout(1_500);

  await say(
    page,
    'Releasing is not one click. Greenlight asks why, and the answer is kept.',
    5_000,
  );

  const submit = page.getByRole('button', { name: 'Release lead', exact: true });
  await expect(submit).toBeDisabled();
  await spotlight(page, submit, 1_000);
  await say(
    page,
    'Until a reason is chosen, the button does nothing.',
    3_800,
  );
  await clearSpotlight(page);

  await say(page, 'Five reasons. No free-text-only escape hatch.', 3_600);

  const reason = page.getByText(
    'Lead data is incomplete but I know this is a good lead',
  );
  await pointAndClick(page, reason);
  await page.waitForTimeout(1_200);

  await say(page, 'And a note for whoever reads this in six months.', 3_600);

  const note = page.getByPlaceholder(
    'Context a colleague would need in six months.',
  );
  await note.click();
  await note.pressSequentially(
    'Inbound request from an existing account. Contact details to follow.',
    { delay: 28 },
  );
  await page.waitForTimeout(1_400);

  await expect(submit).toBeEnabled();
  await pointAndClick(page, submit);

  // --- the confirmation ------------------------------------------------------
  await expect(page.getByText('Lead released')).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(1_600);

  await say(page, 'Released, and the gate on the record is now clear.', 4_200);

  await spotlight(
    page,
    page.getByText('The queue behind this panel is out of date'),
    600,
  );
  await say(
    page,
    'The panel is also honest about its own limits: the list behind it is stale until you reload.',
    5_600,
  );
  await clearSpotlight(page);

  // --- the audit row ---------------------------------------------------------
  await say(
    page,
    'Every override lands in a log nobody can edit afterwards.',
    4_000,
  );

  await page.goto('/');
  await waitForShell(page);
  await dismissNoise(page);
  await say(page, 'Greenlight keeps its own audit log.', 2_600);
  await pointAndClick(page, sidebarEntry(page, 'Greenlight Audit Log'));
  await restPointer(page);

  const logRow = page
    .locator('[data-testid^="row-id-"]')
    .filter({ hasText: FULL_NAME });

  await expect(logRow.first()).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(2_000);

  await spotlight(page, logRow.first(), 800);
  await say(
    page,
    'The release, at the top: who did it, when, the score and the band it was released from.',
    6_200,
  );
  await say(
    page,
    'The line under it is the gate holding the same lead ten seconds earlier.',
    5_000,
  );
  await clearSpotlight(page);

  // The reason is the Article 22 evidence and it is *not* one of this view's
  // columns. Opening the row is what a compliance reviewer would have to do, so
  // the demo does it rather than claiming the list already shows it.
  await say(page, 'The reason itself is one level in — on the row.', 3_600);

  // Opened by id rather than by clicking the row's chip. Moving the pointer onto
  // a clipped table cell raises Twenty's own overflow tooltip directly over the
  // link, and the click then lands on the tooltip: the first take of this demo
  // failed exactly there, twice, and a forced click merely hit the tooltip
  // instead. This is the same record page the chip opens.
  const rows = await readAuditRowsForLead(FULL_NAME);
  const released = rows.find((row) => row.eventType === 'RELEASED');

  expect(released, 'the release must have written an audit row').toBeDefined();

  await page.goto(`/object/greenlightAuditLog/${released?.id ?? ''}`);
  await waitForShell(page);
  await dismissNoise(page);
  await page.waitForTimeout(3_000);

  const reasonValue = page.getByText(/^DATA_INCOMPLETE ·/).first();
  await expect(reasonValue).toBeVisible({ timeout: 60_000 });
  await spotlight(page, reasonValue, 800);
  await say(
    page,
    'Recorded against a human actor, with the category they picked.',
    5_200,
  );
  await clearSpotlight(page);

  // ...and the record page clips it to about thirty characters, so the sentence
  // a reviewer most needs is the one they cannot read. Printed here off the row
  // itself, with the card saying whose formatting it is.
  await showCard(
    page,
    `<div style="width:1200px;color:#fff;font-family:Inter,-apple-system,sans-serif;">
       <div style="font-size:30px;font-weight:700;margin-bottom:20px;">
         What the log actually recorded
       </div>
       <div style="display:grid;grid-template-columns:220px 1fr;gap:14px 26px;font-size:20px;line-height:1.45;">
         <div style="color:#8b98a5;">Event</div><div>${released?.eventType ?? '—'}</div>
         <div style="color:#8b98a5;">Lead</div><div>${FULL_NAME}</div>
         <div style="color:#8b98a5;">Score at release</div><div>${released?.score ?? '—'} &middot; ${String(released?.band ?? '').toLowerCase()}</div>
         <div style="color:#8b98a5;">Decided by</div><div>a ${String(released?.actorType ?? '').toLowerCase()}, not the engine</div>
         <div style="color:#8b98a5;">Reason</div><div style="color:#5fd39b;">${released?.overrideReason ?? '—'}</div>
       </div>
       <div style="margin-top:26px;font-size:14px;color:#6f7d8b;font-style:italic;">
         Read back off the audit row. The record page clips the reason to about
         thirty characters, so this demo has printed it in full — the words are
         the ones the reviewer typed.
       </div>
     </div>`,
    13_000,
  );

  await clearCaption(page);
  await titleCard(
    page,
    'A decision, not a rubber stamp',
    'One lead at a time, a reason from a closed list, and a permanent record of who decided.',
    5_200,
  );

  await saveDemoVideo(page, '02-a-human-overrides-the-gate');
});
