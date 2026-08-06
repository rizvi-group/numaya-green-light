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
  /**
   * The reachability rules score a phone as well as an email, so a fixture that
   * has to reach the top of a lane — a demo card, rather than an assertion —
   * needs one. Optional, and no existing fixture passes it.
   */
  phones?: {
    primaryPhoneNumber: string;
    primaryPhoneCallingCode: string;
    primaryPhoneCountryCode: string;
  };
  linkedinLink?: { primaryLinkUrl: string };
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
export const createCompany = async (
  name: string,
  options: { domainName?: string } = {},
): Promise<string> => {
  const result = await call<{ createCompany: { id: string } }>(
    'graphql',
    `mutation Create($data: CompanyCreateInput!) {
       createCompany(data: $data) { id }
     }`,
    {
      data: {
        name,
        ...(options.domainName === undefined
          ? {}
          : { domainName: { primaryLinkUrl: options.domainName } }),
      },
    },
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

/**
 * One row of the Greenlight audit log.
 *
 * Added for the demo recordings in `e2e/demos/`, which have to put the override
 * reason on screen: it is the Article 22 evidence, the audit-log *view* does not
 * carry it as a column, and the record page clips it to about thirty characters.
 * Reading it back through the API is the only way to show what was actually
 * recorded. Purely additive — nothing in `e2e/tests/` calls it.
 */
export type AuditRow = {
  id: string;
  name: string;
  eventType: string | null;
  overrideReason: string | null;
  actorType: string | null;
  actorDisplayName: string | null;
  score: number | null;
  band: string | null;
  decision: string | null;
  occurredAt: string | null;
};

export const readAuditRowsForLead = async (
  leadDisplayName: string,
): Promise<AuditRow[]> => {
  const result = await call<{
    greenlightAuditLogs: { edges: { node: AuditRow }[] };
  }>(
    'graphql',
    `query AuditForLead($lead: String!) {
       greenlightAuditLogs(
         filter: { leadDisplayName: { eq: $lead } }
         orderBy: { occurredAt: DescNullsLast }
         first: 20
       ) {
         edges {
           node {
             id
             name
             eventType
             overrideReason
             actorType
             actorDisplayName
             score
             band
             decision
             occurredAt
           }
         }
       }
     }`,
    { lead: leadDisplayName },
  );

  return result.greenlightAuditLogs.edges.map((edge) => edge.node);
};

/**
 * Delete the audit rows a suite's own fixtures produced.
 *
 * The Greenlight Audit Log is append-only by design and no other spec touches
 * it, which was fine while the only rows a test run added were the two or three
 * scoring events its leads triggered. The pipeline suite deliberately writes to
 * it — a move is audited whether or not anything else succeeded — so a run adds
 * about ten rows, and the log is what `05-calibration` reads its licence row out
 * of by scrolling a list view that shows the newest few dozen. Left alone, a
 * morning of pipeline runs pushes that row off the screen and fails a suite that
 * has nothing to do with this one.
 *
 * Deleted in one bulk mutation rather than a row at a time: Twenty's REST/GraphQL
 * limit is 100 requests a minute per workspace, and a teardown that could spend
 * that on its own would be a teardown that intermittently fails the run it is
 * cleaning up after.
 */
export const deleteAuditRowsForLeads = async (
  leadDisplayNames: readonly string[],
): Promise<number> => {
  const names = leadDisplayNames.filter((name) => name !== '');

  if (names.length === 0) {
    return 0;
  }

  const found = await call<{
    greenlightAuditLogs: { edges: { node: { id: string } }[] };
  }>(
    'graphql',
    `query AuditRowsFor($names: [String!]) {
       greenlightAuditLogs(
         filter: { leadDisplayName: { in: $names } }
         first: 200
       ) {
         edges { node { id } }
       }
     }`,
    { names },
  );

  const ids = found.greenlightAuditLogs.edges.map((edge) => edge.node.id);

  if (ids.length === 0) {
    return 0;
  }

  const deleted = await call<{ deleteGreenlightAuditLogs: { id: string }[] }>(
    'graphql',
    `mutation DeleteAuditRows($ids: [UUID!]!) {
       deleteGreenlightAuditLogs(filter: { id: { in: $ids } }) { id }
     }`,
    { ids },
  );

  return deleted.deleteGreenlightAuditLogs.length;
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

/* -------------------------------------------------------------------------- */
/* Pipeline board                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The board's own lane order, restated here on purpose.
 *
 * `07-pipeline.spec.ts` asserts that the nine lanes appear in the order
 * `PIPELINE_LANES` documents. Importing that constant out of `app/src` would
 * make the test agree with the code by construction — the two would be the same
 * array, and a reordering would move both at once and be asserted by nothing.
 * The suite is a sibling of `app/` precisely so it cannot reach into it; this is
 * the same argument applied to a constant instead of a module.
 */
export const PIPELINE_LANE_LABELS_IN_ORDER: readonly string[] = [
  'Captured',
  'Enriching',
  'Held',
  'Qualified',
  'New',
  'Screening',
  'Meeting',
  'Proposal',
  'Customer',
];

export type OpportunityInput = {
  name: string;
  /** `NEW` | `SCREENING` | `MEETING` | `PROPOSAL` | `CUSTOMER`. */
  stage: string;
  companyId?: string;
  /** The Person the board carries across the handoff line as point of contact. */
  pointOfContactId?: string;
};

export const createOpportunity = async (
  data: OpportunityInput,
): Promise<string> => {
  const result = await call<{ createOpportunity: { id: string } }>(
    'graphql',
    `mutation Create($data: OpportunityCreateInput!) {
       createOpportunity(data: $data) { id }
     }`,
    { data },
  );

  return result.createOpportunity.id;
};

export const deleteOpportunity = async (id: string): Promise<void> => {
  await call(
    'graphql',
    `mutation Del($id: UUID!) { deleteOpportunity(id: $id) { id } }`,
    { id },
  );
};

/* -------------------------------------------------------------------------- *
 * Notes attached to a deal.
 *
 * The Screening→Meeting criterion is "a discovery call was logged", and
 * `default-role.ts` refused `calendarEvent` in order to answer it from a Task or
 * a Note a human deliberately attached to the deal. Every fixture the suite had
 * until now exercised the *unmet* side of that; a fixture that satisfies it
 * needs a real Note and a real link, which is what these two write.
 *
 * `noteTarget` links through a MORPH_RELATION, so the input field is
 * `targetOpportunityId` and not `opportunityId` — measured against the
 * container's own metadata, where `opportunityId` does not exist and the
 * mutation is rejected by name.
 * -------------------------------------------------------------------------- */

export const createNote = async (title: string): Promise<string> => {
  const result = await call<{ createNote: { id: string } }>(
    'graphql',
    `mutation Create($data: NoteCreateInput!) { createNote(data: $data) { id } }`,
    { data: { title } },
  );

  return result.createNote.id;
};

/** Attach an existing Note to an Opportunity. Returns the link's own id. */
export const attachNoteToOpportunity = async (
  noteId: string,
  opportunityId: string,
): Promise<string> => {
  const result = await call<{ createNoteTarget: { id: string } }>(
    'graphql',
    `mutation Create($data: NoteTargetCreateInput!) {
       createNoteTarget(data: $data) { id }
     }`,
    { data: { noteId, targetOpportunityId: opportunityId } },
  );

  return result.createNoteTarget.id;
};

export const deleteNoteTarget = async (id: string): Promise<void> => {
  await call(
    'graphql',
    `mutation Del($id: UUID!) { deleteNoteTarget(id: $id) { id } }`,
    { id },
  );
};

export const deleteNote = async (id: string): Promise<void> => {
  await call('graphql', `mutation Del($id: UUID!) { deleteNote(id: $id) { id } }`, {
    id,
  });
};

/** An Opportunity, with the five fields the board writes onto it. */
export type AdvisedOpportunity = {
  id: string;
  name: string | null;
  stage: string | null;
  companyId: string | null;
  pointOfContactId: string | null;
  greenlightNextAction: string | null;
  greenlightNextActionKind: string | null;
  greenlightAdvisedAt: string | null;
  greenlightReadiness: number | null;
  /** RAW_JSON. `unknown` for the same reason `greenlightTrace` is. */
  greenlightCriteria?: unknown;
};

const OPPORTUNITY_SELECTION = `
  id
  name
  stage
  companyId
  pointOfContactId
  greenlightNextAction
  greenlightNextActionKind
  greenlightAdvisedAt
  greenlightReadiness
  greenlightCriteria
`;

export const readOpportunity = async (
  id: string,
): Promise<AdvisedOpportunity | null> => {
  const result = await call<{
    opportunities: { edges: { node: AdvisedOpportunity }[] };
  }>(
    'graphql',
    `query ReadOpportunity($id: UUID!) {
       opportunities(filter: { id: { eq: $id } }, first: 1) {
         edges { node { ${OPPORTUNITY_SELECTION} } }
       }
     }`,
    { id },
  );

  return result.opportunities.edges[0]?.node ?? null;
};

/**
 * Every deal whose point of contact is this lead.
 *
 * The handoff test's central claim is "exactly one Opportunity was created", so
 * the helper returns the list rather than a boolean — two is a different and
 * much worse failure than none, and a test that could only say "not one" would
 * not tell them apart.
 */
export const opportunitiesForPerson = async (
  personId: string,
): Promise<AdvisedOpportunity[]> => {
  const result = await call<{
    opportunities: { edges: { node: AdvisedOpportunity }[] };
  }>(
    'graphql',
    `query DealsFor($personId: UUID!) {
       opportunities(
         filter: { pointOfContactId: { eq: $personId } }
         first: 20
       ) {
         edges { node { ${OPPORTUNITY_SELECTION} } }
       }
     }`,
    { personId },
  );

  return result.opportunities.edges.map((edge) => edge.node);
};

/** A Person, with the three advice fields the board writes onto it. */
export type AdvisedPerson = ScoredPerson & {
  companyId: string | null;
  greenlightNextAction: string | null;
  greenlightNextActionKind: string | null;
  greenlightAdvisedAt: string | null;
  name?: { firstName: string; lastName: string };
  emails?: { primaryEmail: string };
};

const PERSON_ADVICE_SELECTION = `
  id
  companyId
  name { firstName lastName }
  emails { primaryEmail }
  greenlightScore
  greenlightDecision
  greenlightNextAction
  greenlightNextActionKind
  greenlightAdvisedAt
`;

export const readPersonAdvice = async (
  id: string,
): Promise<AdvisedPerson | null> => {
  const result = await call<{ people: { edges: { node: AdvisedPerson }[] } }>(
    'graphql',
    `query ReadAdvice($id: UUID!) {
       people(filter: { id: { eq: $id } }, first: 1) {
         edges { node { ${PERSON_ADVICE_SELECTION} } }
       }
     }`,
    { id },
  );

  return result.people.edges[0]?.node ?? null;
};

/** The capture drawer is given an email and nothing else to find the lead by. */
export const findPersonByEmail = async (
  email: string,
): Promise<AdvisedPerson | null> => {
  const result = await call<{ people: { edges: { node: AdvisedPerson }[] } }>(
    'graphql',
    `query ByEmail($email: String!) {
       people(filter: { emails: { primaryEmail: { eq: $email } } }, first: 2) {
         edges { node { ${PERSON_ADVICE_SELECTION} } }
       }
     }`,
    { email },
  );

  return result.people.edges[0]?.node ?? null;
};

/**
 * A Company read wide enough to prove one was *not* touched.
 *
 * Every scalar and composite the object carries, `updatedAt` included. The
 * capture chain's contract is that matching an existing company links to it and
 * changes nothing on it, and a comparison that only checked `name` would pass
 * while the address, the domain or the revenue had been overwritten by whatever
 * the person typed into the drawer.
 */
export type CompanyRecord = Record<string, unknown> & { id: string };

export const readCompany = async (id: string): Promise<CompanyRecord | null> => {
  const result = await call<{ companies: { edges: { node: CompanyRecord }[] } }>(
    'graphql',
    `query ReadCompany($id: UUID!) {
       companies(filter: { id: { eq: $id } }, first: 1) {
         edges {
           node {
             id
             name
             createdAt
             updatedAt
             position
             accountOwnerId
             domainName { primaryLinkUrl primaryLinkLabel secondaryLinks }
             linkedinLink { primaryLinkUrl primaryLinkLabel secondaryLinks }
             annualRevenue { amountMicros currencyCode }
             address {
               addressStreet1
               addressStreet2
               addressCity
               addressState
               addressCountry
               addressPostcode
             }
           }
         }
       }
     }`,
    { id },
  );

  return result.companies.edges[0]?.node ?? null;
};

export const findCompaniesByName = async (
  name: string,
): Promise<{ id: string; name: string }[]> => {
  const result = await call<{
    companies: { edges: { node: { id: string; name: string } }[] };
  }>(
    'graphql',
    `query ByName($name: String!) {
       companies(filter: { name: { eq: $name } }, first: 10) {
         edges { node { id name } }
       }
     }`,
    { name },
  );

  return result.companies.edges.map((edge) => edge.node);
};

/**
 * The workspace's own label for each `greenlightNextActionKind`.
 *
 * The card's chip and the record page's tag are both rendered from this SELECT's
 * options, so reading them back out of metadata is how a test can say "the chip
 * on screen is the label this workspace holds for the kind on the record"
 * without restating fourteen strings that live in the app.
 */
export const nextActionKindLabels = async (): Promise<
  Record<string, string>
> => {
  const result = await call<{
    objects: {
      edges: {
        node: {
          nameSingular: string;
          fields: {
            edges: {
              node: {
                name: string;
                options: { value: string; label: string }[] | null;
              };
            }[];
          };
        };
      }[];
    };
  }>(
    'metadata',
    `query {
       objects(paging: { first: 300 }) {
         edges {
           node {
             nameSingular
             fields(paging: { first: 300 }) {
               edges { node { name options } }
             }
           }
         }
       }
     }`,
  );

  const opportunity = result.objects.edges.find(
    (edge) => edge.node.nameSingular === 'opportunity',
  );

  const field = opportunity?.node.fields.edges.find(
    (edge) => edge.node.name === 'greenlightNextActionKind',
  );

  const options = field?.node.options;

  if (!options || options.length === 0) {
    throw new Error(
      'Opportunity.greenlightNextActionKind has no SELECT options in this ' +
        'workspace, so the app is not applied or the field did not install.',
    );
  }

  return Object.fromEntries(options.map((option) => [option.value, option.label]));
};

/**
 * POST to the board's own logic-function route.
 *
 * Used for two things only, both of them *outside* the assertions:
 *
 *   - reading the lane totals the screen is claiming, so "the header count is
 *     the true total" is checked against the server's arithmetic rather than
 *     against a number typed into this file;
 *   - deciding whether the AI rewrite has a model behind it at all, which is
 *     `narrativeUnavailable` on a single-card `advise` and is the cheapest
 *     honest way to derive that precondition from observed state rather than
 *     from an environment variable. It costs at most one model call, on one
 *     card, and only on a workspace that has a model to spend it on.
 *
 * Everything a test *claims* is still asserted in the browser. This is the same
 * split the rest of this file lives on.
 */
export const postPipeline = async <T>(
  request: Record<string, unknown>,
): Promise<T> => {
  const response = await fetch(`${API_URL}/s/greenlight/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  const body = (await response.json()) as T & { action?: string; message?: string };

  if (body.action === 'error') {
    throw new Error(
      `The pipeline route refused ${JSON.stringify(request)}: ${body.message}`,
    );
  }

  return body;
};

export type BoardLaneTotals = {
  lanes: { lane: string; label: string; total: number; cardCount: number }[];
};

export const readBoardTotals = async (): Promise<BoardLaneTotals> => {
  const board = await postPipeline<{
    lanes: { lane: string; label: string; total: number; cards: unknown[] }[];
  }>({ action: 'board' });

  return {
    lanes: board.lanes.map((lane) => ({
      lane: lane.lane,
      label: lane.label,
      total: lane.total,
      cardCount: lane.cards.length,
    })),
  };
};

/**
 * Does this workspace have a model behind the AI rewrite?
 *
 * Derived from a real `advise` on one card rather than from a key being set,
 * for the reason `05-calibration.spec.ts` sets out at length: "a key is present"
 * can be true while delivery is broken, and a suite that skipped on the env var
 * would report a broken integration as an absent one.
 */
export const narrativeLayerAvailable = async (
  leadId: string,
): Promise<boolean> => {
  const reply = await postPipeline<{ narrativeUnavailable: boolean }>({
    action: 'advise',
    leadId,
    withNarrative: true,
  });

  return reply.narrativeUnavailable === false;
};
