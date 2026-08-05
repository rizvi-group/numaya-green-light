import { defineConfig, devices } from '@playwright/test';

/**
 * Greenlight demo recordings — a **separate** Playwright project from the test
 * suite, run explicitly:
 *
 *   npx playwright test --config playwright.demos.config.ts
 *
 * It is separate for one reason: `npx playwright test` must go on meaning the
 * 24-test verification suite and nothing else. `testDir` here is `./demos`,
 * `testDir` there is `./tests`, and neither can reach the other's files. Nothing
 * in `e2e/tests/`, `e2e/support/` or `playwright.config.ts` was modified to make
 * recording possible.
 *
 * What differs from the test config, and why:
 *
 *   - `video: 'on'` at the full viewport, because the video *is* the artefact.
 *   - `slowMo`, so a human can follow a click instead of seeing a screen change.
 *   - a very long per-test timeout: these are paced for watching, and demo 5
 *     waits on a real search engine and a real local model.
 *   - `retries: 0`. A half-recorded retry would silently overwrite a good take.
 */
const BASE_URL = process.env.GREENLIGHT_E2E_BASE_URL ?? 'http://localhost:2020';

/**
 * The same allow-list guard the test config carries, for the same reason and
 * with more force: these recordings create, mutate and delete Person records,
 * and a video is the one artefact somebody might later publish. Anything that is
 * not a loopback dev container has to be named deliberately.
 */
const { hostname } = new URL(BASE_URL);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const allowed =
  LOOPBACK.has(hostname) ||
  (process.env.GREENLIGHT_E2E_ALLOW_NON_LOCAL ?? '') === hostname;

if (!allowed) {
  throw new Error(
    `Refusing to record against ${hostname}: the demos create and delete ` +
      'Person records and produce a shareable video. They only run against a ' +
      'local dev container. If you really mean it, set ' +
      'GREENLIGHT_E2E_ALLOW_NON_LOCAL to that exact hostname.',
  );
}

const VIEWPORT = { width: 1600, height: 1000 };

export default defineConfig({
  testDir: './demos',
  testMatch: /.*\.demo\.ts$/,
  outputDir: './demos/output/.playwright',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 900_000,
  expect: { timeout: 90_000 },
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    viewport: VIEWPORT,
    actionTimeout: 90_000,
    navigationTimeout: 120_000,
    trace: 'off',
    screenshot: 'off',
    launchOptions: { slowMo: 220 },
  },
  projects: [
    {
      name: 'setup',
      testDir: './',
      testMatch: /auth\.setup\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: VIEWPORT,
        video: 'off',
        launchOptions: { slowMo: 0 },
      },
    },
    {
      name: 'demos',
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: VIEWPORT,
        storageState: '.auth/state.json',
        video: { mode: 'on', size: VIEWPORT },
      },
    },
  ],
});
