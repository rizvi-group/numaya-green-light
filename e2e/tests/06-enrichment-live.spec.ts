import { expect, test } from '@playwright/test';

import {
  createCompany,
  createPerson,
  deleteCompany,
  deletePerson,
  enrichedFields,
  readEnrichment,
  waitForDecision,
} from '../support/twenty-api';
import {
  errorBanners,
  openCommandMenu,
  waitForShell,
} from '../support/ui';

/**
 * Enrichment, against **real providers**, inside the real Twenty.
 *
 * ===========================================================================
 * ## Why this file exists
 *
 * Every other proof of enrichment in this repository — 1227 unit tests and a
 * live provider suite in `app/src/__live__/` — runs the engine in a Node
 * process with the CRM faked out. That proves the engine. It does not prove
 * that a logic function running *inside Twenty's own runtime*, resolving its
 * configuration from real application variables, can reach a search engine and
 * a model at all and write what it found onto a record a person is looking at.
 *
 * This does, and it is the only test in the suite that leaves the machine.
 *
 * ## What it needs
 *
 * Both providers on the host, and the app variables pointed at them:
 *
 * | Variable          | Value                                      |
 * |-------------------|--------------------------------------------|
 * | `SEARCH_PROVIDER` | `searxng`                                  |
 * | `SEARCH_BASE_URL` | `http://host.docker.internal:8888`         |
 * | `USE_TWENTY_AI`   | `false`                                    |
 * | `LLM_BASE_URL`    | `http://host.docker.internal:11434/v1`     |
 * | `LLM_MODEL`       | a pulled Ollama model                      |
 *
 * `host.docker.internal`, not `localhost`. The logic function runs inside the
 * `twenty-app-dev` container, where `localhost` is the container — a fact that
 * only a run like this one can teach you, because every offline test in the
 * repository resolves the base URL in the same process that reads it.
 *
 * The suite **skips** when the providers are absent, unlike the live suite in
 * `app/`. The difference is deliberate: that suite exists to be run manually by
 * someone who has just set the providers up, and silence there would be a lie.
 * This file sits in a run that a developer executes for unrelated reasons on a
 * machine that may have neither, and failing all of it over a missing search
 * engine would train people to ignore the result.
 * ===========================================================================
 */

const stamp = Date.now();

/**
 * A real, findable employer.
 *
 * Enrichment reads the *public web*; an invented company returns nothing and
 * the test would then be proving only that the empty-result path works.
 */
const COMPANY_NAME = 'Cloudflare';

let companyId: string;
let personId: string;
let providersReady = false;

const searxngBaseUrl =
  process.env.GREENLIGHT_E2E_SEARXNG_URL ?? 'http://localhost:8888';
const llmBaseUrl =
  process.env.GREENLIGHT_E2E_LLM_URL ?? 'http://localhost:11434/v1';

/**
 * Wait for one enrichment run to reach the record, and report what it decided.
 *
 * The panel returns as soon as the handler answers; the field write is a
 * separate mutation the UI does not wait for. Polling the record is therefore
 * the only way to know a run finished, as opposed to a click having been
 * registered.
 */
const enrichmentStatusAfterRun = async (
  id: string,
  timeoutMs = 150_000,
): Promise<string | null> => {
  const deadline = Date.now() + timeoutMs;
  const before = (await readEnrichment(id))?.greenlightEnrichedAt ?? null;

  for (;;) {
    const person = await readEnrichment(id);

    if (
      person?.greenlightEnrichmentStatus != null &&
      person.greenlightEnrichedAt !== before
    ) {
      return person.greenlightEnrichmentStatus;
    }

    if (Date.now() > deadline) {
      return person?.greenlightEnrichmentStatus ?? null;
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
};

const reachable = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(5_000),
    });

    return response.ok;
  } catch {
    return false;
  }
};

test.beforeAll(async () => {
  providersReady =
    (await reachable(`${searxngBaseUrl}/search?q=ping&format=json`)) &&
    (await reachable(`${llmBaseUrl}/models`));

  if (!providersReady) {
    return;
  }

  companyId = await createCompany(COMPANY_NAME);
  personId = await createPerson({
    name: { firstName: 'GreenlightE2E', lastName: `Enrich${stamp}` },
    jobTitle: 'Head of Revenue Operations',
    companyId,
  });

  await waitForDecision(personId);
});

test.afterAll(async () => {
  if (personId) {
    await deletePerson(personId);
  }

  if (companyId) {
    await deleteCompany(companyId);
  }
});

test.describe('enrichment runs against real providers', () => {
  test.skip(
    () => !providersReady,
    'needs a SearXNG instance and an OpenAI-compatible endpoint on the host',
  );

  test('the settings screen offers SearXNG as a search provider', async ({
    page,
  }) => {
    // The adapter is only real to a customer if they can select it. This drives
    // the application-variable screen Twenty renders from the app's own
    // manifest, so it fails if the new SELECT option or the new variable never
    // made it through `twenty apply`.
    //
    // The route is resolved from the installed-apps list rather than hard-coded:
    // the application's row id is per-workspace, and an id pasted from one dev
    // container is a test that only ever passes on that container.
    // `waitForShell` is deliberately not used here. It waits for the workspace
    // sidebar's "People" link, and the settings area replaces that sidebar with
    // its own — so calling it on a settings route buys a guaranteed 60-second
    // timeout and a failure that blames the wrong thing.
    await page.goto('/settings/applications#installed');

    const appLink = page
      .locator('a[href*="/settings/applications/"]')
      .filter({ hasText: 'Numaya Greenlight' })
      .first();

    await expect(appLink, 'the app must be installed in this workspace').toBeVisible(
      { timeout: 60_000 },
    );

    const href = await appLink.getAttribute('href');
    await page.goto(`${href}#settings`);

    await expect(page.getByText('Configuration').first()).toBeVisible({
      timeout: 60_000,
    });

    // The variable exists at all — it is new, and nothing else in the suite
    // would notice if `twenty apply` had dropped it.
    await expect(page.getByText('SEARCH_BASE_URL').first()).toBeVisible();

    // And the provider reads back by its human label, not its wire value, which
    // is what an admin actually sees when they open this screen.
    await expect(page.getByText('SEARCH_PROVIDER').first()).toBeVisible();
    await expect(page.getByText('SearXNG (self-hosted)').first()).toBeVisible();

    await page.screenshot({
      path: 'shots/06-search-provider-setting.png',
      fullPage: true,
    });
    expect(await errorBanners(page)).toEqual([]);
  });

  test('an admin can enrich a lead and the panel reports what happened', async ({
    page,
  }) => {
    await page.goto(`/object/person/${personId}`);
    await waitForShell(page);

    await openCommandMenu(page);

    const enrichCommand = page.getByText('Enrich now (Greenlight)');
    await expect(
      enrichCommand,
      'the enrichment command must be offered on a Person record',
    ).toBeVisible({ timeout: 30_000 });
    await enrichCommand.click();

    await expect(page.getByText('Greenlight enrichment')).toBeVisible();

    const enrich = page.getByRole('button', { name: 'Enrich now', exact: true });

    /**
     * Up to three clicks, stopping as soon as the record reports `ENRICHED`.
     *
     * Not a retry to hide a flaky feature. A run that sources nothing is a
     * *supported outcome* — it writes `NOTHING_FOUND` and leaves the lead
     * untouched — and a small local model produces it a fair share of the time
     * on live search results, which the diagnostics in `app/src/__live__/`
     * measure directly. What this test is for is the plumbing: that a click in
     * Twenty's own UI reaches a search engine and a model outside the container
     * and lands a sourced value on the record. Deciding that on one roll of a
     * 3B model would be testing the model.
     *
     * If all three come back empty the test fails, and that is the right
     * signal: at that point either the providers are unreachable or the model
     * is too weak to be worth pointing at this feature.
     */
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await expect(enrich).toBeEnabled({ timeout: 150_000 });
      await enrich.click();

      // A real search plus two completions from a small local model. Generous,
      // because the alternative to waiting is a flaky assertion about a
      // provider that is genuinely allowed to be slow.
      //
      // Waited on the record rather than on the snackbar the click also raises:
      // a snackbar is transient, and a test that raced it would fail on a slow
      // machine for a reason that has nothing to do with enrichment.
      const status = await enrichmentStatusAfterRun(personId);

      if (status === 'ENRICHED') {
        break;
      }
    }

    // Each sourced value is shown with the page it came from — the panel is
    // where a rep decides whether to believe it.
    await expect(
      page.getByText('Sourced from the web'),
      'the panel must show what the run sourced',
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('· not entered by your team')).toBeVisible();

    await page.screenshot({ path: 'shots/06-enrich-panel.png', fullPage: true });
    expect(await errorBanners(page)).toEqual([]);
  });

  test('the enriched value is written with its source URL, date and confidence', async () => {
    // Read back off the record, not out of the panel: the panel is a report of
    // the run, and the thing that has to be true is what landed on the Person.
    const person = await readEnrichment(personId);

    expect(
      person?.greenlightEnrichmentStatus,
      'the record must carry an enrichment status',
    ).toBe('ENRICHED');
    expect(person?.greenlightEnrichedAt).not.toBeNull();

    const fields = enrichedFields(person);

    expect(
      Object.keys(fields).length,
      'the run must have written at least one sourced field',
    ).toBeGreaterThan(0);

    for (const [key, field] of Object.entries(fields)) {
      // PRODUCT_SPEC's hallucination mitigation, asserted on a real record
      // holding a value a real model produced from a real web page.
      expect(field.sourceUrl, `${key} source URL`).toMatch(/^https?:\/\//);
      expect(Date.parse(field.retrievedAt), `${key} retrieved at`).not.toBeNaN();
      expect(field.confidence, `${key} confidence`).toBeGreaterThan(0);
      expect(field.confidence, `${key} confidence`).toBeLessThanOrEqual(0.95);

      // And it must be recorded which providers produced it, because a value
      // whose provenance does not name its source is not provenance.
      expect(field.searchProvider, `${key} search provider`).toBe('searxng');
      expect(field.reasoningProvider, `${key} reasoning provider`).toBe(
        'openai-compatible',
      );
      expect(field.reasoningModel.length, `${key} reasoning model`).toBeGreaterThan(0);
    }
  });

  test('the record page shows the enrichment a rep can check', async ({ page }) => {
    await page.goto(`/object/person/${personId}`);
    await waitForShell(page);

    const fieldsPanel = page
      .locator('div')
      .filter({ hasText: /^Fields/ })
      .first();

    // The labels are the ones the Person record page actually renders — "Enrich
    // status" and "Last enriched", not the field's API name. Read off a live
    // record rather than guessed from the field definitions, because the two
    // are allowed to differ and here they do.
    await expect(fieldsPanel).toContainText('Enrich status', {
      timeout: 60_000,
    });
    await expect(fieldsPanel).toContainText('Enriched');
    await expect(fieldsPanel).toContainText('Last enriched');
    await expect(fieldsPanel).toContainText('Sourced data');

    const person = await readEnrichment(personId);
    const [first] = Object.values(enrichedFields(person));

    // The value itself, on the record, in front of a human — which is the whole
    // point of writing it. Case-insensitive because the model returns the
    // page's own capitalisation and the field renders it verbatim.
    if (first !== undefined) {
      await expect(fieldsPanel).toContainText(
        new RegExp(first.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      );
    }

    await page.screenshot({ path: 'shots/06-enriched-record.png', fullPage: true });
    expect(await errorBanners(page)).toEqual([]);
  });
});
