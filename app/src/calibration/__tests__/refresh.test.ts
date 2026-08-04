/**
 * The calibration half of a nightly licence run, driven against an in-memory
 * store and a fake seal.
 *
 * The envelopes are genuinely signed with a throwaway Ed25519 keypair generated
 * per run — a stubbed verifier would leave the interesting question (does a
 * tampered payload reach the cache?) unasked. Nothing here opens a socket: the
 * `validate` response is supplied directly as `metadata`, which is exactly the
 * shape the real run hands over.
 */

import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { canonicalBytes } from 'src/calibration/canonical';
import { CALIBRATION_PUBLIC_KEYS } from 'src/calibration/keys';
import {
  CALIBRATION_METADATA_KEY,
  readCalibrationEnvelope,
} from 'src/calibration/parse';
import {
  describeCalibration,
  refreshCalibration,
  type RefreshCalibrationInput,
} from 'src/calibration/refresh';
import { type CalibrationSealPort } from 'src/calibration/seal';
import {
  type CachedCalibration,
  type CalibrationState,
  type CalibrationStorePort,
} from 'src/calibration/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TEST_KEY_ID = 'greenlight-calibration-test';
const NOW = new Date('2026-08-02T12:00:00.000Z');
const DISTINCTIVE_TITLE = 'oberster zzmarkerzz vorstand';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const keyTable = CALIBRATION_PUBLIC_KEYS as Record<string, string>;

beforeAll(() => {
  keyTable[TEST_KEY_ID] = publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('base64');
});

afterAll(() => {
  delete keyTable[TEST_KEY_ID];
});

const rawPayload = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  schemaVersion: 1,
  calibrationVersion: 12,
  issuedAt: '2026-08-01T00:00:00.000Z',
  notes: null,
  decisionMakerTitles: ['ceo', DISTINCTIVE_TITLE],
  influencerTitles: ['projektleiter'],
  roleInboxLocalParts: ['kontakt'],
  placeholderValues: ['k.a.'],
  industrySynonyms: { construction: ['zzbauvariantzz'] },
  ...overrides,
});

const latest = <T>(entries: readonly T[]): T | undefined =>
  entries[entries.length - 1];

/**
 * Sign the payload *as the parser will produce it*.
 *
 * `readCalibrationEnvelope` normalises every list, so signing the raw form would
 * produce an envelope that fails verification for a reason that has nothing to
 * do with what is being tested. Running the payload through the parser first is
 * what the real signing script does for the same reason.
 */
const signedMetadata = (
  payload: Record<string, unknown> = rawPayload(),
  keyId: string = TEST_KEY_ID,
): Record<string, unknown> => {
  const draft = { alg: 'Ed25519', keyId, signature: 'unsigned', payload };
  const read = readCalibrationEnvelope({ [CALIBRATION_METADATA_KEY]: draft });

  if (read.kind !== 'envelope') {
    throw new Error(`fixture payload did not parse: ${read.detail}`);
  }

  const message = canonicalBytes(read.envelope.payload);

  if (message === null) {
    throw new Error('fixture payload could not be canonicalised');
  }

  return {
    [CALIBRATION_METADATA_KEY]: {
      ...draft,
      signature: nodeSign(null, message, privateKey).toString('base64'),
    },
  };
};

/* -------------------------------------------------------------------------- */
/* Fakes                                                                       */
/* -------------------------------------------------------------------------- */

interface FakeStore extends CalibrationStorePort {
  entry: CachedCalibration | null;
  readonly written: CachedCalibration[];
  readonly published: CalibrationState[];
  readonly calls: string[];
}

const fakeStore = (initial: CachedCalibration | null = null): FakeStore => {
  const written: CachedCalibration[] = [];
  const published: CalibrationState[] = [];
  const calls: string[] = [];

  const store: FakeStore = {
    entry: initial,
    written,
    published,
    calls,
    readCalibration: async () => {
      calls.push('read');

      return store.entry;
    },
    writeCalibration: async (next) => {
      calls.push('write');
      written.push(next);
      store.entry = next;
    },
    clearCalibration: async () => {
      calls.push('clear');
      store.entry = null;
    },
    publishCalibrationState: async (state) => {
      calls.push('publish');
      published.push(state);
    },
  };

  return store;
};

const throwingStore = (): FakeStore => {
  const store = fakeStore();

  return {
    ...store,
    readCalibration: async () => {
      throw new Error('kv read failed');
    },
    writeCalibration: async () => {
      throw new Error('kv write failed');
    },
    clearCalibration: async () => {
      throw new Error('kv clear failed');
    },
    publishCalibrationState: async () => {
      throw new Error('kv publish failed');
    },
  };
};

const SEALS: CalibrationSealPort = {
  seal: async () => 'ZmFrZS1zZWFsLXRhZw==',
  verify: async () => true,
};

const NEVER_SEALS: CalibrationSealPort = {
  seal: async () => null,
  verify: async () => false,
};

const cachedEntry = (): CachedCalibration => {
  const read = readCalibrationEnvelope(signedMetadata());

  if (read.kind !== 'envelope') {
    throw new Error('fixture payload did not parse');
  }

  return {
    cachedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
    verifiedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
    keyId: TEST_KEY_ID,
    sealTag: 'ZXhpc3Rpbmc=',
    calibration: read.envelope.payload,
  };
};

const run = (
  store: CalibrationStorePort,
  overrides: Partial<RefreshCalibrationInput> = {},
): ReturnType<typeof refreshCalibration> =>
  refreshCalibration({
    store,
    seal: SEALS,
    metadata: signedMetadata(),
    live: true,
    entitled: true,
    now: NOW,
    ...overrides,
  });

/* -------------------------------------------------------------------------- */
/* The paid boundary                                                           */
/* -------------------------------------------------------------------------- */

describe('an unentitled licence', () => {
  it('clears the cache and publishes not_licensed', async () => {
    // Deletion rather than a flag is what lets the scoring path skip an
    // entitlement check entirely: a cache that exists was written while the
    // licence resolved to full.
    const store = fakeStore(cachedEntry());
    const outcome = await run(store, { entitled: false });

    expect(store.calls).toContain('clear');
    expect(store.entry).toBeNull();
    expect(outcome.state.reason).toBe('not_licensed');
    expect(outcome.state.status).toBe('shipped_defaults');
    expect(latest(store.published)?.reason).toBe('not_licensed');
  });

  it('writes nothing and never looks at the metadata', async () => {
    const store = fakeStore(cachedEntry());
    const outcome = await run(store, { entitled: false, metadata: 'garbage' });

    expect(store.calls).not.toContain('write');
    expect(outcome.written).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* No live answer                                                              */
/* -------------------------------------------------------------------------- */

describe('a run with no live answer', () => {
  it('leaves an existing cache alone and republishes it', async () => {
    // Publishing a failure here would report an outage twice — the licence state
    // already says it — and would overwrite the version the panel is showing.
    const entry = cachedEntry();
    const store = fakeStore(entry);
    const outcome = await run(store, { live: false, metadata: undefined });

    expect(store.calls).not.toContain('write');
    expect(store.calls).not.toContain('clear');
    expect(store.entry).toBe(entry);
    expect(outcome.state.status).toBe('calibrated');
    expect(outcome.state.source).toBe('cache');
    expect(outcome.state.calibrationVersion).toBe(12);
    expect(outcome.written).toBeNull();
  });

  it('publishes not_provisioned when there is no cache to fall back on', async () => {
    const store = fakeStore(null);
    const outcome = await run(store, { live: false, metadata: undefined });

    expect(outcome.state.reason).toBe('not_provisioned');
    expect(outcome.state.status).toBe('shipped_defaults');
    expect(store.published).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* The happy path                                                              */
/* -------------------------------------------------------------------------- */

describe('a verified payload', () => {
  it('writes a cache entry carrying the tag the seal port produced', async () => {
    const store = fakeStore(null);
    const outcome = await run(store);

    expect(store.written).toHaveLength(1);
    expect(store.written[0]?.sealTag).toBe('ZmFrZS1zZWFsLXRhZw==');
    expect(store.written[0]?.keyId).toBe(TEST_KEY_ID);
    expect(store.written[0]?.cachedAt).toBe(NOW.toISOString());
    expect(outcome.written).toEqual(store.written[0]);
  });

  it('publishes a calibrated state sourced live', async () => {
    const store = fakeStore(null);
    const outcome = await run(store);

    expect(outcome.state.status).toBe('calibrated');
    expect(outcome.state.source).toBe('live');
    expect(outcome.state.calibrationVersion).toBe(12);
    expect(outcome.state.cacheAgeMs).toBe(0);
    expect(latest(store.published)).toEqual(outcome.state);
  });

  it('reports which key verified it, without quoting the payload', async () => {
    const outcome = await run(fakeStore(null));

    expect(outcome.detail).toContain(TEST_KEY_ID);
    expect(outcome.detail).not.toContain(DISTINCTIVE_TITLE);
  });
});

/* -------------------------------------------------------------------------- */
/* No tag, no cache                                                            */
/* -------------------------------------------------------------------------- */

describe('a seal that cannot produce a tag', () => {
  it('writes nothing and publishes cache_unsealed', async () => {
    // An unsealed entry would either have to be accepted on read — defeating the
    // seal — or rejected, which is what not writing achieves with one fewer
    // shape in the store.
    const store = fakeStore(null);
    const outcome = await run(store, { seal: NEVER_SEALS });

    expect(store.calls).not.toContain('write');
    expect(store.entry).toBeNull();
    expect(outcome.written).toBeNull();
    expect(outcome.state.reason).toBe('cache_unsealed');
    expect(outcome.state.status).toBe('shipped_defaults');
  });

  it('behaves the same way when no seal is supplied at all', async () => {
    const store = fakeStore(null);
    const outcome = await refreshCalibration({
      store,
      metadata: signedMetadata(),
      live: true,
      entitled: true,
      now: NOW,
    });

    expect(store.calls).not.toContain('write');
    expect(outcome.state.reason).toBe('cache_unsealed');
  });
});

/* -------------------------------------------------------------------------- */
/* Bad payloads                                                                */
/* -------------------------------------------------------------------------- */

describe('a payload that does not verify', () => {
  const tampered = (): unknown => {
    const metadata = signedMetadata() as Record<string, Record<string, unknown>>;
    const envelope = metadata[CALIBRATION_METADATA_KEY] as Record<string, unknown>;

    return {
      [CALIBRATION_METADATA_KEY]: {
        ...envelope,
        payload: rawPayload({ decisionMakerTitles: ['ceo', 'intern'] }),
      },
    };
  };

  it('publishes signature_invalid and writes nothing', async () => {
    const store = fakeStore(cachedEntry());
    const outcome = await run(store, { metadata: tampered() });

    expect(outcome.state.reason).toBe('signature_invalid');
    expect(outcome.written).toBeNull();
    expect(store.calls).not.toContain('write');
  });

  it('does not clear the cache it already had', async () => {
    // A payload that arrives corrupted is evidence about *that response*, not
    // about the one verified last night. Discarding a good cache on the first
    // hiccup would let one bad night undo a working install.
    const entry = cachedEntry();
    const store = fakeStore(entry);

    await run(store, { metadata: tampered() });

    expect(store.calls).not.toContain('clear');
    expect(store.entry).toBe(entry);
  });

  it('publishes unknown_key for an envelope signed by a key this build lacks', async () => {
    const store = fakeStore(null);
    const outcome = await run(store, {
      metadata: signedMetadata(rawPayload(), 'greenlight-calibration-99'),
    });

    expect(outcome.state.reason).toBe('unknown_key');
    expect(store.calls).not.toContain('write');
  });

  it('publishes not_provisioned for metadata that carries no calibration key', async () => {
    const store = fakeStore(null);
    const outcome = await run(store, { metadata: { supportTier: 'gold' } });

    expect(outcome.state.reason).toBe('not_provisioned');
    expect(outcome.state.status).toBe('shipped_defaults');
    expect(latest(store.published)?.reason).toBe('not_provisioned');
  });

  it('publishes schema_unsupported for a payload from a future release', async () => {
    // All four of not_provisioned, signature_invalid, unknown_key and
    // schema_unsupported behave identically — shipped defaults — so the only
    // thing distinguishing them is how clearly they explain themselves.
    const store = fakeStore(null);
    const outcome = await run(store, {
      // Signed with nothing usable on purpose: a future schema is refused by the
      // parser before verification is ever reached.
      metadata: {
        [CALIBRATION_METADATA_KEY]: {
          alg: 'Ed25519',
          keyId: TEST_KEY_ID,
          signature: 'c2lnbmF0dXJl',
          payload: rawPayload({ schemaVersion: 2 }),
        },
      },
    });

    expect(outcome.state.reason).toBe('schema_unsupported');
    expect(store.calls).not.toContain('write');
  });
});

/* -------------------------------------------------------------------------- */
/* Storage is a convenience, never a dependency                                */
/* -------------------------------------------------------------------------- */

describe('a store whose every method throws', () => {
  it('still resolves with a state on the happy path', async () => {
    const outcome = await run(throwingStore());

    expect(outcome.state.status).toBe('calibrated');
    expect(outcome.state.source).toBe('live');
  });

  it('still resolves with a state when unentitled', async () => {
    const outcome = await run(throwingStore(), { entitled: false });

    expect(outcome.state.reason).toBe('not_licensed');
  });

  it('still resolves with a state when there is no live answer', async () => {
    const outcome = await run(throwingStore(), {
      live: false,
      metadata: undefined,
    });

    expect(outcome.state.reason).toBe('not_provisioned');
  });
});

/* -------------------------------------------------------------------------- */
/* The log line                                                                */
/* -------------------------------------------------------------------------- */

describe('describeCalibration', () => {
  it('summarises the run without any payload content', async () => {
    // A nightly cron that dumps a few hundred kilobytes of word lists into the
    // platform log stream would be indistinguishable from a bug.
    const outcome = await run(fakeStore(null));
    const described = describeCalibration(outcome);

    expect(JSON.stringify(described)).not.toContain(DISTINCTIVE_TITLE);
    expect(JSON.stringify(described)).not.toContain('projektleiter');
    expect(JSON.stringify(described)).not.toContain('zzbauvariantzz');
  });

  it('reports counts, status and version', async () => {
    const outcome = await run(fakeStore(null));

    expect(describeCalibration(outcome)).toMatchObject({
      calibrationStatus: 'calibrated',
      calibrationSource: 'live',
      calibrationVersion: 12,
      calibrationKeyId: TEST_KEY_ID,
      calibrationCounts: {
        decisionMakerTitles: 2,
        influencerTitles: 1,
        roleInboxLocalParts: 1,
        placeholderValues: 1,
        industrySynonyms: 1,
      },
    });
  });

  it('omits the counts entirely when nothing was written', async () => {
    const outcome = await run(fakeStore(null), { entitled: false });

    expect('calibrationCounts' in describeCalibration(outcome)).toBe(false);
  });
});
