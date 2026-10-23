/**
 * The live API-contract suite — every read this app issues, against a real Twenty.
 *
 * ===========================================================================
 * ## Why this file exists
 *
 * `pipeline-store.ts` asked Twenty for
 *
 *     taskTargets(filter: { opportunityId: { in: [...] } })
 *
 * for months. `opportunityId` is selectable on `taskTarget` — it comes back on
 * every row — but it is not filterable, and the live API answered every call
 * with
 *
 *     Object taskTarget doesn't have any "opportunityId" field.
 *
 * The query threw every time, a `catch` folded it into a soft "could not read",
 * and the two activity criteria the pipeline exists to answer reported
 * `indeterminate` for every deal on the board from the day they were written.
 * 1448 unit tests were green throughout, because the in-memory workspace
 * modelled the same assumption as the code it was testing. A fake cannot catch a
 * wrong belief about a server it is standing in for. Only the server can.
 *
 * So this suite exists to hold one contract, and the contract has two edges that
 * point in opposite directions. Twenty's core GraphQL:
 *
 *   - **validates arguments.** A `filter`, an `orderBy`, or a mutation's `data`
 *     naming a field the object does not have is rejected outright:
 *     `Object taskTarget doesn't have any "opportunityId" field.`
 *   - **does not validate selection sets.** A column the object does not have is
 *     selected without complaint and comes back `null`:
 *     `{ people(first: 1) { edges { node { id nonesuchField } } } }`
 *     → `{ "node": { "id": "…", "nonesuchField": null } }`
 *
 * Both edges have drawn blood in this repository:
 *
 *   - `selectable` implying `filterable` produced the `taskTargets` bug above.
 *   - *"the request came back, so the field is there"* produced two field probes
 *     that answered `true` on every workspace in existence —
 *     `probeOpportunityOwner` in `pipeline-store.ts`, which had the board telling
 *     reps *"nobody owns this deal"* on workspaces with no owner column at all,
 *     and `probeField` in `icp-run.ts`, which reported an ICP derived from five
 *     industry columns that mostly do not exist.
 *
 * ## What it actually does
 *
 * It does not restate the app's queries. Restating them is how the fakes came to
 * be complicit: a copy of a wrong query proves the copy is faithful, not that the
 * query is right. Instead it hands the app's **own read functions** a
 * `GreenlightApiClient` that speaks to a real instance, lets them run, and then
 * asserts over the log of what went down the wire.
 *
 * That is the part that matters. Nearly every read in this app is wrapped in a
 * `catch` that degrades to a notice, which is correct behaviour and is also
 * exactly why a broken query can live for months. Asserting on the *return value*
 * of those functions proves nothing — they succeed by design. Asserting on the
 * **request log** defeats the swallow: a rejection is visible here whether or not
 * the caller chose to survive it.
 *
 * ## How a failure is attributed
 *
 * A rejected request is bisected rather than pattern-matched on its message: the
 * same request is re-sent with every `filter` and `orderBy` argument stripped. If
 * the stripped form is accepted, the arguments were the cause and this is the bug
 * class above, so the test fails. If the stripped form is rejected too, the cause
 * is elsewhere — a deliberate probe, an unknown root field — and it is reported
 * without failing, because `probeField` and `probeOpportunityOwner` are *supposed*
 * to have their filters rejected on a workspace that lacks the column. Their
 * whole job is to ask a question whose answer may be "no".
 *
 * ## Read-only by construction
 *
 * The client refuses to send mutations. It records them and returns `{}`, and
 * every path driven here is then asserted to have attempted none. A suite that
 * writes to the instance it is measuring is a suite nobody will run twice.
 *
 * ## Why this one skips and `enrichment-providers.live-test.ts` does not
 *
 * That suite is run by hand by somebody who has just set up a search engine and a
 * model, and silence there would be a lie about work they just did. This one
 * points at a disposable Twenty container that is up on some machines and not on
 * others, and it is cheap enough to belong in any `test:live` run — the same
 * reasoning `e2e/tests/06-enrichment-live.spec.ts` gives for skipping. It prints
 * why it skipped, so a green tick is never mistaken for a proof.
 *
 * | Role     | Default                              | Override                     |
 * |----------|--------------------------------------|------------------------------|
 * | Instance | `~/.twenty/config.json` defaultRemote | `GREENLIGHT_LIVE_API_URL`   |
 * | Key      | that remote's `apiKey`                | `GREENLIGHT_LIVE_API_KEY`   |
 *
 * **Point it at a throwaway workspace.** It reads real records.
 * ===========================================================================
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  buildCountRequest,
  buildPageRequest,
  backfillPersonSelection,
  PAGE_ATTEMPTS,
} from 'src/backfill/backfill-plan';
import { BACKFILL_MODES } from 'src/backfill/backfill-state';
import { classifyProbeRejection } from 'src/backfill/field-mapping-check';
import { greenlightConfigSelection } from 'src/logic-functions/greenlight-config-record';
import type { GreenlightApiClient } from 'src/logic-functions/greenlight-api';
import { probeCompanyFields, proposeIcpForWorkspace } from 'src/logic-functions/icp-run';
import {
  findCompanyByDomain,
  findCompanyByName,
  findPersonByEmail,
  loadOpportunitiesForPerson,
  loadOpportunity,
  loadOpportunityActivity,
  loadPerson,
  pipelineOpportunitySelection,
  pipelinePersonSelection,
  probeOpportunityOwner,
  readPipelineConfigRecord,
  walkConnection,
} from 'src/logic-functions/pipeline-store';
import { suppressionLeadSelection } from 'src/logic-functions/suppression-run';

/* -------------------------------------------------------------------------- */
/* Wiring                                                                      */
/* -------------------------------------------------------------------------- */

interface Remote {
  readonly apiUrl: string;
  readonly apiKey: string;
}

/**
 * The instance to measure, from the Twenty CLI's own config if it is there.
 *
 * `~/.twenty/config.json` is what `yarn twenty` already wrote when the developer
 * connected their local container, so on a machine that can run this app at all
 * this needs no setup. The environment variables exist for CI and for pointing at
 * something the CLI does not know about. **Nothing here is ever written to a
 * file**; the key stays in memory.
 */
const resolveRemote = (): Remote | null => {
  const url = process.env['GREENLIGHT_LIVE_API_URL'];
  const key = process.env['GREENLIGHT_LIVE_API_KEY'];

  if (typeof url === 'string' && typeof key === 'string') {
    return { apiUrl: url, apiKey: key };
  }

  try {
    const raw: unknown = JSON.parse(
      readFileSync(join(homedir(), '.twenty', 'config.json'), 'utf8'),
    );

    if (typeof raw !== 'object' || raw === null) {
      return null;
    }

    const config = raw as Record<string, unknown>;
    const remotes = (config['remotes'] ?? {}) as Record<string, unknown>;
    const name =
      typeof config['defaultRemote'] === 'string'
        ? config['defaultRemote']
        : Object.keys(remotes)[0];
    const remote = (name === undefined ? undefined : remotes[name]) as
      | Record<string, unknown>
      | undefined;

    if (
      remote === undefined ||
      typeof remote['apiUrl'] !== 'string' ||
      typeof remote['apiKey'] !== 'string'
    ) {
      return null;
    }

    return {
      apiUrl: url ?? remote['apiUrl'],
      apiKey: key ?? remote['apiKey'],
    };
  } catch {
    return null;
  }
};

const REMOTE = resolveRemote();

const reachable = async (remote: Remote): Promise<boolean> => {
  try {
    const response = await fetch(`${remote.apiUrl}/graphql`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${remote.apiKey}`,
      },
      body: JSON.stringify({ query: '{ people(first: 1) { totalCount } }' }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      return false;
    }

    const body = (await response.json()) as { data?: unknown };

    return body.data !== undefined && body.data !== null;
  } catch {
    return false;
  }
};

const LIVE = REMOTE !== null && (await reachable(REMOTE));

if (!LIVE) {
  // eslint-disable-next-line no-console
  console.log(
    '\n──── api-contract.live-test SKIPPED ────\n' +
      (REMOTE === null
        ? 'No instance configured. Set GREENLIGHT_LIVE_API_URL and GREENLIGHT_LIVE_API_KEY, or connect one with `yarn twenty`.'
        : `No Twenty answering at ${REMOTE.apiUrl}. Start the container and re-run.`) +
      '\nNothing about this app\'s queries has been proved by this run.\n',
  );
}

/* -------------------------------------------------------------------------- */
/* The object graph, as GraphQL                                                */
/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * An argument value, printed as a GraphQL literal.
 *
 * Enum-valued arguments — `orderBy: [{ createdAt: 'DescNullsLast' }]`,
 * `{ is: 'NULL' }` — are held in this app as plain strings and are printed here
 * quoted, which is what Twenty's own client does with them and what Twenty
 * accepts: its filter and order-by inputs take scalars and coerce. Both forms
 * were tried against a live instance before this was written; a server that
 * demanded bare enum tokens would reject every ordered page in the app, which is
 * precisely the kind of thing this suite is here to notice.
 */
const literal = (value: unknown): string => {
  if (value === null || value === undefined) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map(literal).join(', ')}]`;
  }

  if (isRecord(value)) {
    return `{ ${Object.entries(value)
      .map(([name, child]) => `${name}: ${literal(child)}`)
      .join(', ')} }`;
  }

  return JSON.stringify(value);
};

const argumentList = (args: unknown): string =>
  isRecord(args) && Object.keys(args).length > 0
    ? `(${Object.entries(args)
        .map(([name, value]) => `${name}: ${literal(value)}`)
        .join(', ')})`
    : '';

const selectionSet = (selection: Record<string, unknown>): string =>
  Object.entries(selection)
    .filter(([name]) => name !== '__args')
    .map(([name, value]) => {
      if (!isRecord(value)) {
        return name;
      }

      const inner = selectionSet(value);

      return `${name}${argumentList(value['__args'])}${inner === '' ? '' : ` { ${inner} }`}`;
    })
    .join(' ');

const toDocument = (
  kind: 'query' | 'mutation',
  request: Record<string, unknown>,
): string => `${kind} { ${selectionSet(request)} }`;

/* -------------------------------------------------------------------------- */
/* The client                                                                  */
/* -------------------------------------------------------------------------- */

interface Sent {
  readonly kind: 'query' | 'mutation';
  readonly request: Record<string, unknown>;
  readonly document: string;
  readonly errors: readonly string[];
}

interface LiveClient extends GreenlightApiClient {
  readonly sent: Sent[];
}

/**
 * A `GreenlightApiClient` that talks to the instance and keeps the receipts.
 *
 * It **throws** on a GraphQL error, because that is what the real client does and
 * because every fail-open path in this app is written against that behaviour —
 * a client that returned the errors instead would exercise code that does not
 * exist. The log is what the assertions read.
 */
const createLiveClient = (remote: Remote): LiveClient => {
  const sent: Sent[] = [];

  const send = async (
    kind: 'query' | 'mutation',
    request: Record<string, unknown>,
  ): Promise<unknown> => {
    const document = toDocument(kind, request);

    const response = await fetch(`${remote.apiUrl}/graphql`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${remote.apiKey}`,
      },
      body: JSON.stringify({ query: document }),
    });

    const body = (await response.json()) as {
      data?: Record<string, unknown> | null;
      errors?: readonly { message?: string }[];
    };

    const errors = (body.errors ?? []).map(
      (error) => error.message ?? 'unnamed GraphQL error',
    );

    sent.push({ kind, request, document, errors });

    if (errors.length > 0) {
      throw new Error(errors.join('; '));
    }

    return body.data ?? {};
  };

  return {
    sent,
    query: (request) => send('query', request),
    // Recorded and not sent. See the header: this suite must be safe to point at
    // a workspace somebody cares about, and every path it drives is a read.
    mutation: async (request) => {
      sent.push({
        kind: 'mutation',
        request,
        document: toDocument('mutation', request),
        errors: [],
      });

      return {};
    },
  };
};

/* -------------------------------------------------------------------------- */
/* Attribution                                                                 */
/* -------------------------------------------------------------------------- */

/** The same request with every `filter` and `orderBy` argument removed. */
const withoutArguments = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(withoutArguments);
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([name, child]) => [
      name,
      name === '__args' && isRecord(child)
        ? Object.fromEntries(
            Object.entries(child).filter(
              ([argument]) => argument !== 'filter' && argument !== 'orderBy',
            ),
          )
        : withoutArguments(child),
    ]),
  );
};

/**
 * The first error message a document produces, or null if it was accepted.
 *
 * `rejects` answers whether Twenty refused. This answers *how it said so*, and
 * the distinction became load-bearing when `src/backfill/field-mapping-check.ts`
 * started classifying rejections by their text. That check is the only thing
 * standing between an admin and a mistyped field mapping scoring their whole
 * workspace as blanks — and because it fails open, a Twenty release that reworded
 * its "no such field" error would switch the check off silently. Exactly the
 * failure mode this whole file exists to make loud.
 */
const rejectionMessage = async (
  remote: Remote,
  document: string,
): Promise<string | null> => {
  const response = await fetch(`${remote.apiUrl}/graphql`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${remote.apiKey}`,
    },
    body: JSON.stringify({ query: document }),
  });

  const body = (await response.json()) as {
    errors?: readonly { message?: unknown }[];
  };

  const first = (body.errors ?? [])[0];

  if (first === undefined) {
    return null;
  }

  return typeof first.message === 'string' ? first.message : '';
};

const rejects = async (remote: Remote, document: string): Promise<boolean> =>
  (await rejectionMessage(remote, document)) !== null;

interface Verdict {
  readonly document: string;
  readonly errors: readonly string[];
  /** True when stripping `filter` and `orderBy` makes the request acceptable. */
  readonly causedByArguments: boolean;
}

/**
 * Judge every rejected request in a log.
 *
 * Bisecting rather than reading the error text: Twenty's messages are good
 * (`Object taskTarget doesn't have any "opportunityId" field.`,
 * `Field "x" does not exist or is not sortable`,
 * `Operator "ilike" is not valid for field "id" of type UUID`) but they are not a
 * contract, and a suite that greps them would go quiet the first time one was
 * reworded. Removing the arguments and asking again cannot be reworded.
 */
const judge = async (remote: Remote, sent: readonly Sent[]): Promise<Verdict[]> => {
  const verdicts: Verdict[] = [];

  for (const call of sent) {
    if (call.errors.length === 0) {
      continue;
    }

    const stripped = toDocument(
      call.kind,
      withoutArguments(call.request) as Record<string, unknown>,
    );

    verdicts.push({
      document: call.document,
      errors: call.errors,
      causedByArguments:
        stripped !== call.document && !(await rejects(remote, stripped)),
    });
  }

  return verdicts;
};

/**
 * Everything a failure needs to be actionable: the request, and the complaint.
 */
const explain = (verdicts: readonly Verdict[]): string =>
  verdicts
    .map(
      (verdict) =>
        `\n  rejected: ${verdict.errors.join('; ')}\n  request : ${verdict.document}`,
    )
    .join('\n');

/**
 * Run a read path and hand back what it put on the wire.
 *
 * `drive` swallows nothing and asserts nothing: a path may legitimately throw
 * (`loadPerson` does not catch), and a path that threw still sent the request
 * that is the point of the exercise.
 */
const drive = async (
  remote: Remote,
  path: (client: LiveClient) => Promise<unknown>,
): Promise<Sent[]> => {
  const client = createLiveClient(remote);

  try {
    await path(client);
  } catch {
    // The log is the observation. See above.
  }

  return client.sent;
};

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A well-formed id that matches nothing.
 *
 * Every filter in this app is validated against the *schema* before it is run
 * against the data, so an id that finds no rows exercises exactly the same
 * validation as one that does — and keeps the suite independent of what happens
 * to be in the workspace.
 */
const ABSENT_ID = '00000000-0000-4000-8000-000000000000';

const remote = REMOTE as Remote;

/* -------------------------------------------------------------------------- */
/* The suite                                                                   */
/* -------------------------------------------------------------------------- */

describe.skipIf(!LIVE)('every read this app issues', () => {
  /**
   * One expectation, applied to every path below: nothing Greenlight sends may be
   * rejected because of its `filter` or its `orderBy`.
   */
  const assertArgumentsAccepted = async (sent: readonly Sent[]): Promise<void> => {
    expect(sent.length).toBeGreaterThan(0);

    const verdicts = (await judge(remote, sent)).filter(
      (verdict) => verdict.causedByArguments,
    );

    expect(
      verdicts,
      `filter or orderBy rejected by the live schema:${explain(verdicts)}`,
    ).toEqual([]);
  };

  const assertReadOnly = (sent: readonly Sent[]): void => {
    expect(
      sent.filter((call) => call.kind === 'mutation').map((call) => call.document),
    ).toEqual([]);
  };

  describe('pipeline-store', () => {
    it('pages People and Opportunities newest-first', async () => {
      const sent = await drive(remote, async (client) => {
        await walkConnection(client, {
          connection: 'people',
          selection: pipelinePersonSelection(),
          pages: 2,
          label: 'people',
        });

        await walkConnection(client, {
          connection: 'opportunities',
          selection: pipelineOpportunitySelection({
            withOwner: true,
            withAe: true,
          }),
          pages: 2,
          label: 'deals',
        });
      });

      await assertArgumentsAccepted(sent);
      assertReadOnly(sent);
    });

    it('reads its configuration record', async () => {
      const sent = await drive(remote, (client) => readPipelineConfigRecord(client));

      await assertArgumentsAccepted(sent);
    });

    /**
     * The probe whose whole job is to have a filter rejected on a workspace
     * without the column, so `assertArgumentsAccepted` is deliberately not
     * applied — a rejection here is the answer, not a defect.
     *
     * What *is* asserted is that it can still say no. Before this was a filter it
     * asked for `ownerId` in the selection set, which Twenty accepts on every
     * object in existence, so the probe returned `true` everywhere and the board
     * asserted "nobody owns this deal" against workspaces that have no owner
     * field. If Twenty ever started validating selections, or stopped validating
     * filters, this would be the first thing to know.
     */
    it('answers the owner probe from something Twenty actually checks', async () => {
      const sent = await drive(remote, (client) => probeOpportunityOwner(client));

      expect(sent).toHaveLength(1);
      expect(sent[0]?.document).toContain('filter:');
      expect(sent[0]?.document).toContain('ownerId');

      // The instance under test may or may not have the column; both answers are
      // legitimate. What must hold is that the probe is capable of both, which a
      // selection-set probe is not.
      const nonesuch = await rejects(
        remote,
        'query { opportunities(first: 1, filter: { greenlightNoSuchColumn: { is: "NOT_NULL" } }) { edges { node { id } } } }',
      );

      expect(
        nonesuch,
        'a filter on a column Opportunity does not have was accepted — the owner probe can no longer say no',
      ).toBe(true);
    });

    it('reads the activity on a batch of deals', async () => {
      const sent = await drive(remote, (client) =>
        loadOpportunityActivity(client, [ABSENT_ID]),
      );

      await assertArgumentsAccepted(sent);
      assertReadOnly(sent);
    });

    it('reads single records and a person’s deals', async () => {
      const sent = await drive(remote, async (client) => {
        await loadPerson(client, ABSENT_ID);
        await loadOpportunity(client, ABSENT_ID, {
          withOwner: true,
          withAe: true,
        });
        await loadOpportunity(client, ABSENT_ID, {
          withOwner: false,
          withAe: false,
        });
        await loadOpportunitiesForPerson(client, ABSENT_ID, {
          withOwner: true,
          withAe: true,
        });
      });

      await assertArgumentsAccepted(sent);
    });

    it('matches companies and people during a capture', async () => {
      const sent = await drive(remote, async (client) => {
        await findCompanyByDomain(client, 'northwind.example');
        await findCompanyByName(client, 'Northwind Logistics');
        await findPersonByEmail(client, 'nobody@northwind.example');
      });

      await assertArgumentsAccepted(sent);
      assertReadOnly(sent);
    });
  });

  describe('backfill', () => {
    /**
     * Driven through `buildPageRequest` rather than through `runBackfillTick`,
     * because the tick writes. The builder is where every filter and every
     * `orderBy` in the backfill is decided, and the ladder in `PAGE_ATTEMPTS` is
     * walked here in full — including the unordered rung, which only `unscored`
     * mode is allowed to take and which would otherwise never be sent by anything.
     */
    it('sends a page and a count Twenty accepts, on every rung of the ladder', async () => {
      const sent = await drive(remote, async (client) => {
        for (const mode of BACKFILL_MODES) {
          await client.query(buildCountRequest(mode));

          for (const attempt of PAGE_ATTEMPTS) {
            if (!attempt.ordered && mode !== 'unscored') {
              continue;
            }

            await client.query(
              buildPageRequest({
                mode,
                // A non-null `createdAt` is what puts the `gte` comparator into
                // the filter; an empty cursor would leave it out and the rung
                // would prove less than it looks like it does.
                cursor: { createdAt: '2026-01-01T00:00:00.000Z', ids: [] },
                chunkSize: 1,
                selection: backfillPersonSelection(
                  attempt.useExtraFields ? ['jobTitle'] : [],
                ),
                ordered: attempt.ordered,
              }),
            );
          }
        }
      });

      await assertArgumentsAccepted(sent);
      assertReadOnly(sent);
    });
  });

  describe('icp-run', () => {
    /**
     * `probeCompanyFields` is a wall of deliberate rejections on a stock
     * workspace — `industry`, `sector`, `vertical` and the rest do not exist and
     * *must* be refused — so what is asserted is the shape of the probe, not that
     * it succeeded.
     *
     * The one that matters: at least one candidate has to come back rejected. If
     * every probe were accepted, the probe would have stopped being a question,
     * which is the exact state it was in when it asked in the selection set.
     */
    it('discovers Company fields with a question Twenty can answer no to', async () => {
      const sent = await drive(remote, (client) => probeCompanyFields(client));

      expect(sent.length).toBeGreaterThan(0);
      expect(sent.every((call) => call.document.includes('filter:'))).toBe(true);
      expect(
        sent.some((call) => call.errors.length > 0),
        'every Company field probe was accepted — on a stock workspace that means the probe is not asking anything',
      ).toBe(true);
      assertReadOnly(sent);
    });

    it('samples the workspace to propose a profile', async () => {
      const sent = await drive(remote, (client) =>
        proposeIcpForWorkspace({ client, now: new Date() }),
      );

      // The field probes inside this path are allowed to be refused; the sample
      // pages that follow them are not, and they are the ones carrying `orderBy`
      // and the `createdAt` cursor.
      const pages = sent.filter((call) => call.document.includes('orderBy'));

      expect(pages.length).toBeGreaterThan(0);
      await assertArgumentsAccepted(pages);
      assertReadOnly(sent);
    });
  });

  describe('the selections every other handler shares', () => {
    /**
     * `enrich-run.ts`, `enrich-request-run.ts`, `release-lead.logic-function.ts`,
     * `scoring-run.ts` and `suppression-run.ts` all read one record by id and
     * differ only in what they select. Their loaders are module-private and their
     * entrypoints call providers, take licences and write, so the reads are
     * assembled here from the selection builders those files export.
     *
     * That is a copy, and a copy is the weaker kind of proof — it goes stale if a
     * handler changes its filter. It is worth having anyway: `{ id: { eq } }` is
     * the most-used filter in the app, and this is what would notice if Twenty
     * ever stopped accepting it.
     */
    it('reads one record by id, with every selection the app uses', async () => {
      const sent = await drive(remote, async (client) => {
        for (const [connection, selection] of [
          ['people', pipelinePersonSelection()],
          ['people', suppressionLeadSelection()],
          ['people', backfillPersonSelection()],
          ['opportunities', pipelineOpportunitySelection({ withOwner: false, withAe: false })],
          ['companies', { id: true, name: true }],
        ] as const) {
          await client.query({
            [connection]: {
              __args: { filter: { id: { eq: ABSENT_ID } }, first: 1 },
              edges: { node: selection },
            },
          });
        }

        await client.query({
          greenlightConfigs: { edges: { node: greenlightConfigSelection() } },
        });
      });

      await assertArgumentsAccepted(sent);
    });
  });

  /**
   * The contract itself, stated as a test.
   *
   * Everything above is downstream of these two facts. If either flips, the
   * failures above become confusing — a probe that silently starts answering
   * `true` everywhere, or a page that starts being rejected — and this is the
   * test that says which one moved.
   */
  describe('the asymmetry every one of these bugs came from', () => {
    it('validates a filter against the object’s schema', async () => {
      expect(
        await rejects(
          remote,
          'query { taskTargets(first: 1, filter: { opportunityId: { in: ["' +
            ABSENT_ID +
            '"] } }) { edges { node { id } } } }',
        ),
        'taskTarget accepted a filter on `opportunityId` — the original bug is no longer a bug, and `loadOpportunityActivity` could go back to a join',
      ).toBe(true);
    });

    it('does not validate a selection set', async () => {
      expect(
        await rejects(
          remote,
          'query { people(first: 1) { edges { node { id greenlightNoSuchColumn } } } }',
        ),
        'Twenty now rejects unknown selection fields — the field probes in `icp-run.ts` and `pipeline-store.ts` could be simplified, and the fall-back rungs they stopped relying on are live again',
      ).toBe(false);
    });

    /*
     * The two below guard the *wording*, not the behaviour, because
     * `field-mapping-check.ts` classifies a rejection by reading its text — the
     * only signal Twenty offers for "is this a real column".
     *
     * That check fails open by design: anything it cannot classify is reported to
     * nobody and scoring proceeds untouched. Which means a reworded error does
     * not break it, it *disables* it, and the admin whose mapping has a typo goes
     * back to having their whole workspace scored as blanks with no warning. A
     * silent regression in the thing built to end a silent regression.
     *
     * One test proves it can still fire. The other proves it cannot fire wrongly
     * — telling somebody that `emails`, which they can see on the record page,
     * does not exist would turn every future notice into furniture.
     */
    it('rejects an unknown filter field in words the mapping check can read', async () => {
      const message = await rejectionMessage(
        remote,
        'query { people(first: 1, filter: { greenlightNoSuchColumn: { is: "NOT_NULL" } }) { edges { node { id } } } }',
      );

      expect(
        classifyProbeRejection('greenlightNoSuchColumn', message ?? ''),
        `Twenty reworded its "no such field" rejection to «${message}». ABSENT_PHRASES in src/backfill/field-mapping-check.ts no longer recognises it, so the mapping check in startBackfill has quietly switched itself off — fail-open as designed, and invisible everywhere except here.`,
      ).toBe('absent');
    });

    it('rejects `is` on a composite in words the mapping check reads as present', async () => {
      const message = await rejectionMessage(
        remote,
        'query { people(first: 1, filter: { emails: { is: "NOT_NULL" } }) { edges { node { id } } } }',
      );

      expect(
        classifyProbeRejection('emails', message ?? ''),
        `A composite column now classifies as «${classifyProbeRejection('emails', message ?? '')}» off the message «${message}». If that is "absent", the check will tell admins a field they can see on the record page does not exist, and they will stop reading its notices.`,
      ).toBe('present');
    });
  });
});

beforeAll(() => {
  if (LIVE) {
    // eslint-disable-next-line no-console
    console.log(`\n──── api-contract.live-test → ${remote.apiUrl} ────\n`);
  }
});
