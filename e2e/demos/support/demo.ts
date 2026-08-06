import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type { Locator, Page } from '@playwright/test';

/**
 * Presentation helpers for the Greenlight demo recordings.
 *
 * ## What this is, and what it is deliberately not
 *
 * These are **demos, not tests**. Nothing in this directory asserts a product
 * claim — the assertions live in `e2e/tests/`, run in CI, and are the reason
 * anybody should believe the videos. What these files do is pace a real session
 * against the real dev container so a person can watch it: a bigger cursor, a
 * caption bar, and pauses on the screens that carry the point.
 *
 * ## The one rule
 *
 * Every number, trace, audit row and provider response on screen is produced by
 * the running app. Nothing here writes a value in order to display it. The only
 * things this module puts on screen that the app did not draw are:
 *
 *   - the caption bar and title cards, which are narration and look like it;
 *   - the trace panel in demo 1, which *reformats* the record's own
 *     `greenlightTrace` so it can be read, and says so on screen.
 *
 * Twenty renders a RAW_JSON field as one truncated line in a 200px box, so the
 * rule-by-rule trace — the product's central claim — is genuinely unreadable in
 * the product today. Showing it as one illegible line would have been the more
 * literal choice and the less honest one, because a viewer would conclude the
 * trace does not exist. The panel prints the app's own words, verbatim, and
 * carries a footer saying it is the demo doing the formatting.
 */

export const OUTPUT_DIR = path.join(process.cwd(), 'demos', 'output');

const CAPTION_FONT =
  'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

/**
 * Install the demo chrome: a visible cursor, a caption bar and a card layer.
 *
 * Playwright drives the browser with real input events but paints no pointer,
 * so an unadorned recording is a screen where things change for no visible
 * reason. This is an init script, so it survives every navigation.
 *
 * Must be called before the first `goto`.
 */
export const installDemoChrome = async (page: Page): Promise<void> => {
  await page.addInitScript(
    ({ font }) => {
      const build = () => {
        if (document.getElementById('__gl_demo_layer') !== null) {
          return;
        }

        const layer = document.createElement('div');
        layer.id = '__gl_demo_layer';
        layer.style.cssText =
          'position:fixed;inset:0;z-index:2147483647;pointer-events:none;' +
          `font-family:${font};`;
        document.body.appendChild(layer);

        // --- pointer ---------------------------------------------------------
        const cursor = document.createElement('div');
        cursor.style.cssText =
          'position:fixed;left:-200px;top:-200px;width:26px;height:26px;' +
          'margin:-13px 0 0 -13px;border-radius:50%;border:2.5px solid #16794a;' +
          'background:rgba(22,121,74,.22);box-shadow:0 0 0 4px rgba(22,121,74,.12);' +
          'transition:width .08s,height .08s,background .08s;pointer-events:none;';
        layer.appendChild(cursor);

        addEventListener(
          'mousemove',
          (event) => {
            cursor.style.left = `${(event as MouseEvent).clientX}px`;
            cursor.style.top = `${(event as MouseEvent).clientY}px`;
          },
          true,
        );
        addEventListener(
          'mousedown',
          () => {
            cursor.style.width = '38px';
            cursor.style.height = '38px';
            cursor.style.margin = '-19px 0 0 -19px';
            cursor.style.background = 'rgba(22,121,74,.45)';
          },
          true,
        );
        addEventListener(
          'mouseup',
          () => {
            cursor.style.width = '26px';
            cursor.style.height = '26px';
            cursor.style.margin = '-13px 0 0 -13px';
            cursor.style.background = 'rgba(22,121,74,.22)';
          },
          true,
        );

        // --- caption bar -----------------------------------------------------
        const caption = document.createElement('div');
        caption.id = '__gl_demo_caption';
        caption.style.cssText =
          'position:fixed;left:0;right:0;bottom:0;padding:20px 40px 22px;' +
          'background:linear-gradient(180deg,rgba(9,17,28,.86) 0%,rgba(9,17,28,.96) 100%);' +
          'color:#fff;font-size:23px;line-height:1.38;font-weight:500;' +
          'text-align:center;letter-spacing:.1px;opacity:0;' +
          'transition:opacity .25s ease;pointer-events:none;' +
          'border-top:3px solid #16794a;';
        layer.appendChild(caption);

        // --- highlight ring --------------------------------------------------
        const ring = document.createElement('div');
        ring.id = '__gl_demo_ring';
        // A ring, not a spotlight cut-out. `box-shadow` with a viewport-sized
        // spread was tried first and rendered nothing in the recording, so the
        // highlight earns its attention with contrast instead of by dimming
        // everything else.
        ring.style.cssText =
          'position:fixed;border:3px solid #16794a;border-radius:10px;' +
          'box-shadow:0 0 0 4px rgba(22,121,74,.22),0 0 22px rgba(22,121,74,.5);' +
          'opacity:0;transition:opacity .25s ease,left .25s ease,top .25s ease,' +
          'width .25s ease,height .25s ease;pointer-events:none;';
        layer.appendChild(ring);

        // --- card layer (title cards, the trace panel) ------------------------
        const card = document.createElement('div');
        card.id = '__gl_demo_card';
        card.style.cssText =
          'position:fixed;inset:0;display:flex;align-items:center;' +
          'justify-content:center;background:rgba(7,14,23,.94);opacity:0;' +
          'transition:opacity .35s ease;pointer-events:none;';
        layer.appendChild(card);

        const api = {
          caption(text: string) {
            if (text === '') {
              caption.style.opacity = '0';
              return;
            }
            caption.textContent = text;
            caption.style.opacity = '1';
          },
          ring(box: { x: number; y: number; w: number; h: number } | null) {
            if (box === null) {
              ring.style.opacity = '0';
              return;
            }
            ring.style.left = `${box.x - 6}px`;
            ring.style.top = `${box.y - 6}px`;
            ring.style.width = `${box.w + 12}px`;
            ring.style.height = `${box.h + 12}px`;
            ring.style.opacity = '1';
          },
          card(html: string | null) {
            if (html === null) {
              card.style.opacity = '0';
              window.setTimeout(() => {
                card.innerHTML = '';
              }, 400);
              return;
            }
            card.innerHTML = html;
            card.style.opacity = '1';
          },
        };

        (window as unknown as Record<string, unknown>)['__glDemo'] = api;
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', build);
      } else {
        build();
      }

      // Twenty's shell mounts late and can replace large parts of the tree; a
      // cheap re-check costs nothing and stops the chrome disappearing.
      setInterval(build, 1_000);
    },
    { font: CAPTION_FONT },
  );
};

type DemoApi = {
  caption: (text: string) => void;
  ring: (box: { x: number; y: number; w: number; h: number } | null) => void;
  card: (html: string | null) => void;
};

/**
 * Reach the in-page demo API.
 *
 * The chrome is (re)built on a one-second interval, so a call landing during a
 * navigation is normal rather than exceptional. Every call waits for it and then
 * swallows failure: a missing caption must never fail a recording mid-flight.
 */
const withDemo = async <T>(
  page: Page,
  fn: (argument: T) => void,
  argument: T,
): Promise<void> => {
  await page
    .waitForFunction(
      () =>
        (window as unknown as Record<string, unknown>)['__glDemo'] !== undefined,
      undefined,
      { timeout: 20_000 },
    )
    .catch(() => undefined);

  // `fn` is serialised and re-evaluated in the browser, so it may not reference
  // anything in this module's scope. Every callback below is self-contained.
  //
  // The cast is Playwright's `Unboxed<T>`: `evaluate` unwraps JSHandles out of
  // its argument type, and the compiler cannot see that a plain JSON argument
  // survives that unchanged. Every caller here passes a string, a plain object
  // of numbers, or null.
  const evaluate = page.evaluate.bind(page) as (
    pageFunction: (argument: T) => void,
    argument: T,
  ) => Promise<void>;

  await evaluate(fn, argument).catch(() => undefined);
};

/** Put a sentence on screen and hold it long enough to read. */
export const say = async (
  page: Page,
  text: string,
  holdMs = 3_400,
): Promise<void> => {
  await withDemo(
    page,
    (value: string) => {
      const demo = (window as unknown as Record<string, unknown>)['__glDemo'] as
        | DemoApi
        | undefined;
      demo?.caption(value);
    },
    text,
  );

  await page.waitForTimeout(holdMs);
};

/** Clear the caption bar and any highlight. */
export const clearCaption = async (page: Page): Promise<void> => {
  await withDemo(
    page,
    () => {
      const demo = (window as unknown as Record<string, unknown>)['__glDemo'] as
        | DemoApi
        | undefined;
      demo?.caption('');
      demo?.ring(null);
    },
    null,
  );
};

/** Ring an element and dim everything else. */
export const spotlight = async (
  page: Page,
  target: Locator,
  holdMs = 0,
): Promise<void> => {
  try {
    await target.first().scrollIntoViewIfNeeded({ timeout: 5_000 });
  } catch {
    // A target that will not scroll is still worth ringing where it is.
  }

  const box = await target.first().boundingBox();

  if (box === null) {
    return;
  }

  await withDemo(
    page,
    (value: { x: number; y: number; w: number; h: number }) => {
      const demo = (window as unknown as Record<string, unknown>)['__glDemo'] as
        | DemoApi
        | undefined;
      demo?.ring(value);
    },
    { x: box.x, y: box.y, w: box.width, h: box.height },
  );

  if (holdMs > 0) {
    await page.waitForTimeout(holdMs);
  }
};

/**
 * Ring several elements at once, as one box.
 *
 * A field on Twenty's record page is a label and a value in separate nodes with
 * no addressable row around them, so "highlight the score" means highlighting
 * the union of the two.
 */
export const spotlightUnion = async (
  page: Page,
  targets: Locator[],
  holdMs = 0,
): Promise<void> => {
  const boxes = [];

  for (const target of targets) {
    try {
      await target.first().scrollIntoViewIfNeeded({ timeout: 5_000 });
    } catch {
      // Ring it where it is.
    }

    const box = await target.first().boundingBox();

    if (box !== null) {
      boxes.push(box);
    }
  }

  if (boxes.length === 0) {
    return;
  }

  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));

  await withDemo(
    page,
    (value: { x: number; y: number; w: number; h: number }) => {
      const demo = (window as unknown as Record<string, unknown>)['__glDemo'] as
        | DemoApi
        | undefined;
      demo?.ring(value);
    },
    { x: left, y: top, w: right - left, h: bottom - top },
  );

  if (holdMs > 0) {
    await page.waitForTimeout(holdMs);
  }
};

/**
 * Ring an explicit rectangle, without scrolling anything to reach it.
 *
 * `spotlight` scrolls its target into view, which is right for a card and wrong
 * for an element that is taller than the page: the pipeline board's handoff line
 * is a full-height column, its label sits at the vertical centre of fifteen
 * thousand pixels of lane, and asking the browser to bring that label into view
 * scrolls the board to its own middle — headers gone, half the lanes apparently
 * empty. The caller works out the box it wants ringed and passes it here.
 */
export const spotlightBox = async (
  page: Page,
  box: { x: number; y: number; w: number; h: number },
  holdMs = 0,
): Promise<void> => {
  await withDemo(
    page,
    (value: { x: number; y: number; w: number; h: number }) => {
      const demo = (window as unknown as Record<string, unknown>)['__glDemo'] as
        | DemoApi
        | undefined;
      demo?.ring(value);
    },
    box,
  );

  if (holdMs > 0) {
    await page.waitForTimeout(holdMs);
  }
};

export const clearSpotlight = async (page: Page): Promise<void> => {
  await withDemo(
    page,
    () => {
      const demo = (window as unknown as Record<string, unknown>)['__glDemo'] as
        | DemoApi
        | undefined;
      demo?.ring(null);
    },
    null,
  );
};

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** A full-screen card. Used for the opening and closing frames. */
export const titleCard = async (
  page: Page,
  title: string,
  subtitle: string,
  holdMs = 4_200,
): Promise<void> => {
  const html = `
    <div style="max-width:1100px;padding:0 60px;text-align:center;color:#fff;
                font-family:${CAPTION_FONT};">
      <div style="font-size:15px;letter-spacing:3.4px;text-transform:uppercase;
                  color:#5fd39b;font-weight:700;margin-bottom:26px;">
        Numaya Greenlight
      </div>
      <div style="font-size:52px;line-height:1.18;font-weight:700;
                  margin-bottom:24px;">${escapeHtml(title)}</div>
      <div style="font-size:24px;line-height:1.5;color:#b9c6d3;font-weight:400;">
        ${escapeHtml(subtitle)}
      </div>
    </div>`;

  await showCard(page, html, holdMs);
};

/** Show arbitrary card HTML, hold, then fade it out. */
export const showCard = async (
  page: Page,
  html: string,
  holdMs: number,
): Promise<void> => {
  await withDemo(
    page,
    (value: string) => {
      const demo = (window as unknown as Record<string, unknown>)['__glDemo'] as
        | DemoApi
        | undefined;
      demo?.caption('');
      demo?.ring(null);
      demo?.card(value);
    },
    html,
  );

  await page.waitForTimeout(holdMs);

  await withDemo(
    page,
    () => {
      const demo = (window as unknown as Record<string, unknown>)['__glDemo'] as
        | DemoApi
        | undefined;
      demo?.card(null);
    },
    null,
  );

  await page.waitForTimeout(500);
};

/** One rule as the engine wrote it into `greenlightTrace`. */
type TraceRuleRow = {
  ruleName?: string;
  question?: string;
  outcome?: string;
  explanation?: string;
  pointsEarned?: number;
  pointsPossible?: number;
};

const OUTCOME_COLOUR: Record<string, string> = {
  pass: '#3fb27f',
  fail: '#e2564a',
  not_applicable: '#8b98a5',
  unknown: '#d9a441',
};

/**
 * Render the record's own trace so it can be read on screen.
 *
 * Nothing here is invented: every rule name, question, outcome, point value and
 * sentence is lifted verbatim out of the `greenlightTrace` column the scoring
 * run wrote. The card says as much in its footer, because a viewer is entitled
 * to know which pixels are the product and which are the demo.
 */
export const traceCard = async (
  page: Page,
  trace: unknown,
  leadName: string,
  score: number | null,
  holdMs: number,
): Promise<void> => {
  const rules = Array.isArray((trace as { rules?: unknown })?.rules)
    ? ((trace as { rules: TraceRuleRow[] }).rules ?? [])
    : [];

  const band = String((trace as { band?: unknown })?.band ?? '');

  const rows = rules
    .map((rule) => {
      const outcome = String(rule.outcome ?? '');
      const colour = OUTCOME_COLOUR[outcome] ?? '#8b98a5';
      const label =
        outcome === 'not_applicable'
          ? 'not used'
          : outcome.replace(/_/g, ' ');

      return `
        <div style="display:grid;grid-template-columns:250px 96px 1fr;gap:18px;
                    align-items:baseline;padding:9px 0;
                    border-bottom:1px solid rgba(255,255,255,.07);">
          <div style="font-weight:600;font-size:17px;color:#fff;">
            ${escapeHtml(String(rule.ruleName ?? ''))}
          </div>
          <div style="font-size:15px;font-weight:700;color:${colour};
                      text-transform:uppercase;letter-spacing:.6px;">
            ${escapeHtml(label)}
            <span style="display:block;color:#8b98a5;font-weight:500;
                         text-transform:none;letter-spacing:0;font-size:13px;">
              ${rule.pointsEarned ?? 0}/${rule.pointsPossible ?? 0} pts
            </span>
          </div>
          <div style="font-size:16px;color:#c9d5e1;line-height:1.4;">
            ${escapeHtml(String(rule.explanation ?? ''))}
          </div>
        </div>`;
    })
    .join('');

  const html = `
    <div style="width:1420px;max-height:930px;overflow:hidden;color:#fff;
                font-family:${CAPTION_FONT};">
      <div style="display:flex;align-items:baseline;gap:18px;margin-bottom:6px;">
        <div style="font-size:30px;font-weight:700;">Why this lead was held</div>
        <div style="font-size:19px;color:#8b98a5;">
          ${escapeHtml(leadName)} &middot; ${score ?? '—'}/100
          ${band === '' ? '' : `&middot; ${escapeHtml(band.toLowerCase())}`}
        </div>
      </div>
      <div style="font-size:16px;color:#8b98a5;margin-bottom:18px;">
        Greenlight records a verdict for every rule it ran, in plain English.
      </div>
      ${rows}
      <div style="margin-top:16px;font-size:14px;color:#6f7d8b;font-style:italic;">
        Read from the lead's own Score trace field. Twenty stores it as one line
        of JSON, so this demo has formatted it — the wording and the numbers are
        Greenlight's.
      </div>
    </div>`;

  await showCard(page, html, holdMs);
};

/**
 * Dismiss the dev container's mailbox-sync banner.
 *
 * It belongs to Twenty's seeded demo account, has nothing to do with Greenlight,
 * and eats the top of every frame. Dismissed by clicking its own close control,
 * never by hiding it, so if it ever carried something that mattered it would
 * still have been a user action.
 */
export const dismissNoise = async (page: Page): Promise<void> => {
  // Twenty gives the control an accessible name, which is both the stable hook
  // and the reason this is a click rather than a `display:none`.
  const close = page.locator('button[aria-label="Close banner"]');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if ((await close.count()) === 0) {
        return;
      }

      await close.first().click({ timeout: 4_000 });
      await page.waitForTimeout(400);
    } catch {
      return;
    }
  }
};

/**
 * Move the pointer to an element before clicking it.
 *
 * Playwright's own click teleports the cursor, which on a recording reads as a
 * click that came from nowhere. This walks the pointer there first.
 */
export const pointAndClick = async (
  page: Page,
  target: Locator,
  { pauseMs = 700 }: { pauseMs?: number } = {},
): Promise<void> => {
  const element = target.first();
  await element.scrollIntoViewIfNeeded().catch(() => undefined);

  const box = await element.boundingBox();

  if (box !== null) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
      steps: 18,
    });
    await page.waitForTimeout(pauseMs);
  }

  try {
    await element.click({ timeout: 15_000 });
  } catch {
    // Moving the pointer onto a clipped table cell is what raises Twenty's
    // overflow tooltip, and the tooltip then sits over the very link the
    // pointer is on — so the friendlier cursor movement is itself what blocks
    // the click. A forced click is right here and would be wrong in a test:
    // this file is recording a demo, and the actionability check has already
    // been satisfied by the element being visible and boxed above.
    await element.click({ force: true, timeout: 15_000 });
  }
};

/**
 * Park the pointer somewhere harmless.
 *
 * Leaving it on a sidebar entry pops Twenty's tooltip and holds it there for the
 * rest of the shot, which reads as a rendering fault rather than a hover.
 */
export const restPointer = async (page: Page): Promise<void> => {
  await page.mouse.move(900, 560, { steps: 12 });
  await page.waitForTimeout(300);
};

/**
 * Close the context so the video is flushed, then file it under a readable name.
 *
 * Playwright names videos after a hash of the test, in a directory nobody would
 * think to look in. One scenario, one file, named for the scenario.
 */
export const saveDemoVideo = async (
  page: Page,
  slug: string,
): Promise<string | null> => {
  const video = page.video();

  if (video === null) {
    return null;
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const target = path.join(OUTPUT_DIR, `${slug}.webm`);

  await page.context().close();
  await video.saveAs(target);

  return target;
};
