import { expect, test, type Page } from '@playwright/test';

import {
  PIPELINE_LANE_LABELS_IN_ORDER,
  createCompany,
  createOpportunity,
  createPerson,
  deleteAuditRowsForLeads,
  deleteCompany,
  deleteOpportunity,
  deletePerson,
  findCompaniesByName,
  findPersonByEmail,
  narrativeLayerAvailable,
  nextActionKindLabels,
  opportunitiesForPerson,
  readAuditRowsForLead,
  readBoardTotals,
  readCompany,
  readOpportunity,
  readPerson,
  readPersonAdvice,
  waitForDecision,
  type AuditRow,
  type CompanyRecord,
} from '../support/twenty-api';
import {
  CARD_NAVIGATION_BUTTONS,
  PIPELINE_BENIGN_PROSE,
  errorBannersExcept,
  laneColumn,
  laneCount,
  laneLabelsInOrder,
  openPipelineBoard,
  pipelineCard,
  pipelineCards,
  readPipelineCards,
  capturePipelineRequests,
  sidebarEntry,
  waitForShell,
} from '../support/ui';

/**
 * Test (g): the Greenlight Pipeline board.
 *
 * ===========================================================================
 * ## What this suite is for
 *
 * PIPELINE_SPEC.md: "The product is not a score. The product is **the next
 * move**." Every other suite in this folder verifies a piece of the engine. This
 * one verifies the screen the engine exists to produce — nine lanes, a handoff
 * line that is the only path in the app that opens an Opportunity, a sentence
 * and a button on every card, and an override that leaves a receipt.
 *
 * ## Where each assertion is made, and why
 *
 * The same split the rest of the folder lives on, restated because this suite
 * leans on it harder than the others. Anything that is *data* — a lane total, a
 * created deal, the criteria a move acknowledged — is read back through the
 * Twenty API, because a RAW_JSON blob is not something a human reads off a
 * screen. Anything that is a *claim* — "this card is ready", "one thing is still
 * outstanding", "this costs a model call per card" — is asserted in the browser,
 * because the claim is the product.
 *
 * ## What is deliberately not asserted
 *
 * The exact wording of the board's own "nothing to do" copy. It is being edited
 * while this is written, and a test that pinned it would fail on an improvement.
 * Where a card's *behaviour* depends on that state — a `NOTHING_TO_DO` card must
 * not offer an action button — the behaviour is asserted and the sentence is
 * not.
 *
 * ## Serial, on purpose
 *
 * `playwright.config.ts` runs the whole folder at `workers: 1`, and this suite
 * needs that rather than merely tolerating it: `Recompute the advice` is a
 * workspace-wide write and the board is workspace-global state, so a second
 * worker would be recomputing this suite's fixtures from another spec halfway
 * through an assertion about them. The tests inside this file are also ordered —
 * the audit-log comparison in "MOVED is not HANDED_OFF" reads the rows the two
 * move tests before it wrote — and each of those guards on the state it needs
 * rather than assuming the earlier test ran.
 * ===========================================================================
 */

const stamp = Date.now();
const TAG = `E2EPipe${stamp}`;

/** Fixture identity, kept in one place so `afterAll` can be exhaustive. */
const HANDOFF_NAME = { firstName: 'GreenlightE2E', lastName: `Handoff${stamp}` };
const HELD_NAME = { firstName: 'GreenlightE2E', lastName: `Derived${stamp}` };
const OVERRIDE_NAME = { firstName: 'GreenlightE2E', lastName: `Override${stamp}` };
const CRITERIA_NAME = { firstName: 'GreenlightE2E', lastName: `Criteria${stamp}` };
const ADVISE_NAME = { firstName: 'GreenlightE2E', lastName: `Advise${stamp}` };

const displayName = (name: { firstName: string; lastName: string }): string =>
  `${name.firstName} ${name.lastName}`;

const FIXTURE_COMPANY = `${TAG} Fixture Co`;
const FIXTURE_DOMAIN = `fixture-${stamp}.example`;

/** The company the capture drawer must find and must not touch. */
const EXISTING_COMPANY = `${TAG} Existing Co`;
const EXISTING_DOMAIN = `existing-${stamp}.example`;

/** The company the capture drawer must create. */
const NEW_COMPANY = `${TAG} Fresh Co`;
const NEW_LEAD_EMAIL = `fresh.lead@fresh-${stamp}.example`;

/**
 * The matched-company lead's address is on that company's *own* domain, and it
 * has to be.
 *
 * Twenty creates a Company from a new Person's email domain and relinks the
 * Person to it about two seconds after the record is written — measured on this
 * container, and it overwrites a `companyId` that was set explicitly at
 * creation. So a lead typed in with company "Acme" and an address at
 * `elsewhere.example` is linked by Greenlight to Acme and moved off it by the
 * CRM a moment later, which is not something this suite can assert around and
 * not something it should paper over: it is reported as a finding instead.
 *
 * Keeping the address on the matched company's domain is the case a rep
 * actually types — a work email at the account being captured — and it is the
 * one where Greenlight's answer and Twenty's agree, so the link is stable and
 * the assertion is about the capture chain rather than about a race.
 */
const MATCHED_LEAD_EMAIL = `matched.lead@${EXISTING_DOMAIN}`;

let fixtureCompanyId = '';
let existingCompanyId = '';

let handoffPersonId = '';
let heldPersonId = '';
let overridePersonId = '';
let criteriaPersonId = '';
let advisePersonId = '';

let overrideOppId = '';
let criteriaOppId = '';
let adviseOppId = '';

/** Deals and companies the *app* created during the run, deleted with the rest. */
const createdByTheApp: { opportunities: string[]; companies: string[]; people: string[] } =
  { opportunities: [], companies: [], people: [] };

/** Kind value -> the workspace's own label for it, read out of metadata. */
let kindLabels: Record<string, string> = {};

/**
 * Does this workspace have a model behind the AI rewrite?
 *
 * Derived from one real single-card `advise`, not from an environment variable,
 * for the reason `05-calibration.spec.ts` sets out: "a key is set" can be true
 * while delivery is broken, and a suite that skipped on the variable would
 * report a broken integration as an absent one. The probe costs at most one
 * model call, on one card, and only on a workspace that has a model to spend.
 */
let narrativeAvailable = false;

/** Carried between the two move tests and the one that compares their rows. */
let handoffAuditRow: AuditRow | null = null;
let stageMoveAuditRow: AuditRow | null = null;

/** The company snapshot the capture test compares against, field by field. */
let existingCompanyBefore: CompanyRecord | null = null;

const screeningDeal = async (
  name: { firstName: string; lastName: string },
  slug: string,
): Promise<{ personId: string; opportunityId: string }> => {
  const personId = await createPerson({
    name,
    // A decision-maker title and a company are what make the lead score well
    // enough to sit at the top of its lane, which is what makes the card
    // findable on a board whose lanes are capped at fifty.
    jobTitle: 'Chief Technology Officer',
    emails: { primaryEmail: `${slug}.${stamp}@${FIXTURE_DOMAIN}` },
    companyId: fixtureCompanyId,
  });

  const opportunityId = await createOpportunity({
    name: `${TAG} ${slug} deal`,
    // Screening is the stage whose single exit criterion is the discovery call,
    // and a deal with no Task attached to it is the regression this suite has to
    // be able to see: that criterion reported "could not check" for every deal
    // in the product's history until the nested activity read replaced a filter
    // `taskTarget` does not support.
    stage: 'SCREENING',
    companyId: fixtureCompanyId,
    pointOfContactId: personId,
  });

  return { personId, opportunityId };
};

test.beforeAll(async () => {
  fixtureCompanyId = await createCompany(FIXTURE_COMPANY, {
    domainName: `https://${FIXTURE_DOMAIN}`,
  });
  existingCompanyId = await createCompany(EXISTING_COMPANY, {
    domainName: `https://${EXISTING_DOMAIN}`,
  });

  handoffPersonId = await createPerson({
    name: HANDOFF_NAME,
    jobTitle: 'Chief Technology Officer',
    emails: { primaryEmail: `handoff.${stamp}@${FIXTURE_DOMAIN}` },
    companyId: fixtureCompanyId,
  });

  // No email, no company, no title — the same shape `03-gate-override` uses to
  // get a lead held, which is what puts a card in a derived lane.
  heldPersonId = await createPerson({ name: HELD_NAME });

  const override = await screeningDeal(OVERRIDE_NAME, 'override');
  overridePersonId = override.personId;
  overrideOppId = override.opportunityId;

  const criteria = await screeningDeal(CRITERIA_NAME, 'criteria');
  criteriaPersonId = criteria.personId;
  criteriaOppId = criteria.opportunityId;

  const advise = await screeningDeal(ADVISE_NAME, 'advise');
  advisePersonId = advise.personId;
  adviseOppId = advise.opportunityId;

  const [handoff, held] = await Promise.all([
    waitForDecision(handoffPersonId),
    waitForDecision(heldPersonId),
    waitForDecision(overridePersonId),
    waitForDecision(criteriaPersonId),
    waitForDecision(advisePersonId),
  ]);

  // Preconditions, not the feature. If these are wrong every lane assertion
  // below is measuring the wrong card, and saying so here beats a confusing
  // "card not found" three tests later.
  expect(
    handoff.greenlightDecision,
    'the handoff fixture must pass the gate to reach the Qualified lane',
  ).toBe('PASS');
  expect(
    held.greenlightDecision,
    'the derived-lane fixture must be held to reach the Held lane',
  ).toBe('GATE');

  existingCompanyBefore = await readCompany(existingCompanyId);
  kindLabels = await nextActionKindLabels();
  narrativeAvailable = await narrativeLayerAvailable(heldPersonId);
});

test.afterAll(async () => {
  // Deals first: a Person that is somebody's point of contact cannot be removed
  // cleanly while the deal still points at it.
  for (const id of [
    overrideOppId,
    criteriaOppId,
    adviseOppId,
    ...createdByTheApp.opportunities,
  ]) {
    if (id) {
      await deleteOpportunity(id).catch(() => undefined);
    }
  }

  // Anything the handoff opened. Read rather than remembered, so a move that
  // created a deal this suite did not expect is still cleaned up.
  if (handoffPersonId) {
    for (const deal of await opportunitiesForPerson(handoffPersonId).catch(
      () => [],
    )) {
      await deleteOpportunity(deal.id).catch(() => undefined);
    }
  }

  // The two leads the capture drawer created are found by their addresses as
  // well as by the ids the tests recorded. A capture that got as far as writing
  // the record and then failed an assertion never reaches the line that records
  // the id, and a fixture nobody remembers creating is exactly the sort of thing
  // that accumulates in a container the demo recordings share.
  for (const email of [NEW_LEAD_EMAIL, MATCHED_LEAD_EMAIL]) {
    const captured = await findPersonByEmail(email).catch(() => null);

    if (captured !== null) {
      createdByTheApp.people.push(captured.id);
    }
  }

  for (const id of new Set([
    handoffPersonId,
    heldPersonId,
    overridePersonId,
    criteriaPersonId,
    advisePersonId,
    ...createdByTheApp.people,
  ])) {
    if (id) {
      await deletePerson(id).catch(() => undefined);
    }
  }

  for (const id of [
    fixtureCompanyId,
    existingCompanyId,
    ...createdByTheApp.companies,
  ]) {
    if (id) {
      await deleteCompany(id).catch(() => undefined);
    }
  }

  // The capture drawer creates a Company of its own. It is found by the name it
  // was told to use rather than by an id this file could have recorded, because
  // the whole point of that step is that the server chose whether to create one.
  // The audit rows this suite's own moves and scoring runs wrote. See
  // `deleteAuditRowsForLeads`: the log is workspace-global and another spec
  // reads it, so a suite that adds ten rows a run has to take them back out.
  await deleteAuditRowsForLeads([
    displayName(HANDOFF_NAME),
    displayName(HELD_NAME),
    displayName(OVERRIDE_NAME),
    displayName(CRITERIA_NAME),
    displayName(ADVISE_NAME),
    `Fresh ${TAG}`,
    `Matched ${TAG}`,
  ]).catch(() => undefined);

  for (const stray of await findCompaniesByName(NEW_COMPANY).catch(() => [])) {
    await deleteCompany(stray.id).catch(() => undefined);
  }
});

/** Nothing on this board may read as a failure, in any scenario. */
const expectNoFailures = async (page: Page): Promise<void> => {
  expect(
    await errorBannersExcept(page, PIPELINE_BENIGN_PROSE),
    'the board must never render an error where it meant to render advice',
  ).toEqual([]);
};

/* -------------------------------------------------------------------------- */
/* 1 — the board paints                                                        */
/* -------------------------------------------------------------------------- */

test('the board paints nine lanes in order, with the handoff line between them', async ({
  page,
}) => {
  await openPipelineBoard(page);

  expect(
    await laneLabelsInOrder(page),
    'the lanes must appear in the order PIPELINE_SPEC.md documents — the ' +
      'handoff line falls between the fourth and the fifth, so a reordering ' +
      'moves the boundary that decides when an Opportunity is created',
  ).toEqual([...PIPELINE_LANE_LABELS_IN_ORDER]);

  // The board never renders empty and never falls back to its failure panel.
  await expect(
    page.getByRole('button', { name: 'Try again' }),
    'the board fell back to its failure panel instead of painting',
  ).toHaveCount(0);
  expect(await pipelineCards(page).count()).toBeGreaterThan(0);

  /* The handoff boundary, positioned rather than merely present. -------------- */
  const handoff = page.getByText(/^Handoff/);
  await expect(
    handoff,
    'the handoff line is the one boundary in the product where Greenlight ' +
      'stops describing a person and starts describing a deal; it has to be ' +
      'on screen',
  ).toBeVisible();

  const qualified = await laneColumn(page, 'Qualified').boundingBox();
  const handoffBox = await handoff.boundingBox();
  const brandNew = await laneColumn(page, 'New').boundingBox();

  expect(qualified).not.toBeNull();
  expect(handoffBox).not.toBeNull();
  expect(brandNew).not.toBeNull();
  expect(
    handoffBox!.x,
    'the handoff line must be drawn after Qualified',
  ).toBeGreaterThanOrEqual(qualified!.x + qualified!.width - 1);
  expect(
    handoffBox!.x,
    'the handoff line must be drawn before New',
  ).toBeLessThanOrEqual(brandNew!.x);

  /* Lane headers carry the true total, not the length of the page they show. -- */
  const totals = await readBoardTotals();

  for (const lane of totals.lanes) {
    const shown = await laneCount(page, lane.label);

    expect(
      shown,
      `the ${lane.label} header must carry a count, not an em-dash`,
    ).not.toBeNull();
    expect(
      shown,
      `the ${lane.label} header must show every card in the lane, not the ` +
        'number the server was willing to return in one request',
    ).toBe(lane.total);

    const rendered = await laneColumn(page, lane.label).locator('article').count();

    expect(
      rendered,
      `the ${lane.label} lane rendered more cards than the server returned`,
    ).toBe(lane.cardCount);

    if (lane.total > lane.cardCount) {
      // A truncated lane has to say so, with both numbers, or the header count
      // is a claim about cards the rep cannot see and cannot reach.
      await expect(
        laneColumn(page, lane.label).getByText(
          new RegExp(`Showing ${lane.cardCount} of ${lane.total.toLocaleString()}`),
        ),
        `the truncated ${lane.label} lane must say how much it is not showing`,
      ).toBeVisible();
    }
  }

  await page.screenshot({ path: 'shots/07-board.png', fullPage: true });
  await expectNoFailures(page);
});

/* -------------------------------------------------------------------------- */
/* 2 — every card carries a next action                                        */
/* -------------------------------------------------------------------------- */

test('every card carries an action sentence, and a button when there is one to press', async ({
  page,
}) => {
  await openPipelineBoard(page);

  // Recompute first, so the sentences on screen are the ones now written to the
  // records. Without it the comparison below would be asserting the card
  // against a field the board had never been asked to fill in.
  await page.getByRole('button', { name: 'Recompute the advice' }).click();
  await expect(
    page.getByRole('button', { name: 'Recompute the advice' }),
    'the recompute never finished',
  ).toBeEnabled({ timeout: 120_000 });

  const labels = Object.values(kindLabels);
  const nothingToDo = kindLabels['NOTHING_TO_DO'];

  expect(
    nothingToDo,
    'the workspace has no label for NOTHING_TO_DO, so this test cannot tell a ' +
      'quiet card from a card whose action went missing',
  ).toBeTruthy();

  const cards = await readPipelineCards(page);

  expect(cards.length, 'the board rendered no cards at all').toBeGreaterThan(0);

  let actionable = 0;
  let quiet = 0;

  for (const card of cards) {
    // The shape of a broken contract: `nextAction` promises never to return an
    // empty list, and the component says so out loud when it does.
    expect(
      card.lines,
      `"${card.name}" came back with no next action`,
    ).not.toContain('No next action came back for this card.');

    expect(
      card.sentence.length,
      `"${card.name}" has no sentence on it — the sentence is the only part of ` +
        'a card that tells somebody what to do, and it is the unit this whole ' +
        'screen exists to carry',
    ).toBeGreaterThan(20);
    expect(
      CARD_NAVIGATION_BUTTONS,
      `"${card.name}" shows a button where its sentence should be`,
    ).not.toContain(card.sentence);

    const actionButtons = card.buttons.filter(
      (button) => !CARD_NAVIGATION_BUTTONS.includes(button),
    );

    /* ---------------------------------------------------------------------- *
     * "Where the action is actionable, its button."
     *
     * Which kind a card is asking for is read off the chip above the sentence,
     * and the chip is the workspace's own label for the SELECT value — not a
     * string in this file. A card with no chip is one the board has nothing to
     * ask for: the `NOTHING_TO_DO` chip was removed on the argument that
     * "Nothing to do" over "nothing on the record says what to do next" is the
     * same statement twice rather than a heading. Both shapes mean the same
     * thing here and both must offer nothing to press, so the test accepts
     * either and asserts the behaviour that has to hold across the change.
     * ---------------------------------------------------------------------- */
    const chip = labels.includes(card.aboveSentence) ? card.aboveSentence : null;

    if (chip === null || chip === nothingToDo) {
      quiet += 1;
      expect(
        actionButtons,
        `"${card.name}" has nothing to ask for and then offers a button to do it`,
      ).toEqual([]);
    } else {
      actionable += 1;
      expect(
        actionButtons.length,
        `"${card.name}" asks for "${chip}" and offers no button that acts on it`,
      ).toBeGreaterThan(0);
    }
  }

  // Both halves of the rule have to have been exercised, or the loop above
  // proved one thing about every card and nothing about the distinction.
  expect(actionable, 'no card on the board asked for anything').toBeGreaterThan(0);
  expect(
    quiet,
    'no card on the board was quiet, so "a card with nothing to ask for offers ' +
      'no button" was never tested',
  ).toBeGreaterThan(0);

  /* And the card agrees with the record, not with a string in this file. ------ */
  const deal = await readOpportunity(adviseOppId);

  expect(deal?.greenlightNextAction ?? '').not.toBe('');

  const dealCard = pipelineCard(page, displayName(ADVISE_NAME));

  await expect(
    dealCard,
    'the recomputed deal should be on the board exactly once',
  ).toHaveCount(1);
  await expect(
    dealCard,
    'the sentence on the card must be the sentence written to the record — ' +
      'the board is not allowed to paraphrase advice it saved',
  ).toContainText(deal!.greenlightNextAction!);
  expect(
    Object.keys(kindLabels),
    'the kind on the record must be one this workspace has an option for',
  ).toContain(deal!.greenlightNextActionKind);

  if (deal!.greenlightNextActionKind !== 'NOTHING_TO_DO') {
    await expect(
      dealCard,
      'the chip must be the workspace label for the kind on the record',
    ).toContainText(kindLabels[deal!.greenlightNextActionKind!]);
  }

  const lead = await readPersonAdvice(heldPersonId);

  expect(lead?.greenlightNextAction ?? '').not.toBe('');
  await expect(pipelineCard(page, displayName(HELD_NAME))).toContainText(
    lead!.greenlightNextAction!,
  );

  await expectNoFailures(page);
});

/* -------------------------------------------------------------------------- */
/* 3 — capture                                                                 */
/* -------------------------------------------------------------------------- */

const openCaptureDrawer = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: 'Add a lead' }).click();
  await expect(page.getByPlaceholder('Priya Raman')).toBeVisible();
};

const fillCapture = async (
  page: Page,
  { name, email, company }: { name: string; email: string; company: string },
): Promise<void> => {
  await page.getByPlaceholder('Priya Raman').fill(name);
  await page.getByPlaceholder('priya@northwind.example').fill(email);
  await page
    .getByPlaceholder('Northwind Logistics, or northwind.example')
    .fill(company);
};

test('the capture drawer creates the lead, opens the company and places the card', async ({
  page,
}) => {
  await openPipelineBoard(page);
  await openCaptureDrawer(page);

  const submit = page.getByRole('button', { name: 'Add the lead' });

  await expect(
    submit,
    'a name and an email are the two the score cannot be computed without, so ' +
      'an empty drawer must not be submittable',
  ).toBeDisabled();

  const leadName = `Fresh ${TAG}`;

  await fillCapture(page, {
    name: leadName,
    email: NEW_LEAD_EMAIL,
    company: NEW_COMPANY,
  });
  await expect(submit).toBeEnabled();
  await submit.click();

  /* The drawer says where the card landed, and it names a real lane. --------- */
  const placed = page.getByText(new RegExp(`^${leadName} is in `));

  await expect(
    placed,
    'the drawer must say which lane the lead landed in — the whole promise of ' +
      'three fields is a scored, explained, placed lead',
  ).toBeVisible({ timeout: 120_000 });

  const placedIn = (await placed.innerText()).replace(`${leadName} is in `, '').trim();

  expect(
    PIPELINE_LANE_LABELS_IN_ORDER,
    `the drawer placed the lead in "${placedIn}", which is not a lane`,
  ).toContain(placedIn);

  // It reports the dedupe outcome, which is the thing a rep cannot see for
  // themselves and would otherwise discover as a duplicate a fortnight later.
  // The sentence is the server's and is rendered verbatim — the drawer used to
  // compose it here from two booleans, and could not tell "a company was
  // created for them" from "there was no company to create".
  await expect(
    page.getByText(new RegExp(`^${leadName} was added as a new person`)),
    'the drawer must report what the capture chain actually did with the person',
  ).toBeVisible();
  await expect(
    page.getByText(/the company was added with them/),
    'a company name that matched nothing must be reported as newly created',
  ).toBeVisible();

  await page.screenshot({ path: 'shots/07-capture.png', fullPage: true });

  /* The records the claim is about. ----------------------------------------- */
  const person = await findPersonByEmail(NEW_LEAD_EMAIL);

  expect(person, 'the captured lead does not exist in the workspace').not.toBeNull();
  createdByTheApp.people.push(person!.id);

  expect(
    person!.companyId,
    'capture must link the lead to a company; an unlinked lead is one the ' +
      'engine cannot enrich and cannot score on firmographics',
  ).not.toBeNull();

  const company = await readCompany(person!.companyId!);

  expect(company?.['name']).toBe(NEW_COMPANY);
  createdByTheApp.companies.push(person!.companyId!);

  expect(
    await findCompaniesByName(NEW_COMPANY),
    'capture must open exactly one company for a name that matched nothing',
  ).toHaveLength(1);

  // Placed means scored and gated, not merely created.
  const scored = await waitForDecision(person!.id);

  expect(scored.greenlightDecision).not.toBeNull();

  await page.getByRole('button', { name: 'Close' }).click();
  await expectNoFailures(page);
});

test('capturing against a company that already exists links it and changes nothing on it', async ({
  page,
}) => {
  expect(
    existingCompanyBefore,
    'the fixture company was not readable, so there is no before-state to ' +
      'compare against',
  ).not.toBeNull();

  await openPipelineBoard(page);
  await openCaptureDrawer(page);

  const leadName = `Matched ${TAG}`;

  // The company is typed as a name rather than a website, which is what a rep
  // does. See `MATCHED_LEAD_EMAIL` for why the address is on that company's own
  // domain.
  await fillCapture(page, {
    name: leadName,
    email: MATCHED_LEAD_EMAIL,
    company: EXISTING_COMPANY,
  });
  await page.getByRole('button', { name: 'Add the lead' }).click();

  await expect(
    page.getByText(new RegExp(`^${leadName} is in `)),
  ).toBeVisible({ timeout: 120_000 });
  await expect(
    page.getByText(/linked to a company you already had/),
    'the drawer must say the existing company was reused, not that it opened ' +
      'a second one',
  ).toBeVisible();

  const person = await findPersonByEmail(MATCHED_LEAD_EMAIL);

  expect(person).not.toBeNull();
  createdByTheApp.people.push(person!.id);

  expect(
    person!.companyId,
    'the lead must be linked to the company that already existed',
  ).toBe(existingCompanyId);

  expect(
    await findCompaniesByName(EXISTING_COMPANY),
    'a matched company must not be duplicated',
  ).toHaveLength(1);

  /* The negative that matters. ---------------------------------------------- */
  //
  // `src/default-role.ts` records that `company` write is a reversal of an
  // explicit "read-only, permanently" commitment, and that Twenty cannot express
  // "may create, may never modify" as a permission. So the guarantee is a code
  // property, and this is the assertion that it holds against a live workspace:
  // every field of the matched company, `updatedAt` included, byte for byte.
  const after = await readCompany(existingCompanyId);

  expect(
    after,
    'the matched company must still exist after a capture linked to it',
  ).not.toBeNull();
  expect(
    after,
    'capture matched an existing company and then modified it. Greenlight may ' +
      'create a Company and may never change one — a rep typing a lead in must ' +
      'not be able to overwrite an account record by getting the name right.',
  ).toEqual(existingCompanyBefore);

  await page.getByRole('button', { name: 'Close' }).click();
  await expectNoFailures(page);
});

/* -------------------------------------------------------------------------- */
/* 4 — the handoff                                                             */
/* -------------------------------------------------------------------------- */

test('handing a Qualified card across the line opens exactly one opportunity', async ({
  page,
}) => {
  expect(
    await opportunitiesForPerson(handoffPersonId),
    'the handoff fixture must start with no deal, or "exactly one was created" ' +
      'is not a claim about this move',
  ).toEqual([]);

  await openPipelineBoard(page);

  const card = pipelineCard(page, displayName(HANDOFF_NAME));

  await expect(
    card,
    'the qualified fixture should be on the board once, in Qualified',
  ).toHaveCount(1);
  await expect(laneColumn(page, 'Qualified').locator('article').filter({
    hasText: displayName(HANDOFF_NAME),
  })).toHaveCount(1);

  await card.getByRole('button', { name: 'Move…' }).click();

  // Qualified offers exactly one target, and the button names what pressing it
  // does rather than leaving a gesture to imply it.
  const handOff = card.getByRole('button', { name: 'Hand off to New' });

  await expect(handOff).toBeVisible();
  await expect(
    card.getByRole('button', { name: /^Move to / }),
    'a qualified lead has nowhere to go but across the handoff line',
  ).toHaveCount(0);

  await page.screenshot({ path: 'shots/07-handoff-panel.png', fullPage: true });
  await handOff.click();

  /* The deal it opened. ------------------------------------------------------ */
  await expect
    .poll(
      async () => (await opportunitiesForPerson(handoffPersonId)).length,
      {
        timeout: 120_000,
        message:
          'crossing the handoff line is the only path in the app that creates ' +
          'an Opportunity, and it must create exactly one',
      },
    )
    .toBe(1);

  const [deal] = await opportunitiesForPerson(handoffPersonId);

  expect(deal.stage, 'the deal opens in the lane the card was dropped in').toBe(
    'NEW',
  );
  expect(
    deal.pointOfContactId,
    'the point of contact must be carried over from the lead',
  ).toBe(handoffPersonId);

  // Read off the lead rather than compared to the fixture id, because "carried
  // over from the lead" is the claim. Twenty relinks a Person's company from its
  // email domain shortly after creation, so the lead is the only authority on
  // which company it is on by the time the card is moved.
  const lead = await readPersonAdvice(handoffPersonId);

  expect(lead?.companyId).not.toBeNull();
  expect(
    deal.companyId,
    'the company must be carried over from the lead',
  ).toBe(lead!.companyId);

  /* And the card is now on the deal side of the line. ------------------------ */
  await expect(
    laneColumn(page, 'New')
      .locator('article')
      .filter({ hasText: displayName(HANDOFF_NAME) }),
    'the handed-off card must appear in New once the board re-reads itself',
  ).toHaveCount(1, { timeout: 60_000 });

  /* The audit row. ----------------------------------------------------------- */
  await expect
    .poll(
      async () => {
        const rows = await readAuditRowsForLead(displayName(HANDOFF_NAME));
        handoffAuditRow =
          rows.find((row) => row.eventType === 'HANDED_OFF') ?? null;

        return handoffAuditRow?.eventType ?? null;
      },
      {
        timeout: 60_000,
        message:
          '"when did this deal start, and off which lead" is a question the ' +
          'audit log has to be able to answer on its own',
      },
    )
    .toBe('HANDED_OFF');

  expect(handoffAuditRow?.actorDisplayName).toMatch(/^Workspace member /);

  await page.screenshot({ path: 'shots/07-handoff-done.png', fullPage: true });
  await expectNoFailures(page);
});

/* -------------------------------------------------------------------------- */
/* 5 — the override receipt                                                    */
/* -------------------------------------------------------------------------- */

test('moving with a criterion outstanding names it first, then records the override', async ({
  page,
}) => {
  const requests = capturePipelineRequests(page);

  await openPipelineBoard(page);

  const card = pipelineCard(page, displayName(OVERRIDE_NAME));

  await expect(card).toHaveCount(1);
  await expect(
    laneColumn(page, 'Screening')
      .locator('article')
      .filter({ hasText: displayName(OVERRIDE_NAME) }),
  ).toHaveCount(1);

  await card.getByRole('button', { name: 'Move…' }).click();

  /* Named, not counted, and on screen *before* the move. --------------------- */
  //
  // `wire.ts` is explicit that `acknowledgedUnmet` is the ids of the criteria
  // that were outstanding *on screen*, "so the audit row can say what the person
  // was actually looking at when they decided". If the panel did not show them,
  // the receipt would be a fiction, so the naming is asserted before the click
  // and the ids are asserted on the request the click sends.
  await expect(
    card.getByText(/discovery call/).first(),
    'the outstanding criterion has to be named on screen before the move, not ' +
      'counted and not summarised',
  ).toBeVisible();
  await expect(
    card.getByText('discovery call — no discovery call or write-up is logged against this deal'),
    'the criterion must carry the evidence the server wrote for it',
  ).toBeVisible();

  await page.screenshot({ path: 'shots/07-override-panel.png', fullPage: true });

  const before = await readOpportunity(overrideOppId);

  expect(before?.stage).toBe('SCREENING');

  await card.getByRole('button', { name: 'Move to Meeting' }).click();

  await expect
    .poll(async () => (await readOpportunity(overrideOppId))?.stage, {
      timeout: 120_000,
      message: 'the board never refuses a move; the stage must have changed',
    })
    .toBe('MEETING');

  /* The request carried the ids of what was on screen. ----------------------- */
  const advance = requests.find((request) => request.action === 'advance');

  expect(
    advance,
    'the move must have gone through the board’s own route',
  ).toBeDefined();

  const sent = JSON.parse(advance!.body) as { acknowledgedUnmet?: string[] };

  expect(
    sent.acknowledgedUnmet,
    'the override receipt is the ids of the criteria the panel showed; a move ' +
      'that sent none of them would be indistinguishable from a client that ' +
      'forgot to check',
  ).toContain('meeting.discovery-call-logged');

  /* The row a compliance reviewer reads a year later. ------------------------ */
  await expect
    .poll(
      async () => {
        const rows = await readAuditRowsForLead(displayName(OVERRIDE_NAME));
        stageMoveAuditRow = rows.find((row) => row.eventType === 'MOVED') ?? null;

        return stageMoveAuditRow?.overrideReason ?? null;
      },
      {
        timeout: 60_000,
        message: 'a move made with criteria outstanding must be recorded as one',
      },
    )
    .not.toBeNull();

  const reason = stageMoveAuditRow!.overrideReason!;

  expect(
    reason,
    'the row must name the criterion that was outstanding, in the words the ' +
      'criterion uses, not as a slug and not as a count on its own',
  ).toContain('discovery call');
  expect(
    reason,
    'the row must say how many were outstanding',
  ).toMatch(/1 exit criterion outstanding/);
  expect(reason, 'the row must say where the card came from and went').toContain(
    'Screening',
  );
  expect(reason).toContain('Meeting');

  expect(
    stageMoveAuditRow!.actorDisplayName,
    'the row must name who went ahead',
  ).toMatch(/^Workspace member /);
  expect(
    reason,
    'the row must stand alone: the actor is named in the reason as well as in ' +
      'the actor column',
  ).toContain(stageMoveAuditRow!.actorDisplayName!);

  // A stage move is not a handoff: it must not have opened a second deal.
  expect(
    await opportunitiesForPerson(overridePersonId),
    'moving a card between deal stages must not create another Opportunity',
  ).toHaveLength(1);

  await expectNoFailures(page);
});

/* -------------------------------------------------------------------------- */
/* 6 — MOVED is not HANDED_OFF                                                 */
/* -------------------------------------------------------------------------- */

test('a stage move writes MOVED and the handoff writes HANDED_OFF', async ({
  page,
}) => {
  test.skip(
    stageMoveAuditRow === null || handoffAuditRow === null,
    'needs both move tests above to have produced their audit rows; without ' +
      'them there is nothing to tell apart',
  );

  // The two event types exist to answer different questions. `pipeline-run.ts`
  // records why: filing every move under one value left the log individually
  // accurate in each row's name and collectively useless to the filter an admin
  // actually reaches for.
  expect(stageMoveAuditRow!.eventType).toBe('MOVED');
  expect(handoffAuditRow!.eventType).toBe('HANDED_OFF');
  expect(stageMoveAuditRow!.eventType).not.toBe(handoffAuditRow!.eventType);

  // Whether the criteria were met is *not* what picks between them: the stage
  // move above went with one outstanding, and it is still MOVED.
  expect(stageMoveAuditRow!.overrideReason).toContain('outstanding');

  /* And an admin can tell them apart in the log itself. ---------------------- */
  await page.goto('/');
  await waitForShell(page);
  await sidebarEntry(page, 'Greenlight Audit Log').first().click();

  const handedOffRow = page.locator('[data-testid^="row-id-"]').filter({
    hasText: displayName(HANDOFF_NAME),
  });
  const movedRow = page.locator('[data-testid^="row-id-"]').filter({
    hasText: displayName(OVERRIDE_NAME),
  });

  await expect(handedOffRow.first(), 'the handoff must be in the log').toBeVisible({
    timeout: 60_000,
  });
  await expect(movedRow.first(), 'the stage move must be in the log').toBeVisible({
    timeout: 60_000,
  });

  await expect(
    handedOffRow.first(),
    'the handoff row must read as a handoff, not as an ordinary move',
  ).toContainText(/handed off/i);
  await expect(movedRow.first()).toContainText(/moved/i);

  await page.screenshot({ path: 'shots/07-audit-move-types.png', fullPage: true });
  expect(await errorBannersExcept(page, PIPELINE_BENIGN_PROSE)).toEqual([]);
});

/* -------------------------------------------------------------------------- */
/* 7 — exit criteria actually evaluate                                         */
/* -------------------------------------------------------------------------- */

test('a Screening deal with no logged activity reports its discovery call as unmet, not unchecked', async ({
  page,
}) => {
  await openPipelineBoard(page);

  await page.getByRole('button', { name: 'Recompute the advice' }).click();
  await expect(
    page.getByRole('button', { name: 'Recompute the advice' }),
  ).toBeEnabled({ timeout: 120_000 });

  const card = pipelineCard(page, displayName(CRITERIA_NAME));

  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'Why this' }).click();

  /* ------------------------------------------------------------------------ *
   * The regression this exists for.
   *
   * `taskTarget` has no filterable `opportunityId`. The board's activity read
   * used to filter on it, the query threw on every call, and a fail-open catch
   * turned that into "could not check" for every deal on every board since the
   * criterion was written — a screen that looked considered while answering
   * nothing. `met` / `unmet` / `indeterminate` are three states on purpose, and
   * a test that could not tell the third from the second would not have seen it.
   *
   * So both sides are asserted, on the server's own evidence strings, which are
   * the only thing that distinguishes the two branches without restating the
   * component's tone words:
   *
   *   unmet          "no discovery call or write-up is logged against this deal"
   *   indeterminate  "no tasks or notes were loaded for this deal"
   *
   * The wording carries "or write-up" because the criterion reads Tasks **and**
   * Notes. It shipped reading tasks alone, which gave up a third of the coverage
   * that `default-role.ts` refused `calendarEvent` in order to get.
   * ------------------------------------------------------------------------ */
  await expect(
    card.getByText('discovery call — no discovery call or write-up is logged against this deal'),
    'a Screening deal with nothing logged against it has an unmet discovery ' +
      'call, and the card has to say so',
  ).toBeVisible();

  await expect(
    card.getByText(/no tasks or notes were loaded for this deal/),
    'reporting the discovery call as unreadable is the defect: the deal was ' +
      'read, the activity was read, and the answer is that there is none',
  ).toHaveCount(0);

  const lines = (await card.innerText()).split('\n').map((line) => line.trim());
  const criterionLine = lines.find((line) => /^.*discovery call — /.test(line));

  expect(criterionLine, 'the criterion row is missing').toBeDefined();
  expect(
    criterionLine,
    'the criterion must be rendered as not met; "could not check" and "the ' +
      'record says this is missing" send a salesperson to two different places',
  ).not.toMatch(/could not check/i);

  // The arithmetic, not a verdict — and 0 of 1 is only reachable when the
  // criterion evaluated. A stage whose only criterion is indeterminate reports
  // "not applicable" and a summary that says so.
  await expect(
    card.getByText('0 of 1 met — missing: discovery call.'),
    'the card shows the arithmetic; a readiness meter that hides which ' +
      'criterion failed is a progress bar, and a progress bar is not an ' +
      'instruction',
  ).toBeVisible();
  await expect(card.getByText('0%', { exact: true })).toBeVisible();

  /* The same answer on the record, where it is filterable. ------------------- */
  const deal = await readOpportunity(criteriaOppId);

  expect(deal?.greenlightReadiness).toBe(0);

  const criteria = deal?.greenlightCriteria as
    | { results?: { criterionId?: string; status?: string }[] }
    | undefined;
  const discovery = criteria?.results?.find(
    (result) => result.criterionId === 'meeting.discovery-call-logged',
  );

  expect(
    discovery,
    'the criterion must be written back to greenlightCriteria so it can be ' +
      'filtered on, not only rendered',
  ).toBeDefined();
  expect(
    discovery?.status,
    'indeterminate here is the fail-open answer that hid the defect for the ' +
      'whole life of the feature',
  ).toBe('unmet');

  await page.screenshot({ path: 'shots/07-criteria.png', fullPage: true });
  await expectNoFailures(page);
});

/* -------------------------------------------------------------------------- */
/* 8 — derived lanes offer no move                                             */
/* -------------------------------------------------------------------------- */

test('a card in a derived lane explains itself instead of offering a move', async ({
  page,
}) => {
  const held = await readPerson(heldPersonId);

  expect(
    held?.greenlightDecision,
    'this card is in Held because the record says so; if the record changed, ' +
      'the lane assertion below is about a different card',
  ).toBe('GATE');

  await openPipelineBoard(page);

  const card = laneColumn(page, 'Held')
    .locator('article')
    .filter({ hasText: displayName(HELD_NAME) });

  await expect(
    card,
    'a lead the gate is holding belongs in the Held lane',
  ).toHaveCount(1);

  // The first four lanes are derived from the lead's own state on every read and
  // are stored nowhere, so there is no write that would move a card between
  // them. Offering the move and quietly doing nothing would be worse.
  await expect(
    card.getByRole('button', { name: 'Move…' }),
    'a derived lane must not offer a move it cannot perform',
  ).toHaveCount(0);
  await expect(
    card.getByRole('button', { name: /^(Move to|Hand off to) / }),
  ).toHaveCount(0);

  await card.getByRole('button', { name: 'Why this' }).click();

  await expect(
    card.getByText(/no card to move out of it by hand/i),
    'the card has to say why it offers no move — a missing button with no ' +
      'explanation reads as a bug',
  ).toBeVisible();

  await page.screenshot({ path: 'shots/07-derived-lane.png', fullPage: true });
  await expectNoFailures(page);
});

/* -------------------------------------------------------------------------- */
/* 9 — recompute persists                                                      */
/* -------------------------------------------------------------------------- */

test('recomputing the advice writes it back to the opportunity', async ({
  page,
}) => {
  const before = await readOpportunity(adviseOppId);

  expect(before, 'the advise fixture is missing').not.toBeNull();

  await openPipelineBoard(page);

  const recompute = page.getByRole('button', { name: 'Recompute the advice' });

  await recompute.click();
  await expect(recompute, 'the recompute never finished').toBeEnabled({
    timeout: 120_000,
  });

  // PIPELINE_SPEC.md § Performance: advice is cached on the record and
  // recomputed on write or on explicit refresh, never on render. So the click
  // has to leave something behind.
  await expect
    .poll(
      async () => (await readOpportunity(adviseOppId))?.greenlightAdvisedAt ?? null,
      {
        timeout: 120_000,
        message:
          'a recompute that changed only the screen would make the cached ' +
          'advice on the record a claim nothing keeps true',
      },
    )
    .not.toBe(before!.greenlightAdvisedAt);

  const after = await readOpportunity(adviseOppId);

  expect(after!.greenlightNextAction ?? '').not.toBe('');
  expect(
    after!.greenlightNextActionKind,
    'the machine-readable kind is what the record page filters and colours on, ' +
      'so it has to be written alongside the sentence',
  ).not.toBeNull();
  expect(Object.keys(kindLabels)).toContain(after!.greenlightNextActionKind!);

  expect(
    new Date(after!.greenlightAdvisedAt!).getTime(),
    'the advice timestamp must move forward',
  ).toBeGreaterThan(
    before!.greenlightAdvisedAt === null
      ? 0
      : new Date(before!.greenlightAdvisedAt).getTime(),
  );

  await expectNoFailures(page);
});

/* -------------------------------------------------------------------------- */
/* 10 — the AI rewrite is opt-in and priced                                    */
/* -------------------------------------------------------------------------- */

test('the AI rewrite states its price and spends nothing until it is confirmed', async ({
  page,
}) => {
  const requests = capturePipelineRequests(page);

  await openPipelineBoard(page);

  // The price is on the screen, not only in the modal. A price a customer meets
  // for the first time in a dialog they have already decided to open is a price
  // they were not offered a chance to avoid.
  await expect(
    page.getByText(
      /Rewriting it using AI spends one model call and one search query for each card on the board/,
    ),
    'the board itself has to say what the AI rewrite costs',
  ).toBeVisible();

  await page.getByRole('button', { name: 'Rewrite using AI' }).click();

  await expect(
    page.getByText('Rewrite the advice using AI?'),
    'asking for the AI rewrite must stop and ask first',
  ).toBeVisible();
  await expect(
    page.getByText(
      /This spends one model call and one search query for each of the \d+ cards on the board, charged to this workspace/,
    ),
    'the confirmation must state the cost, in cards, before it is accepted',
  ).toBeVisible();

  const confirm = page.getByRole('button', { name: /^Rewrite the advice/ });
  const cancel = page.getByRole('button', { name: /^Cancel/ });

  await expect(confirm).toBeVisible();
  await expect(
    cancel,
    'a confirmation with no way out is not a confirmation',
  ).toBeVisible();

  await page.screenshot({ path: 'shots/07-ai-confirmation.png', fullPage: true });

  const spent = () =>
    requests.filter((request) => /"withNarrative"\s*:\s*true/.test(request.body));

  expect(
    spent(),
    'nothing may reach the model while the customer is still being asked',
  ).toEqual([]);

  await cancel.click();
  await expect(page.getByText('Rewrite the advice using AI?')).toHaveCount(0);

  // The plain recompute beside it is free and does the same ranking; pressing it
  // must not smuggle the paid one through.
  await page.getByRole('button', { name: 'Recompute the advice' }).click();
  await expect(
    page.getByRole('button', { name: 'Recompute the advice' }),
  ).toBeEnabled({ timeout: 120_000 });

  expect(
    spent(),
    'declining the confirmation, and then using the free recompute, must not ' +
      'spend a model call — a board that quietly billed a customer for looking ' +
      'at their own pipeline would be a defect no wording excuses',
  ).toEqual([]);

  expect(
    requests.some((request) => request.action === 'advise'),
    'the free recompute should still have run',
  ).toBe(true);

  await expectNoFailures(page);
});

test('confirming the AI rewrite is what reaches the model', async ({ page }) => {
  test.skip(
    !narrativeAvailable,
    'needs a workspace with an AI model behind the wording agent. Measured ' +
      'rather than assumed: a single-card advise with withNarrative came back ' +
      'narrativeUnavailable, which is the shipped behaviour for a workspace ' +
      'with no model — the deterministic sentence is the product, and there is ' +
      'nothing here to spend or to measure.',
  );

  const requests = capturePipelineRequests(page);

  await openPipelineBoard(page);
  await page.getByRole('button', { name: 'Rewrite using AI' }).click();
  await page.getByRole('button', { name: /^Rewrite the advice/ }).click();

  await expect(
    page.getByRole('button', { name: 'Rewrite using AI' }),
    'the rewrite never finished',
  ).toBeEnabled({ timeout: 150_000 });

  expect(
    requests.filter((request) => /"withNarrative"\s*:\s*true/.test(request.body)),
    'confirming is the only thing that may ask for the rewrite, and it must ' +
      'actually ask',
  ).toHaveLength(1);

  // The AI layer changes the wording and nothing else, so its absence is a
  // notice rather than an error — and its presence must not produce one.
  await expect(
    page.getByText(/The AI layer was not available/),
    'the model answered, so the fallback notice must not be on screen',
  ).toHaveCount(0);

  await expectNoFailures(page);
});
