/**
 * Thin GraphQL client used only for test *setup* and *teardown*.
 *
 * Every assertion in this suite is made against the UI. The API is here to
 * create the fixture leads a test needs and to delete them afterwards, because
 * driving a five-field record-creation form through the browser proves nothing
 * about Greenlight and takes twenty seconds a lead.
 *
 * The key below is the Twenty dev container's seeded workspace API key. It is
 * the same value the app's own integration-test config falls back to, it only
 * opens the throwaway localhost workspace, and it is not a secret in any sense
 * that matters. Override with GREENLIGHT_E2E_API_KEY if the container is reseeded.
 */
const API_URL = process.env.GREENLIGHT_E2E_BASE_URL ?? 'http://localhost:2020';

const SEEDED_DEV_API_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIyMDIwMjAyMC0xYzI1LTRkMDItYmYyNS02YWVjY2Y3ZWE0MTkiLCJ0eXBlIjoiQVBJX0tFWSIsIndvcmtzcGFjZUlkIjoiMjAyMDIwMjAtMWMyNS00ZDAyLWJmMjUtNmFlY2NmN2VhNDE5IiwiaWF0IjoxNzM1Njg5NjAwLCJleHAiOjQ4OTE0NDk2MDAsImp0aSI6IjIwMjAyMDIwLWY0MDEtNGQ4YS1hNzMxLTY0ZDAwN2MyN2JhZCJ9.bfQjfyN0NEtTCLE_xPyNcwonDzlSXFoP8kdCQTdnuDc';

const API_KEY = process.env.GREENLIGHT_E2E_API_KEY ?? SEEDED_DEV_API_KEY;

type GqlResult<T> = { data?: T; errors?: { message: string }[] };

const call = async <T>(
  endpoint: 'graphql' | 'metadata',
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> => {
  const response = await fetch(`${API_URL}/${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = (await response.json()) as GqlResult<T>;

  if (payload.errors?.length) {
    throw new Error(
      `Twenty ${endpoint} error: ${payload.errors.map((e) => e.message).join('; ')}`,
    );
  }

  if (payload.data === undefined) {
    throw new Error(`Twenty ${endpoint} returned no data (HTTP ${response.status})`);
  }

  return payload.data;
};

export type PersonInput = {
  name: { firstName: string; lastName: string };
  emails?: { primaryEmail: string };
  jobTitle?: string;
  /** Links the lead to a Company. Enrichment searches on the employer's name. */
  companyId?: string;
};

export type ScoredPerson = {
  id: string;
  greenlightScore: number | null;
  greenlightDecision: string | null;
  /**
   * The full rule trace as written back to the record.
   *
   * Read as `unknown` and narrowed at the call site. It is a RAW_JSON column
   * whose shape is the app's business, and typing it here would mean this test
   * helper had an opinion the app would then have to keep it in step with.
   */
  greenlightTrace?: unknown;
};

/** One rule's verdict, as it appears inside `greenlightTrace.rules`. */
export type TraceRule = {
  ruleId: string;
  outcome: string;
  credit: number;
  explanation: string;
};

/**
 * Pull one rule's verdict out of a trace.
 *
 * Returns `null` rather than throwing when the rule is absent, so a test can
 * say "the decision-maker rule did not run" instead of failing on a property
 * access three frames from the assertion that cared.
 */
export const traceRule = (
  trace: unknown,
  ruleId: string,
): TraceRule | null => {
  if (typeof trace !== 'object' || trace === null) {
    return null;
  }

  const rules = (trace as { rules?: unknown }).rules;

  if (!Array.isArray(rules)) {
    return null;
  }

  return (
    (rules.find(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as { ruleId?: unknown }).ruleId === ruleId,
    ) as TraceRule | undefined) ?? null
  );
};

/** The calibration stamp the scoring run writes onto every trace. */
export const traceCalibration = (
  trace: unknown,
): { source?: string; version?: number } | null => {
  if (typeof trace !== 'object' || trace === null) {
    return null;
  }

  const calibration = (trace as { calibration?: unknown }).calibration;

  return typeof calibration === 'object' && calibration !== null
    ? (calibration as { source?: string; version?: number })
    : null;
};

export const createPerson = async (data: PersonInput): Promise<string> => {
  const result = await call<{ createPerson: { id: string } }>(
    'graphql',
    `mutation Create($data: PersonCreateInput!) {
       createPerson(data: $data) { id }
     }`,
    { data },
  );

  return result.createPerson.id;
};

export const readPerson = async (id: string): Promise<ScoredPerson | null> => {
  const result = await call<{ person: ScoredPerson[] | ScoredPerson | null }>(
    'graphql',
    `query Read($id: UUID!) {
       person(filter: { id: { eq: $id } }) {
         id
         greenlightScore
         greenlightDecision
         greenlightTrace
       }
     }`,
    { id },
  );

  const person = result.person;

  return Array.isArray(person) ? (person[0] ?? null) : person;
};

export const deletePerson = async (id: string): Promise<void> => {
  await call('graphql', `mutation Del($id: UUID!) { deletePerson(id: $id) { id } }`, {
    id,
  });
};

/**
 * Enrichment searches on the *employer's* name, so a lead with no company is a
 * lead with nothing to look up — `planEnrichment` returns `no_identity_to_search`
 * and the run never reaches a provider. Every enrichment fixture therefore needs
 * a real, findable company behind it.
 */
export const createCompany = async (name: string): Promise<string> => {
  const result = await call<{ createCompany: { id: string } }>(
    'graphql',
    `mutation Create($data: CompanyCreateInput!) {
       createCompany(data: $data) { id }
     }`,
    { data: { name } },
  );

  return result.createCompany.id;
};

export const deleteCompany = async (id: string): Promise<void> => {
  await call('graphql', `mutation Del($id: UUID!) { deleteCompany(id: $id) { id } }`, {
    id,
  });
};

export type EnrichedPerson = ScoredPerson & {
  greenlightEnrichmentStatus: string | null;
  greenlightEnrichedAt: string | null;
  /** The provenance blob. `unknown` for the same reason `greenlightTrace` is. */
  greenlightEnrichment?: unknown;
};

export const readEnrichment = async (
  id: string,
): Promise<EnrichedPerson | null> => {
  const result = await call<{ person: EnrichedPerson[] | EnrichedPerson | null }>(
    'graphql',
    `query ReadEnrichment($id: UUID!) {
       person(filter: { id: { eq: $id } }) {
         id
         greenlightScore
         greenlightDecision
         greenlightEnrichmentStatus
         greenlightEnrichedAt
         greenlightEnrichment
       }
     }`,
    { id },
  );

  const person = result.person;

  return Array.isArray(person) ? (person[0] ?? null) : person;
};

/** One enriched field, as the app writes it. */
export type EnrichedField = {
  value: string;
  parsedValue: string | number;
  sourceUrl: string;
  sourceTitle: string;
  retrievedAt: string;
  confidence: number;
  verification: string;
  searchProvider: string;
  reasoningProvider: string;
  reasoningModel: string;
};

export const enrichedFields = (
  person: EnrichedPerson | null,
): Record<string, EnrichedField> => {
  const blob = person?.greenlightEnrichment;

  if (typeof blob !== 'object' || blob === null) {
    return {};
  }

  const fields = (blob as { fields?: unknown }).fields;

  return typeof fields === 'object' && fields !== null
    ? (fields as Record<string, EnrichedField>)
    : {};
};

/**
 * Wait for the scoring trigger to land a decision on a freshly created lead.
 *
 * Scoring is an event handler, so a record is visible in the UI before it is
 * scored. A test that navigated straight to the gate queue would be racing the
 * trigger; this makes the wait explicit and gives a useful message when the
 * trigger is what is broken rather than the screen under test.
 */
export const waitForDecision = async (
  id: string,
  timeoutMs = 90_000,
): Promise<ScoredPerson> => {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const person = await readPerson(id);

    if (person?.greenlightDecision != null) {
      return person;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `Person ${id} was still unscored after ${timeoutMs}ms — the Greenlight ` +
          'scoring trigger did not fire, or it failed silently.',
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
};

/** View ids are resolved by name so a re-apply that renumbers nothing still works. */
export const viewIdByName = async (name: string): Promise<string> => {
  const result = await call<{
    getViews: { edges: { node: { id: string; name: string } }[] };
  }>(
    'metadata',
    `query { getViews(paging: { first: 500 }) { edges { node { id name } } } }`,
  );

  const match = result.getViews.edges.find((edge) => edge.node.name === name);

  if (!match) {
    throw new Error(
      `No view named "${name}" exists in the workspace. Installed views: ` +
        result.getViews.edges.map((e) => e.node.name).join(', '),
    );
  }

  return match.node.id;
};
