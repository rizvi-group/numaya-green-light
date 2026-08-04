/**
 * Prove that a real `app:install` ran Greenlight's post-install hook.
 *
 * `app:install` exiting 0 only means the server accepted the package. The hook
 * itself runs asynchronously, with retries, so the only honest evidence is its
 * side effects: the seeded `greenlightConfig` record and the audit row the hook
 * writes alongside it. This polls for both and fails the job if they never
 * appear — which is what stops this workflow from being green while doing
 * nothing.
 *
 * Reads TWENTY_API_URL and TWENTY_API_KEY from the environment. Never prints
 * the key.
 */
const API_URL = process.env.TWENTY_API_URL;
const API_KEY = process.env.TWENTY_API_KEY;

if (!API_URL || !API_KEY) {
  console.error('TWENTY_API_URL and TWENTY_API_KEY must both be set.');
  process.exit(1);
}

const TIMEOUT_MS = 180_000;
const INTERVAL_MS = 3_000;

const query = async (body) => {
  const response = await fetch(`${API_URL}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${API_KEY}`,
      // No keep-alive: this script polls, then wants the process to end.
      connection: 'close',
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return { errors: [{ message: `HTTP ${response.status}: ${text.slice(0, 200)}` }] };
  }
};

const readConfigs = async () => {
  const result = await query({
    query: `query { greenlightConfigs(first: 10) { edges { node { id gateThreshold } } } }`,
  });

  // Before the app's metadata lands the field does not exist on the schema at
  // all, which is a GraphQL error rather than an empty result. That is a
  // "not yet", not a failure.
  return result.data?.greenlightConfigs?.edges?.map((edge) => edge.node) ?? null;
};

// Filtered server-side rather than paged and matched here: the same install
// also kicks off a backfill, and that writes hundreds of audit rows within
// seconds, so the seed row falls out of any reasonable first-N window.
const readSeedAuditRows = async () => {
  const result = await query({
    query: `query { greenlightAuditLogs(first: 5, filter: { name: { ilike: "%configuration seeded%" } }) { edges { node { name createdAt } } } }`,
  });

  return result.data?.greenlightAuditLogs?.edges?.map((edge) => edge.node) ?? null;
};

const startedAt = Date.now();
let lastSeen = 'nothing yet';

while (Date.now() - startedAt < TIMEOUT_MS) {
  const configs = await readConfigs();

  if (configs === null) {
    lastSeen = 'the greenlightConfig object is not on the schema yet';
  } else if (configs.length === 0) {
    lastSeen = 'the greenlightConfig object exists but the hook has seeded no record';
  } else {
    const auditRows = await readSeedAuditRows();

    if (auditRows !== null && auditRows.length > 0) {
      console.log(
        `post-install hook confirmed: ${configs.length} greenlightConfig record(s), ` +
          `gateThreshold=${configs[0].gateThreshold}, audit row "${auditRows[0].name}"`,
      );
      process.exitCode = 0;
      break;
    }

    lastSeen = `${configs.length} config record(s) but no "configuration seeded" audit row yet`;
  }

  if (Date.now() - startedAt >= TIMEOUT_MS - INTERVAL_MS) {
    break;
  }

  await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
}

if (process.exitCode !== 0) {
  console.error(
    `::error::the post-install hook left no trace within ${TIMEOUT_MS / 1000}s — last seen: ${lastSeen}`,
  );
  process.exitCode = 1;
}
