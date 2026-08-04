import { defineConfig, devices } from '@playwright/test';

/**
 * Greenlight end-to-end tests.
 *
 * These run against the throwaway Twenty dev container on Windows Docker
 * (`twenty-app-dev`, published on http://localhost:2020). They must never be
 * pointed at a real workspace: the suite creates and deletes Person records.
 *
 * The suite is deliberately serial (`workers: 1`). Every test drives the same
 * single workspace, and the gate queue and ICP screens are workspace-global
 * state — two workers would see each other's records and each other's config
 * writes.
 */
const BASE_URL = process.env.GREENLIGHT_E2E_BASE_URL ?? 'http://localhost:2020';

/**
 * Allow-list, not a deny-list.
 *
 * This guard used to name a specific production host and refuse it. That is the
 * wrong shape twice over: it protects exactly one workspace and silently permits
 * every other real one, and in a public repository the guard advertises the host
 * it defends. An allow-list fails closed — anything that is not a loopback dev
 * container has to be named deliberately, by whoever is running the suite.
 */
const { hostname } = new URL(BASE_URL);
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const allowed =
  LOOPBACK.has(hostname) ||
  (process.env.GREENLIGHT_E2E_ALLOW_NON_LOCAL ?? '') === hostname;

if (!allowed) {
  throw new Error(
    `Refusing to run against ${hostname}: the e2e suite creates and deletes ` +
      'Person records, so it only runs against a local dev container. If you ' +
      'really mean it, set GREENLIGHT_E2E_ALLOW_NON_LOCAL to that exact hostname.',
  );
}

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1600, height: 1000 },
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'setup',
      testDir: './',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: 'greenlight',
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1600, height: 1000 },
        storageState: '.auth/state.json',
      },
    },
  ],
});
