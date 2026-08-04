#!/usr/bin/env node
/**
 * Sign, publish and provision the Greenlight calibration pack.
 *
 * ===========================================================================
 * This is Numaya-side tooling. It is **not** shipped to customers, it is not
 * part of the app bundle, and it needs credentials no customer has: the
 * calibration signing key and a management API key. Both are read from the
 * team's 1Password vault at run time via the `op` CLI, and neither is ever
 * written to disk or printed.
 *
 * ## Configuration
 *
 * The vault and item names are deployment detail, not product knowledge, so
 * this repository — which is public — does not carry them. Supply them as
 * environment variables; every command fails fast if one is missing:
 *
 *   GREENLIGHT_OP_VAULT              1Password vault holding both items
 *   GREENLIGHT_OP_SIGNING_ITEM       item holding the Ed25519 `private_key`
 *   GREENLIGHT_OP_MANAGEMENT_ITEM    item holding the management `credential`
 *   GREENLIGHT_LICENCE_CUSTOMER_EMAIL  customer email stamped on `issue`
 *
 * Operators: the values are recorded in the internal operations notes.
 *
 * ## Why the payload is not in git
 *
 * The calibration pack *is* the thing a licence buys. This repository is going
 * public, so committing `greenlight-calibration-v1.json` would hand it to the
 * first fork that clones. `.gitignore` excludes it, and the system of record is
 * the licensing service's own versioned config store — which is exactly what
 * that surface is for, and which gives version history and rollback for free.
 *
 * Retrieve the current pack with:
 *   node ops/calibration/publish.mjs fetch
 *
 * ## Why signing happens here and not on the service
 *
 * The licensing service has no endpoint that will sign an arbitrary payload —
 * its Ed25519 keypair signs offline licence files and nothing else, and its
 * config download response carries no signature field at all. So Greenlight
 * signs its own calibration with its own key, whose public half is embedded in
 * `app/src/calibration/keys.ts`. See that file for the full argument and the
 * measurements behind it.
 *
 * The canonicalisation used to produce the signed bytes is imported directly
 * from `app/src/calibration/canonical.ts` — the same module the in-app verifier
 * uses. There is deliberately no second implementation: a signer and a verifier
 * that disagree by one byte produce a signature that never validates and an
 * afternoon of confusion.
 *
 * ## Commands
 *
 *   sign      payload JSON            -> signed envelope JSON
 *   verify    signed envelope         -> checks it against the embedded key
 *   upload    signed envelope         -> POST product configs (new version)
 *   fetch                             -> GET the latest published config
 *   issue     <customer name>         -> mint a sandbox licence carrying the pack
 *   schema                            -> register the product's ConfigSchema
 *
 * Every command is sandbox-only. The production product id is not referenced
 * anywhere in this file, on purpose.
 * ===========================================================================
 */

import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalise } from '../../app/src/calibration/canonical.ts';
import {
  CALIBRATION_PUBLIC_KEYS,
  CALIBRATION_SIGNATURE_ALGORITHM,
  CALIBRATION_SIGNING_KEY_ID,
} from '../../app/src/calibration/keys.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

const BASE_URL = 'https://licensing.rizvigoc.com';

/** Sandbox only. The production product id is deliberately absent. */
const SANDBOX_PRODUCT_ID = 'b85e8f2c-b436-4cfe-bca6-eec6e7152b50';

/**
 * Read a required environment variable, or fail with a message that names it.
 *
 * Deliberately not defaulted. A wrong-but-plausible default would send `op`
 * looking in the wrong vault and produce a "not found" that reads like a
 * missing secret rather than like a missing setting.
 */
const env = (name) => {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      `${name} is not set. See the "Configuration" note at the top of this file.`,
    );
  }
  return value;
};

const OP_SIGNING_ITEM = () => env('GREENLIGHT_OP_SIGNING_ITEM');
const OP_MANAGEMENT_ITEM = () => env('GREENLIGHT_OP_MANAGEMENT_ITEM');
const OP_VAULT = () => env('GREENLIGHT_OP_VAULT');

const PAYLOAD_PATH = resolve(HERE, 'greenlight-calibration-v1.json');
const ENVELOPE_PATH = resolve(HERE, 'greenlight-calibration-v1.signed.json');

/* -------------------------------------------------------------------------- */
/* Credentials                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read a field from 1Password.
 *
 * `execFileSync` rather than a shell string so a value containing shell
 * metacharacters can never be re-interpreted, and so the secret is never part
 * of a command line that `ps` could show.
 */
const op = (item, field) => {
  const raw = execFileSync(
    'op',
    ['item', 'get', item, '--vault', OP_VAULT(), '--fields', field, '--reveal'],
    { encoding: 'utf8' },
  ).trim();

  // `op` wraps any value containing a newline in double quotes, which a PEM
  // always does. Stripping them here rather than at each call site means a
  // future single-line field does not accidentally grow a quote-stripping step
  // it does not need.
  return raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
};

const signingKey = () => createPrivateKey(op(OP_SIGNING_ITEM(), 'private_key'));

const managementKey = () => op(OP_MANAGEMENT_ITEM(), 'credential');

/**
 * Every management request carries `X-Numaya-Environment: sandbox`.
 *
 * Without it a live sandbox key returns a plausible `200 license_not_found`
 * against production data — a failure that looks like a missing record rather
 * than like a misrouted request, which is the most expensive kind.
 */
const api = async (method, path, body) => {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${managementKey()}`,
      'x-numaya-environment': 'sandbox',
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await response.text();
  let parsed = null;

  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text.slice(0, 400) };
  }

  return { status: response.status, body: parsed };
};

/* -------------------------------------------------------------------------- */
/* Commands                                                                    */
/* -------------------------------------------------------------------------- */

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const doSign = () => {
  const payload = readJson(PAYLOAD_PATH);
  const message = canonicalise(payload);

  if (message === null) {
    throw new Error('payload could not be canonicalised');
  }

  const signature = sign(null, Buffer.from(message, 'utf8'), signingKey());

  const envelope = {
    alg: CALIBRATION_SIGNATURE_ALGORITHM,
    keyId: CALIBRATION_SIGNING_KEY_ID,
    signature: signature.toString('base64'),
    payload,
  };

  writeFileSync(ENVELOPE_PATH, `${JSON.stringify(envelope, null, 2)}\n`);

  console.log(
    `signed calibration v${payload.calibrationVersion} with ${CALIBRATION_SIGNING_KEY_ID}`,
  );
  console.log(`  canonical bytes : ${Buffer.byteLength(message, 'utf8')}`);
  console.log(`  envelope bytes  : ${JSON.stringify(envelope).length}`);
  console.log(`  written to      : ${ENVELOPE_PATH}`);
};

/**
 * Verify with the *embedded public key*, not with the private key we just used.
 *
 * Signing and then verifying with the same key object would only prove the
 * crypto library is self-consistent. Verifying against the bytes that ship in
 * `keys.ts` is the check that actually matters: it is the exact operation a
 * customer's workspace will perform, and it fails if the table in `keys.ts` and
 * the key in 1Password have drifted apart.
 */
const doVerify = () => {
  const envelope = readJson(ENVELOPE_PATH);
  const publicKeyBase64 = CALIBRATION_PUBLIC_KEYS[envelope.keyId];

  if (publicKeyBase64 === undefined) {
    throw new Error(`no embedded public key for keyId "${envelope.keyId}"`);
  }

  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(publicKeyBase64, 'base64'),
    ]),
    format: 'der',
    type: 'spki',
  });

  const message = canonicalise(envelope.payload);
  const ok = verify(
    null,
    Buffer.from(message, 'utf8'),
    publicKey,
    Buffer.from(envelope.signature, 'base64'),
  );

  console.log(`verify against embedded ${envelope.keyId}: ${ok}`);

  if (!ok) {
    process.exitCode = 1;
  }

  // A round trip through JSON.parse must not change the canonical bytes — that
  // is the property the whole design rests on, because the payload goes through
  // the licensing service's own serialiser before a customer ever sees it.
  const roundTripped = canonicalise(JSON.parse(JSON.stringify(envelope.payload)));

  console.log(`canonical form survives a JSON round trip: ${roundTripped === message}`);

  if (roundTripped !== message) {
    process.exitCode = 1;
  }
};

/**
 * Register the product's ConfigSchema.
 *
 * The upload endpoint validates a blob against this before storing it, and the
 * product had none — `GET /v1/orgs/current/products/{id}` returned no
 * `configSchema` key at all, despite the published schema marking it required.
 * Registering one turns "we uploaded something" into "the service refuses a blob
 * that is not a signed calibration envelope", which is worth having for a
 * surface that is going to be written to by future tooling.
 */
const doSchema = async () => {
  const configSchema = {
    type: 'object',
    required: ['alg', 'keyId', 'signature', 'payload'],
    additionalProperties: false,
    properties: {
      alg: { type: 'string', enum: ['Ed25519'] },
      keyId: { type: 'string', minLength: 1 },
      signature: { type: 'string', minLength: 1 },
      payload: {
        type: 'object',
        required: ['schemaVersion', 'calibrationVersion', 'issuedAt'],
        properties: {
          schemaVersion: { type: 'integer', minimum: 1 },
          calibrationVersion: { type: 'integer', minimum: 1 },
          issuedAt: { type: 'string' },
          notes: { type: ['string', 'null'] },
          decisionMakerTitles: { type: 'array', items: { type: 'string' } },
          influencerTitles: { type: 'array', items: { type: 'string' } },
          roleInboxLocalParts: { type: 'array', items: { type: 'string' } },
          placeholderValues: { type: 'array', items: { type: 'string' } },
          industrySynonyms: {
            type: 'object',
            additionalProperties: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  };

  const result = await api('PUT', `/v1/orgs/current/products/${SANDBOX_PRODUCT_ID}`, {
    configSchema,
  });

  console.log(`schema PUT -> ${result.status}`);
  console.log(JSON.stringify(result.body, null, 2).slice(0, 1200));
};

const doUpload = async () => {
  const envelope = readJson(ENVELOPE_PATH);
  const result = await api(
    'POST',
    `/v1/orgs/current/products/${SANDBOX_PRODUCT_ID}/configs`,
    { configBlob: envelope },
  );

  console.log(`upload -> ${result.status}`);

  if (result.body !== null && typeof result.body === 'object') {
    const { version, isLatest, environment, createdAt } = result.body;
    console.log({ version, isLatest, environment, createdAt });
  }

  if (result.status >= 400) {
    console.log(JSON.stringify(result.body, null, 2).slice(0, 1500));
    process.exitCode = 1;
  }
};

const doFetch = async () => {
  const result = await api(
    'GET',
    `/v1/orgs/current/products/${SANDBOX_PRODUCT_ID}/configs/latest`,
  );

  console.log(`fetch -> ${result.status}`);

  if (result.status !== 200) {
    console.log(JSON.stringify(result.body, null, 2).slice(0, 800));
    process.exitCode = 1;
    return;
  }

  const blob = result.body.configBlob;

  writeFileSync(ENVELOPE_PATH, `${JSON.stringify(blob, null, 2)}\n`);
  writeFileSync(PAYLOAD_PATH, `${JSON.stringify(blob.payload, null, 2)}\n`);

  console.log(
    `version ${result.body.version}, calibration v${blob.payload.calibrationVersion}, written to ${ENVELOPE_PATH}`,
  );
};

/**
 * Mint a sandbox licence carrying the pack in `customerMetadata`.
 *
 * This is the delivery step, and it is here rather than in the app because the
 * app can never do it: the licensing service's two config-download endpoints
 * refuse licence-key credentials by design, so a shipped-to-customer product
 * cannot fetch its own config. `customerMetadata` is the one org-authored field
 * that comes back on a plain `validate` call, which the app already makes.
 *
 * **`customerMetadata` is write-once.** There is no update endpoint for it on
 * either API, so moving a customer to a new calibration version means issuing a
 * new licence. See the report accompanying this change — this is the single
 * biggest limitation of the current design and it is the service's to fix.
 */
const doIssue = async (customerName) => {
  if (typeof customerName !== 'string' || customerName.trim().length === 0) {
    throw new Error('usage: publish.mjs issue "<customer name>"');
  }

  const envelope = readJson(ENVELOPE_PATH);

  const result = await api('POST', '/v1/orgs/current/licenses/direct', {
    productId: SANDBOX_PRODUCT_ID,
    type: 'Subscription',
    maxActivations: 1,
    allowedFeatures: ['rules', 'enrichment'],
    expiryDays: 30,
    requireKey: true,
    customerEmail: env('GREENLIGHT_LICENCE_CUSTOMER_EMAIL'),
    customerName,
    customerMetadata: { greenlightCalibration: envelope },
    tier: 'Pro',
  });

  console.log(`issue -> ${result.status}`);

  if (result.status >= 400) {
    console.log(JSON.stringify(result.body, null, 2).slice(0, 1500));
    process.exitCode = 1;
    return;
  }

  // The key is printed once, here, and nowhere else. It is a sandbox key and it
  // must still never reach a file in this repository.
  console.log(`licenceId : ${result.body.id}`);
  console.log(`key       : ${result.body.key}`);
  console.log(`calibration v${envelope.payload.calibrationVersion} attached`);
};

/* -------------------------------------------------------------------------- */

const [command, ...args] = process.argv.slice(2);

const commands = {
  sign: doSign,
  verify: doVerify,
  schema: doSchema,
  upload: doUpload,
  fetch: doFetch,
  issue: () => doIssue(args[0]),
};

const run = commands[command];

if (run === undefined) {
  console.error(`usage: publish.mjs <${Object.keys(commands).join('|')}>`);
  process.exit(2);
}

await run();
