import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Locators for the bits of Twenty this suite drives.
 *
 * Twenty's record table is a div grid, not a `<table>`, so `getByRole('row')`
 * finds nothing. Rows do carry `data-testid="row-id-<uuid>"`, which is the most
 * stable hook available and the one used throughout.
 */

/** The workspace shell has finished loading. */
export const waitForShell = async (page: Page): Promise<void> => {
  await expect(page.getByRole('link', { name: 'People' })).toBeVisible({
    timeout: 60_000,
  });
};

/** A sidebar entry, matched on the leading text — the sidebar truncates labels. */
export const sidebarEntry = (page: Page, name: string): Locator =>
  page.locator('a').filter({ hasText: new RegExp(`^${escapeRegExp(name)}`) });

export const tableRow = (page: Page, personId: string): Locator =>
  page.getByTestId(`row-id-${personId}`);

/** Select exactly one row, which is what the record-selection commands require. */
export const selectRow = async (page: Page, personId: string): Promise<void> => {
  const row = tableRow(page, personId);
  await expect(row).toBeVisible();
  await row.hover();
  await row.locator('input[type="checkbox"]').first().click({ force: true });
  await expect(page.getByText('1 selected')).toBeVisible();
};

export const openCommandMenu = async (page: Page): Promise<void> => {
  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(page.getByPlaceholder('Type anything...')).toBeVisible();
};

/**
 * Every visible leaf-node text on the page.
 *
 * Twenty renders the command menu and the app's front components into panels
 * whose text `innerText` reports inconsistently once they overflow; reading the
 * leaves is the reliable way to ask "is this string on screen".
 */
export const visibleText = async (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const out = new Set<string>();
    document.querySelectorAll('*').forEach((element) => {
      if (element.children.length > 0) {
        return;
      }
      const text = (element as HTMLElement).innerText?.trim();
      if (text) {
        out.add(text);
      }
    });
    return [...out];
  });

/**
 * Record-page field labels that do not fit the box Twenty gives them.
 *
 * The Fields panel puts every label in a hard 90px div and clamps it to one line
 * with `-webkit-line-clamp`. That clamp breaks on **words**, so an over-long
 * label silently loses its trailing words — and, critically, `innerText` still
 * reports the whole string, so a `toContainText` assertion passes while the user
 * sees "Greenlight …". Four fields once rendered as those same eight characters.
 *
 * Measuring the rendered line boxes is the only way to see it from a test. A
 * label occupying more than one line box has had everything after the first line
 * clipped away.
 */
export const clampedFieldLabels = async (
  page: Page,
  labels: string[],
): Promise<string[]> =>
  page.evaluate((wanted) => {
    const clipped: string[] = [];

    document.querySelectorAll('[data-testid="tooltip"]').forEach((element) => {
      const text = element.textContent ?? '';

      if (!wanted.includes(text) || element.childNodes.length !== 1) {
        return;
      }

      const node = element.firstChild;

      if (!node || node.nodeType !== Node.TEXT_NODE) {
        return;
      }

      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, text.length);

      const rects = range.getClientRects();
      const tops = new Set<number>();

      for (let index = 0; index < rects.length; index += 1) {
        tops.add(Math.round(rects[index].top));
      }

      if (tops.size > 1) {
        clipped.push(text);
      }
    });

    return [...new Set(clipped)];
  }, labels);

/**
 * Table column headings that are ellipsised.
 *
 * A different component from the record page and a tighter budget: a `<span>`
 * with `text-overflow: ellipsis` whose width is the view field's `size` less
 * 28px of icon and gutter. Here `scrollWidth` does exceed `clientWidth`, so the
 * check is the ordinary one.
 */
export const truncatedColumnHeaders = async (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const clipped: string[] = [];

    document.querySelectorAll('span').forEach((element) => {
      if (
        element.children.length === 0 &&
        getComputedStyle(element).textOverflow === 'ellipsis' &&
        element.scrollWidth > element.clientWidth + 1 &&
        element.textContent
      ) {
        clipped.push(element.textContent);
      }
    });

    return [...new Set(clipped)];
  });

/**
 * Anything on screen that reads as an error.
 *
 * A test that passes while an error toast is up is worse than no test, so every
 * spec calls this before it finishes.
 */
export const errorBanners = async (page: Page): Promise<string[]> => {
  const texts = await visibleText(page);
  return texts.filter((text) =>
    /(^|\s)(error|failed|went wrong|could not|unable to|unexpected)/i.test(text),
  );
};

/**
 * `errorBanners`, minus prose the screen is *supposed* to be saying.
 *
 * The pipeline board is the first screen in this product whose correct output
 * contains the words "could not". A criterion whose evidence was never loaded
 * renders as "could not check", and the readiness summary the server writes says
 * "1 could not be checked: decision-maker on the record." Both are the honest
 * answer — `criteria.ts` is explicit that `indeterminate` must never be folded
 * into `unmet` — and `errorBanners` cannot tell them from a failure toast.
 *
 * So the allowance is per call and has to be written down at the call site, and
 * anything that is *not* on the list still fails. Widening the regex in
 * `errorBanners` instead would have turned the check off for every other suite
 * that depends on it.
 */
export const errorBannersExcept = async (
  page: Page,
  allowed: readonly RegExp[],
): Promise<string[]> => {
  const banners = await errorBanners(page);

  return banners.filter(
    (banner) => !allowed.some((pattern) => pattern.test(banner)),
  );
};

/**
 * The board's own honest prose, as distinct from a failure.
 *
 * Kept here rather than in the spec so that every scenario allows exactly the
 * same set, and so that a new benign string has to be added once and argued for
 * once.
 */
export const PIPELINE_BENIGN_PROSE: readonly RegExp[] = [
  // A criterion whose inputs were never loaded. Rendered by `CriterionRow` and
  // named again in the server's readiness summary and in the move panel.
  /could not be checked/i,
  /could not check/i,
  // The move panel's own wording for the same thing.
  /are not counted either way/i,
  // Why an ENRICH_THE_RECORD action is being offered — `next-action.ts`:
  // "A field the score needed, could not read, and a provider could plausibly
  // find." The `could not read` is describing the *score's* gap, which is the
  // reason the card is offering to fill it, and is as much the intended output
  // as the sentence above it. It surfaces on any workspace with enrichable gaps
  // and no enrichment run yet — which is every workspace on its first day, and
  // is why a suite that only ever ran against an already-enriched container had
  // not seen it.
  /a provider could plausibly find/i,
];

/* -------------------------------------------------------------------------- */
/* The pipeline board                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Open the board and wait until it has actually painted.
 *
 * Reached through the sidebar rather than by URL, for the reason
 * `05-calibration.spec.ts` gives about the audit log: the sidebar entry is the
 * thing a rep uses, the page's id is not stable across a re-apply, and a direct
 * route would skip the navigation item that PIPELINE_SPEC.md says must be first.
 *
 * The wait is on a lane header rather than on the page title, because the title
 * is static markup and is on screen a second before the one request that paints
 * the nine lanes has come back.
 */
export const openPipelineBoard = async (page: Page): Promise<void> => {
  await page.goto('/');
  await waitForShell(page);
  await sidebarEntry(page, 'Greenlight Pipeline').first().click();

  await expect(
    laneHeading(page, 'Captured'),
    'the board did not paint — the pipeline logic function returned nothing ' +
      'the front component could render',
  ).toBeVisible({ timeout: 90_000 });
};

/**
 * A lane column, located by the label in its own header.
 *
 * The inner locator is `header strong` and not `section header strong`, because
 * Playwright re-roots a `has:` locator at the element being filtered — a
 * selector that starts at `section` would be looking for a lane inside a lane
 * and would quietly match nothing.
 */
export const laneColumn = (page: Page, label: string): Locator =>
  page.locator('section').filter({
    has: page.locator('header strong').filter({
      hasText: new RegExp(`^${escapeRegExp(label)}$`),
    }),
  });

export const laneHeading = (page: Page, label: string): Locator =>
  page.locator('section header strong').filter({
    hasText: new RegExp(`^${escapeRegExp(label)}$`),
  });

/** The nine lane labels, in the order they are rendered. */
export const laneLabelsInOrder = async (page: Page): Promise<string[]> =>
  page.locator('section header strong').allInnerTexts();

/**
 * The count in a lane header.
 *
 * The header is `<strong>{label}</strong><span>{total}</span>`, so the count is
 * the sibling span. Returned as a number, or null when the lane rendered the
 * em-dash it uses for "this lane did not come back".
 */
export const laneCount = async (
  page: Page,
  label: string,
): Promise<number | null> => {
  const text = (
    await laneColumn(page, label).locator('header span').first().innerText()
  ).trim();

  // `toLocaleString` puts separators into four-figure lanes, and the lane that
  // failed to load renders an em-dash instead of a number.
  const digits = text.replace(/[^\d]/g, '');

  return digits === '' ? null : Number(digits);
};

/**
 * One card.
 *
 * The board renders each card as an `<article>` and carries no test ids, so the
 * display name is the only handle there is. `hasText` on the article rather than
 * a text locator inside it, so the returned locator is the card itself and the
 * buttons scoped to it are that card's buttons and not the next one's.
 */
export const pipelineCard = (page: Page, displayName: string): Locator =>
  page.locator('article').filter({ hasText: displayName });

/** Every card on the board, in DOM order. */
export const pipelineCards = (page: Page): Locator => page.locator('article');

export type BoardCardView = {
  /** The heading of the card: a lead's name, or the deal's. */
  readonly name: string;
  /**
   * The action sentence — the last piece of prose on the face of the card,
   * located by position rather than by wording. See `readPipelineCards`.
   */
  readonly sentence: string;
  /** The line above the sentence. A chip when the card has one, junk when not. */
  readonly aboveSentence: string;
  /** Every visible line of the card, in order, blank lines dropped. */
  readonly lines: readonly string[];
  readonly buttons: readonly string[];
};

/**
 * Read every card on the board in one pass.
 *
 * Two reasons this is an `evaluate` and not a set of locators. It is a hundred
 * and twelve cards on a seeded container and the sweep asks the same questions
 * of each, so locators would be a hundred and twelve round trips per question.
 * And the sentence has to be found *structurally*: the board's copy is being
 * edited, `NOTHING_TO_DO` has had its chip taken away once already, and a helper
 * that recognised the sentence by matching known wording would stop finding it
 * the next time the wording improved.
 *
 * The card renders, in order: the name and score, the company, the readiness,
 * the action row — an optional chip, the sentence, an optional button — and then
 * the "Why this" row. So the action sentence is the last leaf `<span>` before
 * the first "Why this" / "Less" button, whatever any of it says, and whether or
 * not a chip is above it.
 */
export const readPipelineCards = async (
  page: Page,
): Promise<BoardCardView[]> =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('article')).map((article) => {
      const element = article as HTMLElement;
      const heading = element.querySelector('span') as HTMLElement | null;

      const nodes = Array.from(element.querySelectorAll('span, button'));
      const expander = nodes.findIndex(
        (node) =>
          node.tagName === 'BUTTON' &&
          ['Why this', 'Less'].includes((node as HTMLElement).innerText.trim()),
      );
      const face = expander === -1 ? nodes : nodes.slice(0, expander);
      const prose = face
        .filter(
          (node) =>
            node.tagName === 'SPAN' &&
            node.children.length === 0 &&
            (node as HTMLElement).innerText.trim() !== '',
        )
        .map((node) => (node as HTMLElement).innerText.trim());

      return {
        name: heading?.innerText.trim() ?? '',
        sentence: prose[prose.length - 1] ?? '',
        aboveSentence: prose[prose.length - 2] ?? '',
        lines: (element.innerText ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== ''),
        buttons: Array.from(element.querySelectorAll('button')).map((button) =>
          (button as HTMLElement).innerText.trim(),
        ),
      };
    }),
  );

/**
 * The three affordances that are not the card's *action*.
 *
 * "Why this" / "Less" expand the card, "Move…" opens the move panel and
 * "Cancel" closes it. None of them is the button the ranking asked for, so the
 * "an actionable card offers a button" assertion has to exclude them.
 */
export const CARD_NAVIGATION_BUTTONS = ['Why this', 'Less', 'Move…', 'Cancel'];

/**
 * Record every request the board makes to its own route.
 *
 * The AI rewrite is the one operation on this screen that spends money, and the
 * claim that it is opt-in is a claim about requests rather than about pixels:
 * the confirmation can look perfect while the component posts `withNarrative`
 * anyway. Returns a live array — read it after the interaction.
 */
export const capturePipelineRequests = (page: Page): { action: string; body: string }[] => {
  const seen: { action: string; body: string }[] = [];

  page.on('request', (request) => {
    if (!request.url().includes('/greenlight/pipeline')) {
      return;
    }

    const body = request.postData() ?? '';
    let action = 'unparsed';

    try {
      action = String((JSON.parse(body) as { action?: unknown }).action ?? 'none');
    } catch {
      action = 'unparsed';
    }

    seen.push({ action, body });
  });

  return seen;
};

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
