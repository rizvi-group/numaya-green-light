/**
 * The calibration cache seal.
 *
 * The keys below are **synthetic**, in the same spirit as
 * `src/licensing/__tests__/fixtures.ts`: shaped like a real Numaya key so the
 * containment assertion scans for a realistically shaped value, but issued to
 * nobody and granting nothing. No test here makes a network call.
 *
 * Two properties are asserted, and they are the only two the module claims:
 * licence-binding (a tag made under one key does not verify under another) and
 * tamper-evidence (an edited body does not verify). Authenticity of origin is
 * the Ed25519 signature's job and is not tested here.
 */

import { createLicenceKeySeal } from 'src/logic-functions/licence-cache-seal';
import { describe, expect, it } from 'vitest';

/** Synthetic. Stands in for the workspace's configured licence key. */
const LICENCE_KEY = 'NUMAYA-T3ST0-C4L1B-K3Y00-A';

/** Synthetic. A second workspace's key, used to prove the binding. */
const OTHER_LICENCE_KEY = 'NUMAYA-T3ST0-0TH3R-K3Y00-B';

const BODY = JSON.stringify({
  cachedAt: '2026-08-02T12:00:00.000Z',
  calibration: { calibrationVersion: 4, decisionMakerTitles: ['ceo'] },
  keyId: 'greenlight-calibration-1',
  verifiedAt: '2026-08-02T12:00:00.000Z',
});

describe('a workspace with no licence key', () => {
  it.each([
    ['null', null],
    ['blank', '   '],
    ['empty', ''],
  ])('seals nothing and accepts nothing for a %s key', async (_label, key) => {
    // Failing closed on the cache is safe precisely because failing closed here
    // means falling back to the shipped defaults, which is a working product.
    const seal = createLicenceKeySeal(key);

    expect(await seal.seal(BODY)).toBeNull();
    expect(await seal.verify(BODY, 'anything')).toBe(false);
  });

  it('does not accept a tag produced by a real key', async () => {
    const tag = await createLicenceKeySeal(LICENCE_KEY).seal(BODY);

    expect(tag).not.toBeNull();
    expect(await createLicenceKeySeal(null).verify(BODY, tag as string)).toBe(
      false,
    );
  });
});

describe('a workspace with a licence key', () => {
  it('verifies its own tag', async () => {
    const seal = createLicenceKeySeal(LICENCE_KEY);
    const tag = await seal.seal(BODY);

    expect(tag).not.toBeNull();
    expect(await seal.verify(BODY, tag as string)).toBe(true);
  });

  it('produces the same tag from a second seal built on the same key', async () => {
    // The tag has to survive a process restart — the seal is rebuilt on every
    // run and the cached entry is not.
    const tag = await createLicenceKeySeal(LICENCE_KEY).seal(BODY);

    expect(await createLicenceKeySeal(LICENCE_KEY).verify(BODY, tag as string)).toBe(
      true,
    );
  });

  it('ignores surrounding whitespace on the key', async () => {
    const tag = await createLicenceKeySeal(LICENCE_KEY).seal(BODY);

    expect(
      await createLicenceKeySeal(`  ${LICENCE_KEY}\n`).verify(BODY, tag as string),
    ).toBe(true);
  });
});

describe('licence binding', () => {
  it('refuses a tag produced under a different licence key', async () => {
    // This is the property the whole module exists for: a cache lifted out of a
    // licensed workspace and dropped into another one is rejected.
    const tag = await createLicenceKeySeal(LICENCE_KEY).seal(BODY);

    expect(
      await createLicenceKeySeal(OTHER_LICENCE_KEY).verify(BODY, tag as string),
    ).toBe(false);
  });

  it('produces a different tag for each key', async () => {
    expect(await createLicenceKeySeal(LICENCE_KEY).seal(BODY)).not.toBe(
      await createLicenceKeySeal(OTHER_LICENCE_KEY).seal(BODY),
    );
  });
});

describe('tamper evidence', () => {
  it('refuses a body that has been edited', async () => {
    const seal = createLicenceKeySeal(LICENCE_KEY);
    const tag = await seal.seal(BODY);

    expect(
      await seal.verify(BODY.replace('"calibrationVersion":4', '"calibrationVersion":5'), tag as string),
    ).toBe(false);
  });

  it('refuses a body that differs by a single character', async () => {
    const seal = createLicenceKeySeal(LICENCE_KEY);
    const tag = await seal.seal(BODY);

    expect(await seal.verify(`${BODY} `, tag as string)).toBe(false);
  });

  it('refuses a tag that has been edited', async () => {
    const seal = createLicenceKeySeal(LICENCE_KEY);
    const tag = (await seal.seal(BODY)) as string;
    const flipped = `${tag[0] === 'A' ? 'B' : 'A'}${tag.slice(1)}`;

    expect(await seal.verify(BODY, flipped)).toBe(false);
  });

  it('refuses a tag of the wrong length', async () => {
    const seal = createLicenceKeySeal(LICENCE_KEY);
    const tag = (await seal.seal(BODY)) as string;

    expect(await seal.verify(BODY, tag.slice(0, -1))).toBe(false);
    expect(await seal.verify(BODY, '')).toBe(false);
  });
});

describe('key containment', () => {
  it('never places the licence key in the tag', async () => {
    // `src/licensing/types.ts` records the structural guarantee that no licence
    // key leaves this file. The tag is the one value that does.
    const tag = (await createLicenceKeySeal(LICENCE_KEY).seal(BODY)) as string;

    expect(tag).not.toContain(LICENCE_KEY);
    expect(tag).not.toContain('C4L1B');
    expect(tag).not.toContain('NUMAYA');
  });
});
