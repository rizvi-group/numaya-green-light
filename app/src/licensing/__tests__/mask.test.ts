import {
  maskLicenceKey,
  MISSING_LICENCE_MASK,
  redactLicenceKey,
} from 'src/licensing/mask';
import {
  SANDBOX_RULES_ONLY_KEY,
  SANDBOX_TRIAL_KEY,
} from 'src/licensing/__tests__/fixtures';
import { describe, expect, it } from 'vitest';

/** Every character of a key that is not part of the constant product prefix. */
const secretCharacters = (key: string): string[] =>
  key
    .split('-')
    .slice(1)
    .flatMap((group) => group.split(''));

describe('maskLicenceKey', () => {
  it('should preserve the group structure so a malformed key is obvious', () => {
    expect(maskLicenceKey(SANDBOX_TRIAL_KEY)).toMatch(
      /^NUMAYA-\*{5}-\*{5}-\*{5}-\* #[0-9a-f]{8}$/,
    );
  });

  it('should emit no character of the secret groups', () => {
    // Compare against the *structural* part of the mask only. The constant
    // `NUMAYA` prefix and the hex fingerprint are both allowed to share
    // characters with the key — the prefix is identical on every key and the
    // fingerprint is a lossy hash — so including them would make this assertion
    // fail on a coincidence rather than on a leak.
    const structure = maskLicenceKey(SANDBOX_TRIAL_KEY)
      .replace(/ #[0-9a-f]{8}$/, '')
      .replace(/^NUMAYA/, '');

    const leaked = secretCharacters(SANDBOX_TRIAL_KEY).filter((character) =>
      structure.includes(character),
    );

    expect(leaked).toEqual([]);
  });

  it('should never contain any three-character run from the secret part of the key', () => {
    const mask = maskLicenceKey(SANDBOX_TRIAL_KEY);
    const secretStart = 'NUMAYA-'.length;
    const runs: string[] = [];

    for (
      let index = secretStart;
      index + 3 <= SANDBOX_TRIAL_KEY.length;
      index += 1
    ) {
      const run = SANDBOX_TRIAL_KEY.slice(index, index + 3);

      if (!run.includes('-') && mask.includes(run)) {
        runs.push(run);
      }
    }

    expect(runs).toEqual([]);
  });

  it('should distinguish two different keys', () => {
    expect(maskLicenceKey(SANDBOX_TRIAL_KEY)).not.toBe(
      maskLicenceKey(SANDBOX_RULES_ONLY_KEY),
    );
  });

  it('should be stable for the same key', () => {
    expect(maskLicenceKey(SANDBOX_TRIAL_KEY)).toBe(maskLicenceKey(SANDBOX_TRIAL_KEY));
  });

  it('should ignore surrounding whitespace, which admins paste constantly', () => {
    expect(maskLicenceKey(`  ${SANDBOX_TRIAL_KEY}\n`)).toBe(
      maskLicenceKey(SANDBOX_TRIAL_KEY),
    );
  });

  it('should mask an unrecognised prefix too', () => {
    // Only `NUMAYA` is echoed back, because only `NUMAYA` is known to be
    // constant across every key and therefore to carry no information.
    expect(maskLicenceKey('ACME-ABCDE')).toMatch(/^\*{4}-\*{5} #[0-9a-f]{8}$/);
  });

  it('should report a missing key rather than throwing', () => {
    expect(maskLicenceKey(null)).toBe(MISSING_LICENCE_MASK);
    expect(maskLicenceKey(undefined)).toBe(MISSING_LICENCE_MASK);
    expect(maskLicenceKey('')).toBe(MISSING_LICENCE_MASK);
    expect(maskLicenceKey('   ')).toBe(MISSING_LICENCE_MASK);
  });
});

describe('redactLicenceKey', () => {
  it('should strip a key echoed back inside an error message', () => {
    const message = `FetchError: POST https://license.numaya.ai/v1/licenses/validate {"key":"${SANDBOX_TRIAL_KEY}"} failed`;

    expect(redactLicenceKey(message, SANDBOX_TRIAL_KEY)).not.toContain(
      SANDBOX_TRIAL_KEY,
    );
  });

  it('should strip the URL-encoded form too', () => {
    const message = `bad request: key=${encodeURIComponent(SANDBOX_TRIAL_KEY)}`;

    expect(redactLicenceKey(message, SANDBOX_TRIAL_KEY)).not.toContain(
      encodeURIComponent(SANDBOX_TRIAL_KEY),
    );
  });

  it('should leave text alone when there is no key', () => {
    expect(redactLicenceKey('ENOTFOUND', null)).toBe('ENOTFOUND');
    expect(redactLicenceKey('ENOTFOUND', '')).toBe('ENOTFOUND');
  });
});
