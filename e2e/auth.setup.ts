import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { expect, test as setup } from '@playwright/test';

export const STORAGE_STATE = '.auth/state.json';

/**
 * Sign in once and hand every other test a warm session.
 *
 * The dev container runs with `SIGN_IN_PREFILLED=true`. What that actually does
 * — checked in the browser rather than assumed — is fill *both* the email and
 * the password input of the seeded workspace member (`tim@apple.dev`) before
 * the form is ever shown. There is no password to supply and no credential to
 * keep anywhere: the flow is Continue, then Sign in.
 *
 * That is also why this file is the only place that touches the sign-in screen.
 * If the container is ever run without the flag the failure lands here, once,
 * with a clear message, instead of as ten confusing timeouts inside feature
 * tests.
 */
setup('sign in and save storage state', async ({ page }) => {
  await page.goto('/');

  const emailField = page.getByPlaceholder('Email');
  await expect(emailField).toBeVisible({ timeout: 60_000 });

  const email = await emailField.inputValue();
  expect(
    email,
    'SIGN_IN_PREFILLED is expected to pre-fill the seeded member address. ' +
      'If this is empty the container is not running with SIGN_IN_PREFILLED=true ' +
      'and this suite needs a real credential flow.',
  ).toBe('tim@apple.dev');

  await page.getByRole('button', { name: 'Continue' }).click();

  const passwordField = page.getByPlaceholder('Password');
  await expect(passwordField).toBeVisible();
  expect(
    await passwordField.inputValue(),
    'SIGN_IN_PREFILLED is expected to pre-fill the password too.',
  ).not.toBe('');

  await page.getByRole('button', { name: 'Sign in' }).click();

  // The workspace shell is the proof we are in: the sidebar carries the
  // seeded workspace name and the standard objects.
  await expect(page.getByRole('link', { name: 'People' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page).not.toHaveURL(/\/welcome/);

  if (!existsSync(dirname(STORAGE_STATE))) {
    mkdirSync(dirname(STORAGE_STATE), { recursive: true });
  }

  await page.context().storageState({ path: STORAGE_STATE });
});
