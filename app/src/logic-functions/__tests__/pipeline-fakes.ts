/**
 * An in-memory Twenty, for the pipeline tests.
 *
 * The same shape and the same reasoning as `enrich-fakes.ts`: `CoreApiClient` is
 * typed `any` and reads its credentials from the process environment in its
 * constructor, so there is nothing to mock. Every pipeline handler takes a
 * `GreenlightApiClient` and this is what the tests pass instead.
 *
 * It is a router rather than a stub with canned answers, because most of what
 * these tests are checking is *which* request was issued — that a matched company
 * produced no company mutation at all, that a handoff produced exactly one
 * `createOpportunity`, that a failing page did not take the board down. A canned
 * responder would make all three unobservable.
 *
 * Each `fail*` switch throws from one kind of read, which is how the fail-open
 * paths are driven: every one of them has to produce a notice rather than an
 * exception, and there is no way to assert that without a workspace that breaks
 * in a specific place.
 */

import {
  createFakeClient,
  type FakeClient,
} from 'src/logic-functions/__tests__/fake-client';

export interface FakeWorkspaceOptions {
  readonly people?: readonly Record<string, unknown>[];
  readonly opportunities?: readonly Record<string, unknown>[];
  readonly companies?: readonly Record<string, unknown>[];
  readonly taskTargets?: readonly Record<string, unknown>[];
  readonly noteTargets?: readonly Record<string, unknown>[];
  readonly config?: Record<string, unknown> | null;
  /** Does this workspace's Opportunity answer to `ownerId`? */
  readonly ownerField?: boolean;
  readonly failConfigRead?: boolean;
  readonly failPeoplePages?: boolean;
  readonly failOpportunityPages?: boolean;
  readonly failActivityReads?: boolean;
  readonly failCompanyLookups?: boolean;
  /** Reject every mutation whose name is in this set. */
  readonly failMutations?: readonly string[];
}

export const DEFAULT_CONFIG_RECORD: Record<string, unknown> = {
  id: 'config-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  gateThreshold: 70,
  defaultShelfLifeDays: 30,
  fieldShelfLives: {},
};

const args = (request: Record<string, unknown>, key: string): Record<string, unknown> => {
  const node = request[key];

  if (typeof node !== 'object' || node === null) {
    return {};
  }

  const found = (node as Record<string, unknown>)['__args'];

  return typeof found === 'object' && found !== null
    ? (found as Record<string, unknown>)
    : {};
};

const selection = (
  request: Record<string, unknown>,
  key: string,
): Record<string, unknown> => {
  const node = request[key] as Record<string, unknown> | undefined;
  const edges = node?.['edges'] as Record<string, unknown> | undefined;

  return (edges?.['node'] ?? {}) as Record<string, unknown>;
};

const path = (source: unknown, ...keys: readonly string[]): unknown => {
  let current: unknown = source;

  for (const key of keys) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }

    current = (current as Record<string, unknown>)[key];
  }

  return current;
};

const connection = (
  name: string,
  nodes: readonly Record<string, unknown>[],
): Record<string, unknown> => ({
  [name]: { edges: nodes.map((node) => ({ node })) },
});

const byCreatedAtDesc = (
  records: readonly Record<string, unknown>[],
): Record<string, unknown>[] =>
  [...records].sort((left, right) =>
    String(right['createdAt'] ?? '').localeCompare(String(left['createdAt'] ?? '')),
  );

export interface FakeWorkspace extends FakeClient {
  /** Records created by mutations, keyed by object name. */
  readonly created: Record<string, Record<string, unknown>[]>;
}

export const createFakeWorkspace = (
  options: FakeWorkspaceOptions = {},
): FakeWorkspace => {
  const people = [...(options.people ?? [])];
  const opportunities = [...(options.opportunities ?? [])];
  const companies = [...(options.companies ?? [])];
  const failMutations = new Set(options.failMutations ?? []);
  const created: Record<string, Record<string, unknown>[]> = {};

  // Per-prefix, so `person-1` is the first person created however many companies
  // were inserted before it. A shared counter makes every assertion in these
  // tests depend on the order of a step it is not about.
  const nextId = new Map<string, number>();
  const mint = (prefix: string): string => {
    const next = (nextId.get(prefix) ?? 0) + 1;

    nextId.set(prefix, next);

    return `${prefix}-${next}`;
  };

  const record = (name: string, data: Record<string, unknown>): void => {
    created[name] = [...(created[name] ?? []), data];
  };

  const client = createFakeClient({
    query: (request) => {
      /* --- configuration ------------------------------------------------- */

      if ('greenlightConfigs' in request) {
        if (options.failConfigRead === true) {
          throw new Error('greenlightConfigs is unavailable');
        }

        const config =
          options.config === undefined ? DEFAULT_CONFIG_RECORD : options.config;

        return connection('greenlightConfigs', config === null ? [] : [config]);
      }

      /* --- people -------------------------------------------------------- */

      if ('people' in request) {
        const filter = args(request, 'people')['filter'];
        const id = path(filter, 'id', 'eq');

        if (typeof id === 'string') {
          return connection(
            'people',
            people.filter((person) => person['id'] === id),
          );
        }

        const email = path(filter, 'emails', 'primaryEmail', 'ilike');

        if (typeof email === 'string') {
          const wanted = email.toLowerCase();

          return connection(
            'people',
            people.filter(
              (person) =>
                String(path(person, 'emails', 'primaryEmail') ?? '').toLowerCase() ===
                wanted,
            ),
          );
        }

        if (options.failPeoplePages === true) {
          throw new Error('people could not be paged');
        }

        const first = Number(args(request, 'people')['first'] ?? 60);
        const before = path(filter, 'createdAt', 'lte');
        const ordered = byCreatedAtDesc(people).filter((person) =>
          typeof before === 'string'
            ? String(person['createdAt'] ?? '') <= before
            : true,
        );

        return connection('people', ordered.slice(0, first));
      }

      /* --- opportunities -------------------------------------------------- */

      if ('opportunities' in request) {
        const asked = Object.keys(selection(request, 'opportunities'));

        if (asked.includes('ownerId') && options.ownerField !== true) {
          throw new Error('Cannot query field "ownerId" on type "Opportunity"');
        }

        // The owner probe: `first: 1`, id and ownerId only.
        if (asked.length === 2 && asked.includes('ownerId')) {
          return connection('opportunities', []);
        }

        const filter = args(request, 'opportunities')['filter'];
        const id = path(filter, 'id', 'eq');

        if (typeof id === 'string') {
          return connection(
            'opportunities',
            opportunities.filter((deal) => deal['id'] === id),
          );
        }

        const contactId = path(filter, 'pointOfContactId', 'eq');

        if (typeof contactId === 'string') {
          return connection(
            'opportunities',
            opportunities.filter((deal) => deal['pointOfContactId'] === contactId),
          );
        }

        if (options.failOpportunityPages === true) {
          throw new Error('opportunities could not be paged');
        }

        const first = Number(args(request, 'opportunities')['first'] ?? 60);
        const before = path(filter, 'createdAt', 'lte');
        const ordered = byCreatedAtDesc(opportunities).filter((deal) =>
          typeof before === 'string'
            ? String(deal['createdAt'] ?? '') <= before
            : true,
        );

        return connection('opportunities', ordered.slice(0, first));
      }

      /* --- companies ------------------------------------------------------ */

      if ('companies' in request) {
        if (options.failCompanyLookups === true) {
          throw new Error('companies could not be read');
        }

        const filter = args(request, 'companies')['filter'];
        const domain = path(filter, 'domainName', 'primaryLinkUrl', 'ilike');

        if (typeof domain === 'string') {
          const needle = domain.replace(/%/g, '').toLowerCase();

          return connection(
            'companies',
            companies.filter((company) =>
              String(path(company, 'domainName', 'primaryLinkUrl') ?? '')
                .toLowerCase()
                .includes(needle),
            ),
          );
        }

        const name = path(filter, 'name', 'ilike');

        if (typeof name === 'string') {
          const wanted = name.trim().toLowerCase();

          return connection(
            'companies',
            companies.filter(
              (company) =>
                String(company['name'] ?? '').trim().toLowerCase() === wanted,
            ),
          );
        }

        return connection('companies', companies);
      }

      /* --- activity ------------------------------------------------------- */

      for (const join of ['taskTargets', 'noteTargets'] as const) {
        if (join in request) {
          if (options.failActivityReads === true) {
            throw new Error(`${join} could not be read`);
          }

          const wanted = path(args(request, join)['filter'], 'opportunityId', 'in');
          const ids = Array.isArray(wanted) ? wanted.map(String) : [];
          const rows =
            join === 'taskTargets'
              ? (options.taskTargets ?? [])
              : (options.noteTargets ?? []);

          return connection(
            join,
            rows.filter((row) => ids.includes(String(row['opportunityId'] ?? ''))),
          );
        }
      }

      return {};
    },

    mutation: (request) => {
      const [name] = Object.keys(request);

      if (name === undefined) {
        return {};
      }

      if (failMutations.has(name)) {
        throw new Error(`${name} was rejected`);
      }

      const data = (args(request, name)['data'] ?? {}) as Record<string, unknown>;
      const id = args(request, name)['id'];

      record(name, { ...data, ...(typeof id === 'string' ? { id } : {}) });

      if (name === 'createCompany') {
        const companyId = mint('company');

        companies.push({ id: companyId, createdAt: '2026-08-06T00:00:00.000Z', ...data });

        return { createCompany: { id: companyId } };
      }

      if (name === 'createPerson') {
        const personId = mint('person');

        people.push({ id: personId, createdAt: '2026-08-06T00:00:00.000Z', ...data });

        return { createPerson: { id: personId } };
      }

      if (name === 'createOpportunity') {
        const opportunityId = mint('opportunity');

        opportunities.push({
          id: opportunityId,
          createdAt: '2026-08-06T00:00:00.000Z',
          ...data,
        });

        return { createOpportunity: { id: opportunityId } };
      }

      const patch = (
        collection: Record<string, unknown>[],
      ): Record<string, unknown> => {
        const index = collection.findIndex((entry) => entry['id'] === id);

        if (index !== -1) {
          collection[index] = { ...collection[index], ...data };
        }

        return { id };
      };

      if (name === 'updatePerson') {
        return { updatePerson: patch(people) };
      }

      if (name === 'updateOpportunity') {
        return { updateOpportunity: patch(opportunities) };
      }

      if (name === 'updateCompany') {
        return { updateCompany: patch(companies) };
      }

      return { [name]: { id: mint('row') } };
    },
  });

  return { ...client, created };
};

/* -------------------------------------------------------------------------- */
/* Record builders                                                             */
/* -------------------------------------------------------------------------- */

export const aPerson = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: 'person-a',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
  name: { firstName: 'Priya', lastName: 'Raman' },
  emails: { primaryEmail: 'priya@northwind.example' },
  jobTitle: 'Head of Operations',
  companyId: 'company-a',
  company: { id: 'company-a', name: 'Northwind Logistics' },
  greenlightScore: 82,
  greenlightDecision: 'PASS',
  greenlightTrace: { rules: [] },
  greenlightSuppressed: false,
  greenlightSuppressionReason: null,
  greenlightEnrichment: null,
  greenlightEnrichmentStatus: 'ENRICHED',
  ...overrides,
});

export const anOpportunity = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: 'opportunity-a',
  createdAt: '2026-07-10T00:00:00.000Z',
  updatedAt: '2026-07-10T00:00:00.000Z',
  name: 'Northwind Logistics',
  stage: 'NEW',
  amount: { amountMicros: 25_000_000_000, currencyCode: 'GBP' },
  closeDate: null,
  companyId: 'company-a',
  pointOfContactId: 'person-a',
  ...overrides,
});

export const aCompany = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: 'company-a',
  createdAt: '2026-01-05T00:00:00.000Z',
  name: 'Northwind Logistics',
  domainName: { primaryLinkUrl: 'https://northwind.example' },
  ...overrides,
});
