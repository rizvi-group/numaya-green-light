import { expect, test } from '@playwright/test';

import {
  createCompany,
  createPerson,
  deleteCompany,
  deletePerson,
  enrichedFields,
  readEnrichment,
  readPerson,
  waitForDecision,
} from '../support/twenty-api';
import { openCommandMenu, waitForShell } from '../support/ui';
import {
  clearCaption,
  clearSpotlight,
  dismissNoise,
  installDemoChrome,
  pointAndClick,
  say,
  saveDemoVideo,
  showCard,
  spotlight,
  spotlightUnion,
  titleCard,
} from './support/demo';

/**
 * Demo 5 — enrichment, against a real search engine and a real model.
 *
 * The only recording that leaves the machine. SearXNG answers the search and a
 * local Ollama model reads the results; both are the customer's own, which is
 * the whole shape of the feature — Greenlight never brokers data and never sees
 * a lead.
 *
 * ## What this demo cannot show honestly, and does not pretend to
 *
 * "The score moves as a result" is true in general and is *not* true in this
 * workspace, for a reason demo 4 spends ninety seconds on: the enrichable
 * firmographics — industry, region, headcount — are read by the three ICP rules,
 * and this workspace has no ICP, so those rules score 0 out of 0 whatever value
 * lands. Setting an ICP to make the number move would change the configuration
 * the whole test suite scores against and would be staging a result.
 *
 * So the score is read off the record before and after, and the caption states
 * whichever of the two actually happened. If it does not move, the demo says why
 * and points at demo 4. That is the honest version, and it is also the more
 * useful one: it is exactly what a customer with an unconfigured profile sees.
 *
 * ## Provider variance is real and is left in
 *
 * A 3B model on live search results does not source the same fields every run,
 * and a run that sources nothing is a supported outcome that writes
 * `NOTHING_FOUND` and leaves the lead untouched. The recording runs the pipeline
 * once, from the UI, and shows what came back.
 */

const stamp = `${Date.now()}`.slice(-4);
const FIRST_NAME = 'Nadia';
const LAST_NAME = `Okafor ${stamp}`;

/** A real, findable employer: enrichment reads the public web. */
const COMPANY_NAME = 'Cloudflare';

const searxngBaseUrl =
  process.env.GREENLIGHT_E2E_SEARXNG_URL ?? 'http://localhost:8888';
const llmBaseUrl =
  process.env.GREENLIGHT_E2E_LLM_URL ?? 'http://localhost:11434/v1';

let companyId = '';
let personId = '';

const reachable = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });

    return response.ok;
  } catch {
    return false;
  }
};

test.beforeAll(async () => {
  // Deliberately a failure, not a skip. A demo of enrichment that quietly
  // records the providers being absent is a demo of nothing, and the person
  // running it needs to be told which one is down.
  expect(
    await reachable(`${searxngBaseUrl}/search?q=ping&format=json`),
    `the search provider at ${searxngBaseUrl} is not answering — start SearXNG ` +
      'before recording demo 5',
  ).toBe(true);
  expect(
    await reachable(`${llmBaseUrl}/models`),
    `the model endpoint at ${llmBaseUrl} is not answering — start Ollama before ` +
      'recording demo 5',
  ).toBe(true);

  companyId = await createCompany(COMPANY_NAME);

  // Deliberately no email address.
  //
  // The first take of this demo gave the lead `…@example.com`, and Twenty
  // silently re-linked her Company from Cloudflare to its own seeded
  // `example.com` record on the strength of the domain. Enrichment searches on
  // the *employer's name*, so it went looking for example.com and a 3B model
  // duly sourced "fintech" off an unrelated page — a substantiated, cited,
  // completely wrong answer. Nothing in the app was at fault and nothing in the
  // suite would have caught it.
  personId = await createPerson({
    name: { firstName: FIRST_NAME, lastName: LAST_NAME },
    jobTitle: 'Head of Revenue Operations',
    companyId,
  });

  await waitForDecision(personId);
});

test.afterAll(async () => {
  if (personId !== '') {
    await deletePerson(personId);
  }

  if (companyId !== '') {
    await deleteCompany(companyId);
  }
});

test('demo: enrichment from a real search engine and a real model', async ({
  page,
}) => {
  await installDemoChrome(page);

  await page.goto('/');
  await titleCard(
    page,
    'Filling in what is missing',
    'Your own search engine, your own model. Every value arrives with the page it came from.',
    6_000,
  );

  await waitForShell(page);
  await dismissNoise(page);

  await say(page, 'Take a lead we already hold, at a company we know nothing about.', 3_400);

  await page.goto(`/object/person/${personId}`);
  await waitForShell(page);
  await dismissNoise(page);
  await page.waitForTimeout(2_500);

  const before = await readPerson(personId);

  await say(
    page,
    `${FIRST_NAME} works at ${COMPANY_NAME}. We have her title and her employer — and nothing about what that employer does.`,
    6_000,
  );

  await spotlightUnion(
    page,
    [
      page.getByText('Lead score', { exact: true }).first(),
      page.getByText('Gate decision', { exact: true }).first(),
    ],
    500,
  );
  await say(
    page,
    `She scores ${before?.greenlightScore ?? ''} today.`,
    3_600,
  );
  await clearSpotlight(page);

  await say(
    page,
    'Greenlight can go and look — through a search engine and a model you host yourself.',
    5_800,
  );
  await say(
    page,
    'Nothing about this lead is sent to us. There is no vendor in the middle.',
    5_200,
  );

  // --- run it ----------------------------------------------------------------
  await openCommandMenu(page);
  await page.waitForTimeout(1_200);

  const enrichCommand = page.getByText('Enrich now (Greenlight)');
  await expect(enrichCommand).toBeVisible({ timeout: 60_000 });
  await spotlight(page, enrichCommand, 900);
  await clearSpotlight(page);
  await pointAndClick(page, enrichCommand);

  await expect(page.getByText('Greenlight enrichment')).toBeVisible({
    timeout: 60_000,
  });
  await page.waitForTimeout(1_500);

  const enrich = page.getByRole('button', { name: 'Enrich now', exact: true });
  await expect(enrich).toBeEnabled({ timeout: 180_000 });

  await say(page, 'One click, and it goes looking.', 3_000);
  await pointAndClick(page, enrich);

  await say(
    page,
    'A real search, then a real model reading the pages it found. This takes a moment.',
    6_000,
  );

  // The panel answers when the handler answers; the field write is a separate
  // mutation. Waited on the panel, because the panel is what a person watches.
  await expect(page.getByText('Sourced from the web')).toBeVisible({
    timeout: 300_000,
  });
  await page.waitForTimeout(2_500);

  await spotlight(page, page.getByText('Sourced from the web'), 800);
  await say(page, 'Here is what it found, and where.', 3_600);
  await clearSpotlight(page);

  await say(
    page,
    'Every value carries the page it was read from, the date, and how confident the model was.',
    6_200,
  );
  await page.waitForTimeout(2_000);

  await spotlight(
    page,
    page.getByText('· not entered by your team').first(),
    800,
  );
  await say(
    page,
    'And it is labelled as sourced, so nobody mistakes it for something a colleague typed.',
    6_000,
  );
  await clearSpotlight(page);

  // --- what actually landed, and what it did to the score --------------------
  const enriched = await readEnrichment(personId);
  const fields = enrichedFields(enriched);
  const entries = Object.entries(fields);

  // Wait for any re-score the enrichment write triggered to settle before
  // reading the number that goes on screen.
  await page.waitForTimeout(15_000);
  const after = await readPerson(personId);

  const beforeScore = before?.greenlightScore ?? null;
  const afterScore = after?.greenlightScore ?? null;
  const moved = beforeScore !== null && afterScore !== null && beforeScore !== afterScore;

  const rows = entries
    .map(
      ([key, field]) => `
        <div style="padding:12px 0;border-bottom:1px solid rgba(255,255,255,.08);">
          <div style="font-size:20px;font-weight:600;color:#fff;">
            ${key} &nbsp;<span style="color:#5fd39b;">${String(field.parsedValue ?? field.value)}</span>
          </div>
          <div style="font-size:16px;color:#9fb0c0;margin-top:6px;">
            ${String(field.sourceUrl ?? '')}
          </div>
          <div style="font-size:16px;color:#9fb0c0;margin-top:4px;">
            read ${String(field.retrievedAt ?? '').slice(0, 10)}
            &middot; ${Math.round(Number(field.confidence ?? 0) * 100)}% confidence
            &middot; ${String(field.searchProvider ?? '')} + ${String(field.reasoningModel ?? '')}
          </div>
        </div>`,
    )
    .join('');

  const scoreLine = moved
    ? `The score moved from ${beforeScore} to ${afterScore}.`
    : `The score did not move: ${beforeScore} before, ${afterScore} after.`;

  const scoreWhy = moved
    ? 'The sourced value fed straight back into the rules.'
    : 'These values are read by the industry, region and size rules — and this ' +
      'workspace has no ideal customer profile, so those three rules score ' +
      'nothing whatever arrives. That is the gap demo 4 is about.';

  await showCard(
    page,
    `<div style="width:1300px;color:#fff;font-family:Inter,-apple-system,sans-serif;">
       <div style="font-size:30px;font-weight:700;margin-bottom:6px;">
         What this run sourced
       </div>
       <div style="font-size:16px;color:#8b98a5;margin-bottom:18px;">
         Read back off ${FIRST_NAME}'s record, not out of the panel.
       </div>
       ${entries.length === 0 ? '<div style="font-size:20px;color:#d9a441;">Nothing was sourced on this run. Greenlight wrote "nothing found" and left the lead untouched — a supported outcome, not an error.</div>' : rows}
       <div style="margin-top:26px;font-size:22px;font-weight:600;">${scoreLine}</div>
       <div style="margin-top:10px;font-size:18px;color:#9fb0c0;line-height:1.5;">
         ${scoreWhy}
       </div>
     </div>`,
    16_000,
  );

  await clearCaption(page);
  await titleCard(
    page,
    'Sourced, not guessed',
    'A value you can click through to, on infrastructure you own.',
    5_200,
  );

  await saveDemoVideo(page, '05-enrichment');
});
