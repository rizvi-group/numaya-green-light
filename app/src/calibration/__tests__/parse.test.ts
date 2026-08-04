/**
 * Reading an envelope out of `customerMetadata`.
 *
 * The input crossed a network and was re-serialised by a service we do not
 * deploy in lockstep with this app, so the property under test throughout is
 * that *nothing* here throws and every bad shape lands on a named reason an
 * admin can read.
 */

import {
  CALIBRATION_METADATA_KEY,
  readCalibrationEnvelope,
  type EnvelopeRead,
} from 'src/calibration/parse';
import { describe, expect, it } from 'vitest';

const wrap = (envelope: unknown): unknown => ({
  [CALIBRATION_METADATA_KEY]: envelope,
});

const signedEnvelope = (payload: unknown): unknown =>
  wrap({
    alg: 'Ed25519',
    keyId: 'greenlight-calibration-1',
    signature: 'c2lnbmF0dXJl',
    payload,
  });

const payload = (overrides: Record<string, unknown> = {}): unknown => ({
  schemaVersion: 1,
  calibrationVersion: 4,
  issuedAt: '2026-08-01T00:00:00.000Z',
  notes: 'a note',
  ...overrides,
});

const rejection = (read: EnvelopeRead): { reason: string; detail: string } => {
  if (read.kind !== 'rejected') {
    throw new Error(`expected a rejection, received ${read.kind}`);
  }

  return { reason: read.reason, detail: read.detail };
};

const parsed = (raw: Record<string, unknown>): Record<string, unknown> => {
  const read = readCalibrationEnvelope(signedEnvelope(payload(raw)));

  if (read.kind !== 'envelope') {
    throw new Error(`expected an envelope, received ${read.detail}`);
  }

  return read.envelope.payload as unknown as Record<string, unknown>;
};

/* -------------------------------------------------------------------------- */
/* Not provisioned is the normal state, not a fault                            */
/* -------------------------------------------------------------------------- */

describe('a licence with no calibration', () => {
  it.each([
    ['absent metadata', undefined],
    ['null metadata', null],
    ['metadata that is not an object', 'greenlight'],
    ['metadata that is an array', []],
  ])('reports %s as not_provisioned', (_label, metadata) => {
    expect(rejection(readCalibrationEnvelope(metadata)).reason).toBe(
      'not_provisioned',
    );
  });

  it.each([
    ['no greenlightCalibration key', { otherVendor: { thing: 1 } }],
    ['an explicitly null entry', { [CALIBRATION_METADATA_KEY]: null }],
  ])('reports %s as not_provisioned', (_label, metadata) => {
    // Every licence issued before calibration existed lands here, so this has to
    // read as "nothing to do" rather than as a fault in the admin panel.
    expect(rejection(readCalibrationEnvelope(metadata)).reason).toBe(
      'not_provisioned',
    );
  });

  it('ignores unrelated sibling keys in the metadata bag', () => {
    const read = readCalibrationEnvelope({
      supportTier: 'gold',
      customerReference: 'ACME-1',
      ...(signedEnvelope(payload()) as object),
    });

    expect(read.kind).toBe('envelope');
  });
});

/* -------------------------------------------------------------------------- */
/* Unsigned                                                                    */
/* -------------------------------------------------------------------------- */

describe('an envelope with no usable signature fields', () => {
  const complete = {
    alg: 'Ed25519',
    keyId: 'greenlight-calibration-1',
    signature: 'c2lnbmF0dXJl',
    payload: payload(),
  };

  it.each(['signature', 'keyId', 'alg'])('reports a missing %s as unsigned', (field) => {
    const envelope: Record<string, unknown> = { ...complete };
    delete envelope[field];

    expect(rejection(readCalibrationEnvelope(wrap(envelope))).reason).toBe(
      'unsigned',
    );
  });

  it.each(['signature', 'keyId', 'alg'])('reports an empty %s as unsigned', (field) => {
    expect(
      rejection(readCalibrationEnvelope(wrap({ ...complete, [field]: '' })))
        .reason,
    ).toBe('unsigned');
  });

  it.each(['signature', 'keyId', 'alg'])(
    'reports a non-string %s as unsigned',
    (field) => {
      expect(
        rejection(readCalibrationEnvelope(wrap({ ...complete, [field]: 42 })))
          .reason,
      ).toBe('unsigned');
    },
  );
});

/* -------------------------------------------------------------------------- */
/* Malformed                                                                   */
/* -------------------------------------------------------------------------- */

describe('a malformed envelope', () => {
  it('reports an envelope that is not an object as malformed', () => {
    expect(rejection(readCalibrationEnvelope(wrap('nope'))).reason).toBe(
      'malformed',
    );
  });

  it.each([
    ['a string', 'not-a-payload'],
    ['an array', []],
    ['a number', 7],
  ])('reports a payload that is %s as malformed', (_label, body) => {
    expect(rejection(readCalibrationEnvelope(signedEnvelope(body))).reason).toBe(
      'malformed',
    );
  });

  it('reports an absent payload as malformed', () => {
    expect(
      rejection(
        readCalibrationEnvelope(
          wrap({
            alg: 'Ed25519',
            keyId: 'greenlight-calibration-1',
            signature: 'c2lnbmF0dXJl',
          }),
        ),
      ).reason,
    ).toBe('malformed');
  });

  it.each(['schemaVersion', 'calibrationVersion'])(
    'reports a payload missing %s as malformed',
    (field) => {
      const body: Record<string, unknown> = {
        schemaVersion: 1,
        calibrationVersion: 4,
      };
      delete body[field];

      const read = readCalibrationEnvelope(signedEnvelope(body));

      expect(rejection(read).reason).toBe('malformed');
      expect(rejection(read).detail).toContain(field);
    },
  );

  it.each([
    ['a string', '1'],
    ['a float', 1.5],
    ['negative', -1],
  ])('reports a schemaVersion that is %s as malformed', (_label, schemaVersion) => {
    expect(
      rejection(
        readCalibrationEnvelope(signedEnvelope(payload({ schemaVersion }))),
      ).reason,
    ).toBe('malformed');
  });
});

/* -------------------------------------------------------------------------- */
/* Schema version                                                              */
/* -------------------------------------------------------------------------- */

describe('a payload from a future release', () => {
  it('reports schemaVersion 2 as schema_unsupported and names both versions', () => {
    // The reason is checked after parsing rather than before, so the detail can
    // say what actually arrived rather than the generic "malformed" a truncated
    // blob would produce.
    const read = readCalibrationEnvelope(
      signedEnvelope(payload({ schemaVersion: 2 })),
    );

    expect(rejection(read).reason).toBe('schema_unsupported');
    expect(rejection(read).detail).toContain('2');
    expect(rejection(read).detail).toContain('1');
  });

  it('reports schemaVersion 0 as schema_unsupported too', () => {
    expect(
      rejection(
        readCalibrationEnvelope(signedEnvelope(payload({ schemaVersion: 0 }))),
      ).reason,
    ).toBe('schema_unsupported');
  });
});

/* -------------------------------------------------------------------------- */
/* List normalisation                                                          */
/* -------------------------------------------------------------------------- */

describe('list normalisation', () => {
  it('lower-cases, trims, collapses internal whitespace and de-duplicates', () => {
    expect(
      parsed({ decisionMakerTitles: ['CEO', ' ceo ', 'Head  Of'] }),
    ).toMatchObject({ decisionMakerTitles: ['ceo', 'head of'] });
  });

  it('drops non-string entries without failing the whole calibration', () => {
    // One bad entry in a list of two hundred should cost that entry, not the
    // pack.
    expect(
      parsed({ influencerTitles: ['manager', 42, null, {}, ['lead'], 'buyer'] }),
    ).toMatchObject({ influencerTitles: ['manager', 'buyer'] });
  });

  it('drops entries that normalise to nothing', () => {
    expect(parsed({ placeholderValues: ['   ', '', 'n/a'] })).toMatchObject({
      placeholderValues: ['n/a'],
    });
  });

  it.each([
    'decisionMakerTitles',
    'influencerTitles',
    'roleInboxLocalParts',
    'placeholderValues',
  ])('treats a %s that is present but not an array as fatal', (field) => {
    expect(
      rejection(
        readCalibrationEnvelope(signedEnvelope(payload({ [field]: 'ceo' }))),
      ).reason,
    ).toBe('malformed');
  });

  it('treats an industrySynonyms that is not an object as fatal', () => {
    expect(
      rejection(
        readCalibrationEnvelope(
          signedEnvelope(payload({ industrySynonyms: ['construction'] })),
        ),
      ).reason,
    ).toBe('malformed');
  });

  it('accepts an absent list and yields an empty one', () => {
    expect(parsed({})).toMatchObject({
      decisionMakerTitles: [],
      influencerTitles: [],
      roleInboxLocalParts: [],
      placeholderValues: [],
      industrySynonyms: {},
    });
  });

  it('accepts an explicitly empty list', () => {
    expect(parsed({ decisionMakerTitles: [] })).toMatchObject({
      decisionMakerTitles: [],
    });
  });

  it('defaults issuedAt to an empty string and notes to null', () => {
    expect(parsed({ issuedAt: 42, notes: 7 })).toMatchObject({
      issuedAt: '',
      notes: null,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The synonym taxonomy                                                        */
/* -------------------------------------------------------------------------- */

describe('industrySynonyms', () => {
  it('normalises canonicals and variants alike', () => {
    expect(
      parsed({ industrySynonyms: { ' Construction ': ['Bau', 'BAUWESEN '] } }),
    ).toMatchObject({ industrySynonyms: { construction: ['bau', 'bauwesen'] } });
  });

  it.each([
    ['an empty variant list', []],
    ['a variant list of only junk', [1, null, {}]],
    ['a variant list of only blanks', ['  ', '']],
    ['a variant list that is not an array', 'bau'],
  ])('drops a canonical whose variants are %s', (_label, variants) => {
    // An empty cluster would expand a workspace's ICP by nothing while still
    // counting as a synonym in the admin panel.
    expect(
      parsed({ industrySynonyms: { construction: variants, software: ['saas'] } }),
    ).toMatchObject({ industrySynonyms: { software: ['saas'] } });
  });

  it('drops a canonical whose key normalises to nothing', () => {
    expect(
      parsed({ industrySynonyms: { '   ': ['bau'], software: ['saas'] } }),
    ).toMatchObject({ industrySynonyms: { software: ['saas'] } });
  });

  it('removes the canonical from its own variant list', () => {
    // It is already matched directly, and letting it in would double-count in
    // the admin panel's summary.
    expect(
      parsed({
        industrySynonyms: { construction: ['Construction', 'bau'] },
      }),
    ).toMatchObject({ industrySynonyms: { construction: ['bau'] } });
  });

  it('drops a canonical whose only variant was itself', () => {
    // The self-reference is stripped before the emptiness check, so a cluster
    // that says nothing beyond "construction means construction" is dropped
    // rather than kept empty. It would expand a workspace's ICP by nothing
    // while still counting as one synonym in the admin panel, which is the one
    // thing the emptiness filter exists to prevent.
    //
    // This previously survived as `{ construction: [] }` because the two checks
    // ran in the other order.
    expect(
      parsed({ industrySynonyms: { construction: ['CONSTRUCTION'] } })
        .industrySynonyms,
    ).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* The whole envelope                                                          */
/* -------------------------------------------------------------------------- */

describe('a well-formed envelope', () => {
  it('carries the signature fields through untouched', () => {
    const read = readCalibrationEnvelope(signedEnvelope(payload()));

    expect(read.kind).toBe('envelope');
    expect(read.kind === 'envelope' && read.envelope.alg).toBe('Ed25519');
    expect(read.kind === 'envelope' && read.envelope.keyId).toBe(
      'greenlight-calibration-1',
    );
    expect(read.kind === 'envelope' && read.envelope.signature).toBe(
      'c2lnbmF0dXJl',
    );
  });
});
