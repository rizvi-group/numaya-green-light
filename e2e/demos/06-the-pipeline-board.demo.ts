import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  attachNoteToOpportunity,
  createCompany,
  createNote,
  createOpportunity,
  createPerson,
  deleteAuditRowsForLeads,
  deleteCompany,
  deleteNote,
  deleteNoteTarget,
  deleteOpportunity,
  deletePerson,
  findCompaniesByName,
  findPersonByEmail,
  opportunitiesForPerson,
  postPipeline,
  readAuditRowsForLead,
  readOpportunity,
  waitForDecision,
  type PersonInput,
} from '../support/twenty-api';
import {
  laneColumn,
  laneHeading,
  sidebarEntry,
  pipelineCard,
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
  spotlightBox,
  titleCard,
} from './support/demo';

/**
 * Demo 6 — the Greenlight Pipeline board.
 *
 * The stakeholder's complaint, in their words, was that the existing features
 * "felt disconnected and burden the sales person with thinking and connecting
 * the dots". PIPELINE_SPEC.md answers it in one line — "the product is not a
 * score, the product is the next move" — and this recording is that claim shown
 * rather than described.
 *
 * ## What is real here
 *
 * Everything on screen is the running app. The fixtures are created through the
 * API exactly as `e2e/tests/07-pipeline.spec.ts` creates its own, for the reason
 * demo 1 gives: nobody learns anything from watching a record-creation form be
 * typed, and the product's claim starts the moment the records exist. From there
 * the recording only clicks — the one thing it types is the capture drawer,
 * because three fields and a submit *is* the feature.
 *
 * Two beats write to the workspace, deliberately, because the writing is the
 * point: the handoff opens an Opportunity, and the override move changes a stage
 * and leaves an audit row. Everything either of them creates is removed in
 * `afterAll`, audit rows included — see `deleteAuditRowsForLeads` for why the log
 * in particular has to be taken back out.
 *
 * ## The one place this demo formats something
 *
 * The override receipt. `greenlightAuditLog.overrideReason` is the sentence a
 * compliance reviewer would come for, and Twenty's record page clips it to about
 * thirty characters, so the closing card prints it in full — and says on screen
 * that the formatting is the demo's and the words are the app's. Same rule, and
 * near enough the same wording, as demo 2.
 *
 * ## Two things it shows rather than tidies away
 *
 * The board is nine lanes of 268px and the viewport is 1600, so it scrolls
 * sideways and this recording pans it, which is what a rep does. No lane is
 * hidden and none is reordered.
 *
 * And the handoff line's own label — "Handoff · a lead becomes an opportunity" —
 * is set vertically down a column as tall as the tallest lane, so on a workspace
 * with sixty cards in Qualified it sits thousands of pixels below the fold and is
 * not on screen at the top of the board. The recording rings the line where it
 * is instead of scrolling the board to its middle to find the words. The claim is
 * carried by the board's own header sentence, which is on screen throughout.
 */

const stamp = `${Date.now()}`.slice(-4);

const COMPANY_NAME = `Arbor Freight ${stamp}`;
const COMPANY_DOMAIN = `arbor-freight-${stamp}.example`;

/** Qualified, scoring 100, and therefore the first card in its lane. */
const HANDOFF_NAME = `Amara Osei ${stamp}`;
/** Screening, with a discovery call written up: 1 of 1 met. */
const READY_NAME = `Devi Raman ${stamp}`;
/** Screening, with nothing logged against it: 0 of 1 met. */
const STUCK_NAME = `Tomas Ferrer ${stamp}`;

/** Typed into the capture drawer on camera. */
const CAPTURE_NAME = `Dana Okafor ${stamp}`;
const CAPTURE_COMPANY = `Halden Freight ${stamp}`;
const CAPTURE_EMAIL = `dana.okafor@halden-freight-${stamp}.example`;

const READY_DEAL = `${COMPANY_NAME} — fleet telematics`;
const STUCK_DEAL = `${COMPANY_NAME} — depot rollout`;

let companyId = '';
let handoffPersonId = '';
let readyPersonId = '';
let stuckPersonId = '';
let readyDealId = '';
let stuckDealId = '';
let noteId = '';
let noteTargetId = '';

const split = (full: string): { firstName: string; lastName: string } => {
  const [firstName, ...rest] = full.split(' ');

  return { firstName, lastName: rest.join(' ') };
};

test.beforeAll(async () => {
  companyId = await createCompany(COMPANY_NAME, {
    domainName: `https://${COMPANY_DOMAIN}`,
  });

  const lead = async (
    full: string,
    extra: Partial<PersonInput> = {},
  ): Promise<string> =>
    createPerson({
      name: split(full),
      jobTitle: 'Chief Technology Officer',
      emails: {
        primaryEmail: `${split(full).firstName.toLowerCase()}.${stamp}@${COMPANY_DOMAIN}`,
      },
      companyId,
      ...extra,
    });

  // A phone and a profile take this one to 100, which is what puts its card at
  // the top of a sixty-card Qualified lane where a viewer can see it. The board
  // sorts by the top action's cost and then by score; nothing here is arranged
  // by the demo beyond making the right card the visible one.
  handoffPersonId = await lead(HANDOFF_NAME, {
    phones: {
      primaryPhoneNumber: '7700900123',
      primaryPhoneCallingCode: '+44',
      primaryPhoneCountryCode: 'GB',
    },
    linkedinLink: { primaryLinkUrl: 'https://www.linkedin.com/in/example-amara' },
  });

  readyPersonId = await lead(READY_NAME);
  stuckPersonId = await lead(STUCK_NAME);

  readyDealId = await createOpportunity({
    name: READY_DEAL,
    stage: 'SCREENING',
    companyId,
    pointOfContactId: readyPersonId,
  });
  stuckDealId = await createOpportunity({
    name: STUCK_DEAL,
    stage: 'SCREENING',
    companyId,
    pointOfContactId: stuckPersonId,
  });

  // The only difference between the two Screening cards, and the whole contrast
  // the demo turns on: a Note attached to the deal is what the discovery-call
  // criterion reads. `default-role.ts` refused the workspace calendar in order
  // to answer that question from records a human deliberately attached instead.
  noteId = await createNote(`Discovery call — ${COMPANY_NAME}`);
  noteTargetId = await attachNoteToOpportunity(noteId, readyDealId);

  const [handoff] = await Promise.all([
    waitForDecision(handoffPersonId),
    waitForDecision(readyPersonId),
    waitForDecision(stuckPersonId),
  ]);

  // Recording preconditions, not product assertions. If the engine did not pass
  // this lead there is no Qualified card to hand across the line, and finding
  // that out here beats three minutes of video narrating the wrong thing.
  expect(
    handoff.greenlightDecision,
    'the handoff lead has to pass the gate to reach the Qualified lane',
  ).toBe('PASS');

  // The board's own free recompute, run once before the camera rolls so the
  // advice written on the records is the advice the screen will show. This is
  // the same call the "Recompute the advice" button makes, and it spends nothing.
  await postPipeline({ action: 'advise' }).catch(() => undefined);

  const stuck = await readOpportunity(stuckDealId);
  const ready = await readOpportunity(readyDealId);

  expect(
    stuck?.greenlightReadiness,
    'the stuck deal has to read 0% for the "0 of 1 met" beat to be true',
  ).toBe(0);
  expect(
    ready?.greenlightReadiness,
    'the note has to satisfy the discovery-call criterion, or there is no ' +
      'contrast to show',
  ).toBe(100);
});

test.afterAll(async () => {
  // Deals first: a Person that is a deal's point of contact will not delete
  // cleanly while the deal still points at it.
  const dealIds = [readyDealId, stuckDealId];

  for (const deal of await opportunitiesForPerson(handoffPersonId).catch(() => [])) {
    dealIds.push(deal.id);
  }

  if (noteTargetId !== '') {
    await deleteNoteTarget(noteTargetId).catch(() => undefined);
  }

  if (noteId !== '') {
    await deleteNote(noteId).catch(() => undefined);
  }

  for (const id of new Set(dealIds)) {
    if (id !== '') {
      await deleteOpportunity(id).catch(() => undefined);
    }
  }

  // The captured lead is found by its address rather than by an id this file
  // recorded, because a recording that failed after the submit never reaches a
  // line that could have recorded one.
  const captured = await findPersonByEmail(CAPTURE_EMAIL).catch(() => null);
  const companyIds = [companyId];

  if (captured?.companyId != null) {
    companyIds.push(captured.companyId);
  }

  for (const id of new Set([
    handoffPersonId,
    readyPersonId,
    stuckPersonId,
    captured?.id ?? '',
  ])) {
    if (id !== '') {
      await deletePerson(id).catch(() => undefined);
    }
  }

  // Whatever the capture chain opened, by the name it was told to use — the
  // point of that step is that the server decided whether to create one.
  for (const stray of await findCompaniesByName(CAPTURE_COMPANY).catch(() => [])) {
    companyIds.push(stray.id);
  }

  for (const id of new Set(companyIds)) {
    if (id !== '') {
      await deleteCompany(id).catch(() => undefined);
    }
  }

  // The log is workspace-global, append-only and read by another suite, so a
  // recording that adds a dozen rows has to take them back out.
  await deleteAuditRowsForLeads([
    HANDOFF_NAME,
    READY_NAME,
    STUCK_NAME,
    CAPTURE_NAME,
  ]).catch(() => undefined);
});

/* -------------------------------------------------------------------------- */
/* Camera work                                                                 */
/* -------------------------------------------------------------------------- */

/** The horizontally scrolling strip the nine lanes sit in. */
const laneStrip = (page: Page): Locator =>
  page.locator('section').first().locator('..');

/**
 * Open the board from the sidebar, without reloading the workspace.
 *
 * `openPipelineBoard` in `support/ui.ts` navigates to `/` first, which is right
 * for a test starting cold and costs a recording eight seconds of white screen
 * every time it is used mid-video. The sidebar is already on screen; clicking it
 * is both the cheaper shot and the one a rep performs.
 */
const openBoard = async (page: Page): Promise<void> => {
  await pointAndClick(page, sidebarEntry(page, 'Greenlight Pipeline'));
  await expect(laneHeading(page, 'Captured')).toBeVisible({ timeout: 90_000 });
  await restPointer(page);
};

/**
 * Put every scrollable ancestor of the board back to the top.
 *
 * Ringing a card scrolls it into view, and a lane on this workspace is fifteen
 * thousand pixels tall, so one highlight deep in a lane leaves the next shot
 * starting halfway down the board with no headers on screen.
 */
const toTop = async (page: Page): Promise<void> => {
  await page
    .evaluate(() => {
      let element = document.querySelector('section')?.parentElement ?? null;

      while (element !== null) {
        if (element.scrollHeight > element.clientHeight + 10) {
          element.scrollTop = 0;
        }

        element = element.parentElement;
      }

      window.scrollTo(0, 0);
    })
    .catch(() => undefined);

  await page.waitForTimeout(400);
};

/**
 * Pan the board sideways, slowly enough to follow.
 *
 * Nine lanes at 268px do not fit in 1600px and are not meant to: the board
 * scrolls, and a rep scrolls it. Jumping `scrollLeft` reads as a cut; this eases
 * it so the eye can keep hold of the lane it was watching. `to` is a fraction of
 * the scrollable width, so it does not depend on how many lanes have cards.
 */
const pan = async (page: Page, to: number, ms = 2_600): Promise<void> => {
  await laneStrip(page)
    .evaluate(
      (element, { fraction, duration }) =>
        new Promise<void>((resolve) => {
          const from = element.scrollLeft;
          const target = (element.scrollWidth - element.clientWidth) * fraction;
          const started = performance.now();

          const step = (now: number): void => {
            const t = Math.min(1, (now - started) / duration);
            const eased = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

            element.scrollLeft = from + (target - from) * eased;

            if (t < 1) {
              requestAnimationFrame(step);
            } else {
              resolve();
            }
          };

          requestAnimationFrame(step);
        }),
      { fraction: to, duration: ms },
    )
    .catch(() => undefined);

  await page.waitForTimeout(400);
};

/**
 * Ring something only if it is actually there.
 *
 * `spotlight` waits on `boundingBox()`, which on a locator matching nothing
 * blocks for the full action timeout. In a test that is a useful failure; in a
 * three-minute recording it is ninety seconds of frozen screen, so every
 * highlight of something the demo has not already asserted goes through here.
 */
const ring = async (
  page: Page,
  target: Locator,
  holdMs = 0,
): Promise<boolean> => {
  if ((await target.count()) === 0) {
    return false;
  }

  await spotlight(page, target, holdMs);

  return true;
};

test('demo: the pipeline board', async ({ page }) => {
  await installDemoChrome(page);

  await page.goto('/');
  await titleCard(
    page,
    'One board, and the next move on every card',
    'Greenlight already scored every lead. This is the screen that says what to do about it.',
    5_400,
  );

  /* ---------------------------------------------------------------------- *
   * 1 — the board, and the line down the middle of it
   * ---------------------------------------------------------------------- */

  await waitForShell(page);
  await dismissNoise(page);
  await openBoard(page);
  await page.waitForTimeout(1_500);

  await say(
    page,
    'Greenlight was four screens: a gate queue, a profile page, a trace on a record, an enrich command. This is all of it, on one board.',
    6_000,
  );

  await pan(page, 1, 3_000);
  await say(
    page,
    'Nine lanes. The first four are worked out from the lead itself; the last five are the deal stages the CRM already had.',
    5_400,
  );

  await pan(page, 0.42, 2_400);
  await toTop(page);

  // The handoff column, ringed where it is and clipped to the screen. See the
  // file header: its label is set vertically down a column as tall as the
  // tallest lane, so scrolling to reach the words would cost the whole shot.
  const handoffColumn = page.getByText(/^Handoff/).locator('..');
  const columnBox = await handoffColumn.boundingBox();

  if (columnBox !== null) {
    await spotlightBox(
      page,
      {
        x: columnBox.x,
        y: columnBox.y,
        w: columnBox.width,
        h: Math.min(columnBox.height, 1_000 - columnBox.y - 120),
      },
      700,
    );
  }

  await say(
    page,
    'Left of this line, the record is a lead. Right of it, it is a deal.',
    4_000,
  );
  await say(
    page,
    'Crossing it is the only thing in this app that ever opens an opportunity.',
    4_200,
  );
  await clearSpotlight(page);

  /* ---------------------------------------------------------------------- *
   * 2 — a card carrying its next move
   * ---------------------------------------------------------------------- */

  await pan(page, 1, 2_400);
  await toTop(page);

  const stuckCard = pipelineCard(page, STUCK_NAME);
  await expect(stuckCard).toHaveCount(1, { timeout: 30_000 });
  await spotlight(page, stuckCard, 900);

  await say(
    page,
    'Every card carries one next move. Not a status — a sentence, and the button that acts on it.',
    4_600,
  );
  await say(
    page,
    'This is the part that used to be left in the salesperson’s head.',
    3_400,
  );

  await ring(
    page,
    stuckCard.locator('span').filter({ hasText: /in the diary/ }).last(),
    600,
  );
  await say(
    page,
    'Greenlight worked that out from the record. No model was asked, and none is needed.',
    4_400,
  );
  await clearSpotlight(page);

  /* ---------------------------------------------------------------------- *
   * 3 — the path to the next stage, and a card that is ready
   *
   * The criterion is named on the face of the card, so this beat stays on the
   * face. The evidence behind it — "no discovery call or write-up is logged
   * against this deal" — is on the same card under "Why this", and it is shown
   * later, in the move panel, where a rep is actually about to act on it.
   * ---------------------------------------------------------------------- */

  await ring(page, stuckCard.getByText('0 of 1 met — missing: discovery call.'), 700);
  await say(
    page,
    'Above the sentence is the path to the next stage. Nought of one met — and it names the one.',
    5_000,
  );
  await clearSpotlight(page);

  const readyCard = pipelineCard(page, READY_NAME);
  await expect(readyCard).toHaveCount(1, { timeout: 30_000 });
  await ring(page, readyCard.getByText('1 of 1 met — this stage is ready.'), 700);
  await say(
    page,
    'The card above is the same stage and the same checklist — but somebody wrote the call up. One of one met.',
    5_400,
  );
  await clearSpotlight(page);

  /* ---------------------------------------------------------------------- *
   * 4 — capture: three fields, one submit
   * ---------------------------------------------------------------------- */

  await say(page, 'A new lead takes three fields.', 2_200);

  await pointAndClick(page, page.getByRole('button', { name: 'Add a lead' }));
  await expect(page.getByPlaceholder('Priya Raman')).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForTimeout(700);

  const submit = page.getByRole('button', { name: 'Add the lead' });
  await expect(submit).toBeDisabled();

  const name = page.getByPlaceholder('Priya Raman');
  await name.click();
  await name.pressSequentially(CAPTURE_NAME, { delay: 22 });

  const email = page.getByPlaceholder('priya@northwind.example');
  await email.click();
  await email.pressSequentially(CAPTURE_EMAIL, { delay: 14 });

  const employer = page.getByPlaceholder(
    'Northwind Logistics, or northwind.example',
  );
  await employer.click();
  await employer.pressSequentially(CAPTURE_COMPANY, { delay: 20 });
  await page.waitForTimeout(700);

  await say(
    page,
    'Behind the one button: dedupe against what you already have, link or open the company, score, gate, write the trace.',
    4_800,
  );

  await pointAndClick(page, submit);

  const placed = page.getByText(new RegExp(`^${CAPTURE_NAME} is in `));
  await expect(placed).toBeVisible({ timeout: 150_000 });
  await page.waitForTimeout(1_200);

  await ring(page, placed.locator('..'), 800);
  await say(
    page,
    'Three fields in. A scored, placed card back — which lane it landed in, and what it did with the company.',
    5_400,
  );
  await clearSpotlight(page);

  await pointAndClick(page, page.getByRole('button', { name: 'Close' }));
  await page.waitForTimeout(800);

  /* ---------------------------------------------------------------------- *
   * 5 — the handoff
   * ---------------------------------------------------------------------- */

  await say(page, 'Now the line.', 2_200);

  await pan(page, 0.42, 2_400);
  await toTop(page);

  const handoffCard = pipelineCard(page, HANDOFF_NAME);
  await expect(handoffCard).toHaveCount(1, { timeout: 60_000 });
  await ring(page, handoffCard, 800);
  await say(
    page,
    'A lead that passed the gate, top of Qualified, nothing outstanding.',
    3_600,
  );
  await clearSpotlight(page);

  await pointAndClick(page, handoffCard.getByRole('button', { name: 'Move…' }));
  await page.waitForTimeout(900);

  const handOff = handoffCard.getByRole('button', { name: 'Hand off to New' });
  await expect(handOff).toBeVisible({ timeout: 30_000 });
  await ring(page, handoffCard.getByText(/This opens the deal/), 1_800);
  await clearSpotlight(page);

  await pointAndClick(page, handOff);

  // The caption goes up before the wait rather than after it. Crossing the line
  // is a real server round trip and the screen has nothing to show during it;
  // leaving the previous sentence sitting there would be several seconds of a
  // caption describing something that had already happened.
  await say(
    page,
    'Greenlight opens the deal, carries the company and the contact over, and re-reads the board.',
    1_000,
  );

  await expect
    .poll(async () => (await opportunitiesForPerson(handoffPersonId)).length, {
      timeout: 150_000,
      message: 'the handoff did not open an opportunity',
    })
    .toBe(1);

  const [deal] = await opportunitiesForPerson(handoffPersonId);

  const handedOff = laneColumn(page, 'New')
    .locator('article')
    .filter({ hasText: HANDOFF_NAME });

  await expect(
    handedOff,
    'the handed-off card should re-appear on the deal side of the line',
  ).toHaveCount(1, { timeout: 90_000 });
  await page.waitForTimeout(900);

  await ring(page, handedOff, 800);
  await say(page, 'The card is over the line, and already asking for the next thing.', 4_000);
  await clearSpotlight(page);

  await say(page, 'And the opportunity exists.', 2_200);

  await page.goto(`/object/opportunity/${deal.id}`);
  await waitForShell(page);
  await dismissNoise(page);
  await page.waitForTimeout(1_800);

  await ring(page, page.getByText('Point of Contact', { exact: true }).first(), 700);
  await say(
    page,
    'A real Opportunity, with the company and the point of contact carried over from the lead.',
    4_800,
  );
  await clearSpotlight(page);

  /* ---------------------------------------------------------------------- *
   * 6 — the override receipt
   * ---------------------------------------------------------------------- */

  await clearCaption(page);
  await titleCard(
    page,
    'And when the salesperson knows better',
    'The board never refuses a move. It records what was on screen, and who went ahead.',
    4_600,
  );

  await openBoard(page);
  await pan(page, 1, 2_200);
  await toTop(page);

  const overrideCard = pipelineCard(page, STUCK_NAME);
  await expect(overrideCard).toHaveCount(1, { timeout: 60_000 });

  await say(
    page,
    'Back to the card with the discovery call outstanding. The rep had that call — nobody wrote it up.',
    5_000,
  );

  await pointAndClick(page, overrideCard.getByRole('button', { name: 'Move…' }));
  await page.waitForTimeout(1_100);

  await ring(page, overrideCard.getByText(/One thing is still outstanding/), 900);
  await say(
    page,
    'Before the move, not after: what is outstanding, and what going ahead will mean.',
    4_800,
  );
  await clearSpotlight(page);

  await ring(
    page,
    overrideCard.getByText(
      'discovery call — no discovery call or write-up is logged against this deal',
    ),
    900,
  );
  await say(
    page,
    'Named, with the evidence behind it. Not counted, not summarised.',
    3_800,
  );
  await clearSpotlight(page);

  await pointAndClick(
    page,
    overrideCard.getByRole('button', { name: 'Move to Meeting' }),
  );

  await say(page, 'It moves. It always moves.', 1_000);

  await expect
    .poll(async () => (await readOpportunity(stuckDealId))?.stage, {
      timeout: 150_000,
      message: 'the board must never refuse a move',
    })
    .toBe('MEETING');

  await say(page, 'And it leaves a receipt.', 2_600);

  await pointAndClick(page, sidebarEntry(page, 'Greenlight Audit Log'));
  await restPointer(page);

  const logRow = page
    .locator('[data-testid^="row-id-"]')
    .filter({ hasText: STUCK_NAME });

  await expect(logRow.first()).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(1_500);

  await ring(page, logRow.first(), 800);
  await say(
    page,
    'Greenlight’s own log. The move is at the top, with the workspace member who made it.',
    4_200,
  );
  await clearSpotlight(page);

  const rows = await readAuditRowsForLead(STUCK_NAME);
  const moved = rows.find((row) => row.eventType === 'MOVED');

  expect(moved, 'the override move must have written an audit row').toBeDefined();

  // The reason is the whole receipt and it is not one of this view's columns —
  // and the record page clips it to about thirty characters, so the sentence a
  // reviewer most needs is the one they cannot read. Printed here off the row
  // itself, with the card saying whose formatting it is. Same as demo 2.
  await showCard(
    page,
    `<div style="width:1240px;color:#fff;font-family:Inter,-apple-system,sans-serif;">
       <div style="font-size:30px;font-weight:700;margin-bottom:8px;">
         What the log recorded about that move
       </div>
       <div style="font-size:16px;color:#8b98a5;margin-bottom:22px;">
         The row a compliance reviewer reads a year later.
       </div>
       <div style="display:grid;grid-template-columns:210px 1fr;gap:14px 26px;font-size:20px;line-height:1.5;">
         <div style="color:#8b98a5;">Event</div><div>${moved?.eventType ?? '—'}</div>
         <div style="color:#8b98a5;">Lead</div><div>${STUCK_NAME}</div>
         <div style="color:#8b98a5;">Who went ahead</div><div>${moved?.actorDisplayName ?? '—'}</div>
         <div style="color:#8b98a5;">What was on screen</div>
         <div style="color:#5fd39b;">${moved?.overrideReason ?? '—'}</div>
       </div>
       <div style="margin-top:26px;font-size:15px;color:#5fd39b;line-height:1.5;">
         The actor is the person, resolved from the request’s own identity — and
         the member id is kept beside the name, because two colleagues can share
         a name and one of them can leave.
       </div>
       <div style="margin-top:14px;font-size:14px;color:#6f7d8b;font-style:italic;">
         Read back off the audit row. The record page clips the reason to about
         thirty characters, so this demo has printed it in full — the words, the
         numbers and the identifiers are Greenlight’s.
       </div>
     </div>`,
    12_000,
  );

  await say(
    page,
    'The criterion in the words the card used, the stage it left and the one it went to, and who went ahead.',
    4_600,
  );

  await clearCaption(page);
  await titleCard(
    page,
    'Nobody had to connect the dots',
    'One board, a next move on every card, and a record of every time somebody overruled it.',
    5_200,
  );

  await saveDemoVideo(page, '06-the-pipeline-board');
});
