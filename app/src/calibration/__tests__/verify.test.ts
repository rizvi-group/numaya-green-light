/**
 * Real Ed25519, not a stub.
 *
 * A test double for the signature check would assert that the code calls a
 * function, which is the one thing about this module that is not in doubt. So a
 * throwaway keypair is generated here with `node:crypto`, the canonical form is
 * signed with it, and the embedded key table is pointed at the public half for
 * the duration of the file. What is being asserted is that a signature produced
 * outside this module verifies inside it — and, more importantly, exactly which
 * mutations break it.
 *
 * The keypair is generated per run and never written down. There is no key
 * material in this file.
 */

import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { canonicalBytes } from 'src/calibration/canonical';
import { CALIBRATION_PUBLIC_KEYS } from 'src/calibration/keys';
import {
  type Calibration,
  type SignedCalibrationEnvelope,
} from 'src/calibration/types';
import { verifyCalibrationEnvelope } from 'src/calibration/verify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_KEY_ID = 'greenlight-calibration-test';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

/** The raw 32 bytes, which is the shape `keys.ts` documents for the table. */
const rawPublicKey = publicKey
  .export({ format: 'der', type: 'spki' })
  .subarray(-32);

const keyTable = CALIBRATION_PUBLIC_KEYS as Record<string, string>;

beforeAll(() => {
  keyTable[TEST_KEY_ID] = rawPublicKey.toString('base64');
});

afterAll(() => {
  delete keyTable[TEST_KEY_ID];
});

afterEach(() => {
  vi.restoreAllMocks();
});

const calibration = (overrides: Partial<Calibration> = {}): Calibration => ({
  schemaVersion: 1,
  calibrationVersion: 7,
  issuedAt: '2026-08-01T00:00:00.000Z',
  notes: null,
  decisionMakerTitles: ['geschäftsführer', 'sócio', 'ceo'],
  influencerTitles: ['projektleiter'],
  roleInboxLocalParts: ['kontakt'],
  placeholderValues: ['n/a'],
  industrySynonyms: { construction: ['bau', 'bauwesen'] },
  ...overrides,
});

const signPayload = (payload: unknown): string => {
  const message = canonicalBytes(payload);

  if (message === null) {
    throw new Error('fixture payload could not be canonicalised');
  }

  return nodeSign(null, message, privateKey).toString('base64');
};

const envelope = (
  payload: Calibration,
  overrides: Partial<SignedCalibrationEnvelope> = {},
): SignedCalibrationEnvelope => ({
  alg: 'Ed25519',
  keyId: TEST_KEY_ID,
  signature: signPayload(payload),
  payload,
  ...overrides,
});

describe('verifyCalibrationEnvelope — the happy path', () => {
  it('verifies a correctly signed envelope', async () => {
    const payload = calibration();
    const result = await verifyCalibrationEnvelope(envelope(payload));

    expect(result.kind).toBe('verified');
    expect(result.kind === 'verified' && result.calibration).toBe(payload);
  });
});

describe('verifyCalibrationEnvelope — mutations that must break it', () => {
  it('rejects a payload mutated after signing', async () => {
    const payload = calibration();
    const signed = envelope(payload);

    const result = await verifyCalibrationEnvelope({
      ...signed,
      payload: { ...payload, decisionMakerTitles: ['ceo', 'intern'] },
    });

    expect(result.kind).toBe('rejected');
    expect(result.kind === 'rejected' && result.reason).toBe('signature_invalid');
  });

  it('rejects a bumped calibrationVersion', async () => {
    const payload = calibration();
    const signed = envelope(payload);

    const result = await verifyCalibrationEnvelope({
      ...signed,
      payload: { ...payload, calibrationVersion: 8 },
    });

    expect(result.kind === 'rejected' && result.reason).toBe('signature_invalid');
  });

  it('rejects a reordered array inside the payload', async () => {
    // Array order is meaning — first match wins in the rules — so a reordered
    // list has to be a different payload as far as the signature is concerned.
    const payload = calibration({ decisionMakerTitles: ['a', 'b', 'c'] });
    const signed = envelope(payload);

    const result = await verifyCalibrationEnvelope({
      ...signed,
      payload: { ...payload, decisionMakerTitles: ['c', 'b', 'a'] },
    });

    expect(result.kind === 'rejected' && result.reason).toBe('signature_invalid');
  });
});

describe('verifyCalibrationEnvelope — the property the canonicaliser exists for', () => {
  it('accepts a payload whose object keys were inserted in a different order', async () => {
    // The payload round-trips through the licensing service's JSON storage,
    // which is entitled to reorder keys. If this test fails, every calibration
    // in the field stops verifying the first time that service re-serialises.
    const first: Record<string, unknown> = {};
    first['schemaVersion'] = 1;
    first['calibrationVersion'] = 7;
    first['issuedAt'] = '2026-08-01T00:00:00.000Z';
    first['notes'] = null;
    first['decisionMakerTitles'] = ['ceo'];
    first['influencerTitles'] = ['manager'];
    first['roleInboxLocalParts'] = ['info'];
    first['placeholderValues'] = ['n/a'];
    first['industrySynonyms'] = { construction: ['bau'], software: ['saas'] };

    const second: Record<string, unknown> = {};
    second['industrySynonyms'] = { software: ['saas'], construction: ['bau'] };
    second['placeholderValues'] = ['n/a'];
    second['roleInboxLocalParts'] = ['info'];
    second['influencerTitles'] = ['manager'];
    second['decisionMakerTitles'] = ['ceo'];
    second['notes'] = null;
    second['issuedAt'] = '2026-08-01T00:00:00.000Z';
    second['calibrationVersion'] = 7;
    second['schemaVersion'] = 1;

    const result = await verifyCalibrationEnvelope({
      alg: 'Ed25519',
      keyId: TEST_KEY_ID,
      signature: signPayload(first),
      payload: second as unknown as Calibration,
    });

    expect(result.kind).toBe('verified');
  });
});

describe('verifyCalibrationEnvelope — refusals before any crypto runs', () => {
  it('refuses an unknown keyId', async () => {
    const result = await verifyCalibrationEnvelope(
      envelope(calibration(), { keyId: 'greenlight-calibration-99' }),
    );

    expect(result.kind === 'rejected' && result.reason).toBe('unknown_key');
  });

  it('refuses an unknown keyId without verifying against a key the envelope supplies', async () => {
    // The alternative — trusting a key that travelled with the payload — would
    // verify only that the payload signed itself. The table is the trust anchor,
    // so an unknown id must not reach the verifier at all.
    const importKey = vi.spyOn(globalThis.crypto.subtle, 'importKey');
    const verify = vi.spyOn(globalThis.crypto.subtle, 'verify');

    const payload = calibration();
    const result = await verifyCalibrationEnvelope({
      alg: 'Ed25519',
      keyId: 'attacker-supplied',
      signature: signPayload(payload),
      payload,
      // A key id that is not in the table, offered alongside the key material
      // an attacker would like us to use.
      ...({ publicKey: rawPublicKey.toString('base64') } as object),
    });

    expect(result.kind === 'rejected' && result.reason).toBe('unknown_key');
    expect(importKey).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it('refuses any algorithm other than Ed25519', async () => {
    for (const alg of ['ed25519', 'RS256', 'HS256', 'none', '']) {
      const result = await verifyCalibrationEnvelope(
        envelope(calibration(), { alg }),
      );

      expect(result.kind === 'rejected' && result.reason, alg).toBe('unsigned');
    }
  });

  it('refuses a signature that is not valid base64', async () => {
    const result = await verifyCalibrationEnvelope(
      envelope(calibration(), { signature: 'not base64 !!!' }),
    );

    expect(result.kind === 'rejected' && result.reason).toBe('signature_invalid');
  });

  it('refuses a signature that decodes to the wrong number of bytes', async () => {
    for (const bytes of [10, 63, 65]) {
      const result = await verifyCalibrationEnvelope(
        envelope(calibration(), {
          signature: Buffer.alloc(bytes, 1).toString('base64'),
        }),
      );

      expect(result.kind === 'rejected' && result.reason, `${bytes} bytes`).toBe(
        'signature_invalid',
      );
    }
  });

  it('refuses an empty signature', async () => {
    const result = await verifyCalibrationEnvelope(
      envelope(calibration(), { signature: '' }),
    );

    expect(result.kind === 'rejected' && result.reason).toBe('signature_invalid');
  });
});

describe('verifyCalibrationEnvelope — degradation, never an exception', () => {
  it('reports a runtime whose Ed25519 support throws as verifier_unavailable', async () => {
    vi.spyOn(globalThis.crypto.subtle, 'importKey').mockRejectedValue(
      new Error('Unrecognized algorithm name'),
    );

    const result = await verifyCalibrationEnvelope(envelope(calibration()));

    expect(result.kind === 'rejected' && result.reason).toBe(
      'verifier_unavailable',
    );
  });

  it('reports an embedded key of the wrong length as a build defect, not a bad payload', async () => {
    keyTable['greenlight-calibration-short'] = Buffer.alloc(16, 7).toString(
      'base64',
    );

    const result = await verifyCalibrationEnvelope(
      envelope(calibration(), { keyId: 'greenlight-calibration-short' }),
    );

    delete keyTable['greenlight-calibration-short'];

    expect(result.kind === 'rejected' && result.reason).toBe(
      'verifier_unavailable',
    );
  });
});
