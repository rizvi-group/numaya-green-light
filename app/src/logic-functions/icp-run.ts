/**
 * The I/O half of the ICP review, kept out of the `define*` file so the whole
 * propose → preview → apply story can be exercised against a fake API client.
 *
 * Everything about *what the data means* is pure and lives in `src/icp/`. This
 * module does four things and no thinking: discover which fields the workspace's
 * Company object actually has, read a bounded sample of Companies and People,
 * write the profile the human accepted, and hand a re-score to the backfill that
 * already exists.
 *
 * ## Discovering the industry field, and why it needs discovering
 *
 * Twenty's stock Company object has no industry field. Where a workspace has
 * one, it is a custom field whose name that workspace chose, and an unknown
 * field name fails the entire GraphQL request rather than coming back empty. So
 * the candidates are probed one at a time with the cheapest possible query, and
 * the ones that answer are the ones the sample selects. Fourteen probes at
 * `first: 1` is the price of not requiring the admin to tell us their schema
 * before we can tell them anything — and it is paid once, when a human clicks
 * Suggest, never on a scoring path.
 *
 * ## Request budget
 *
 * A `propose` costs at most 14 probes + 10 company pages + 5 lead pages + 2
 * counts + 1 config read = 32 requests against a 100/minute limit, once, on a
 * human's click. `status` and `preview` cost 1 and 7. Nothing here runs on a
 * schedule, so none of it competes with live scoring except while somebody is
 * looking at the panel.
 *
 * ## Nothing here throws
 *
 * Every read degrades to "less evidence, and a note saying so"; every write
 * failure is reported to the panel as a failure with the record unchanged. A
 * profile that could not be written must never look like one that was.
 */

import {
  buildCountRequest,
  backfillPersonSelection,
  configuredSelectionFields,
  readTotalCount,
} from 'src/backfill/backfill-plan';
import {
  COMPANY_ADDRESS_REGION_PATH,
  COMPANY_INDUSTRY_FIELD_CANDIDATES,
  COMPANY_REGION_FIELD_CANDIDATES,
  COMPANY_SIZE_FIELD_CANDIDATES,
  analyseCompanies,
  toCompanyFacts,
  type CompanyFacts,
  type CompanyFieldPaths,
} from 'src/icp/icp-analysis';
import { previewIcpImpact, type IcpImpact } from 'src/icp/icp-impact';
import {
  proposeIcp,
  toIcpConfigPatch,
  type IcpProposal,
  type IcpSelection,
} from 'src/icp/icp-proposal';
import {
  ICP_REVIEW_FIELD_NAMES,
  readIcpStatus,
  type IcpStatus,
} from 'src/icp/icp-status';
import type { IcpCommand } from 'src/icp/icp-command';
import { ICP_REVIEW_DECISION_VALUES } from 'src/constants/icp-identifiers';
import {
  startBackfill,
  type BackfillStateStore,
} from 'src/logic-functions/backfill-run';
import {
  describeError,
  isPlainRecord,
  logGreenlight,
  oldestByCreatedAt,
  readConnectionNodes,
  type GreenlightApiClient,
} from 'src/logic-functions/greenlight-api';
import { greenlightConfigSelection } from 'src/logic-functions/greenlight-config-record';
import { SCORING_ENGINE_VERSION } from 'src/scoring';

/* -------------------------------------------------------------------------- */
/* Sample sizes                                                                */
/* -------------------------------------------------------------------------- */

/** Twenty's documented page ceiling. */
const PAGE_SIZE = 60;

/**
 * Ten pages of companies and five of people.
 *
 * Six hundred companies is enough that a real cluster is unmistakable and a
 * fabricated one is not, and three hundred leads puts the impact estimate's
 * sampling error at a couple of percent — well inside the precision anybody
 * needs to answer "is this safe to apply". Both numbers are reported alongside
 * every figure derived from them, so a workspace larger than the sample sees
 * plainly that it is looking at a sample.
 */
export const COMPANY_SAMPLE_PAGES = 10;
export const LEAD_SAMPLE_PAGES = 5;

export const COMPANY_SAMPLE_LIMIT = COMPANY_SAMPLE_PAGES * PAGE_SIZE;
export const LEAD_SAMPLE_LIMIT = LEAD_SAMPLE_PAGES * PAGE_SIZE;

/* -------------------------------------------------------------------------- */
/* Result shape                                                                */
/* -------------------------------------------------------------------------- */

export interface IcpControlBody {
  readonly outcome: string;
  readonly message: string;
  /** How much of the model is idle. Always present when the config is readable. */
  readonly status: IcpStatus | null;
  readonly proposal: IcpProposal | null;
  readonly impact: IcpImpact | null;
  /** What a preview or apply was actually computed against. */
  readonly selection: IcpSelection | null;
  /** Entries the parser had to drop, in the admin's words. */
  readonly warnings: readonly string[];
  /** What the data could not tell us, and why. Never silent. */
  readonly notes: readonly string[];
  readonly rescore: { readonly started: boolean; readonly message: string } | null;
}

export interface IcpControlResult {
  readonly status: number;
  readonly body: IcpControlBody;
}

const result = (
  status: number,
  body: Partial<IcpControlBody> & { outcome: string; message: string },
): IcpControlResult => ({
  status,
  body: {
    status: null,
    proposal: null,
    impact: null,
    selection: null,
    warnings: [],
    notes: [],
    rescore: null,
    ...body,
  },
});

/* -------------------------------------------------------------------------- */
/* Config record                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The config record, including the two review columns this feature adds.
 *
 * A selection of its own rather than `greenlightConfigSelection()` for one
 * reason: a workspace upgraded from a release before those columns existed still
 * has them, because metadata sync creates them — but a workspace running an
 * older *manifest* does not, and asking for a column that is not there fails the
 * whole query and would take the panel down with it. So the extended selection
 * is tried first and the shipped one is the fall-back, which also means this file
 * needs no knowledge of which release the workspace is on.
 */
const loadIcpConfigRecord = async (
  client: GreenlightApiClient,
): Promise<{
  record: Record<string, unknown> | null;
  reviewFieldsAvailable: boolean;
}> => {
  const extended = {
    ...greenlightConfigSelection(),
    ...Object.fromEntries(ICP_REVIEW_FIELD_NAMES.map((name) => [name, true])),
  };

  try {
    const response = await client.query({
      greenlightConfigs: { edges: { node: extended } },
    });

    return {
      record: oldestByCreatedAt(readConnectionNodes(response, 'greenlightConfigs')),
      reviewFieldsAvailable: true,
    };
  } catch (error) {
    logGreenlight('icp_config_extended_read_failed', {
      error: describeError(error),
    });
  }

  const response = await client.query({
    greenlightConfigs: { edges: { node: greenlightConfigSelection() } },
  });

  return {
    record: oldestByCreatedAt(readConnectionNodes(response, 'greenlightConfigs')),
    reviewFieldsAvailable: false,
  };
};

/* -------------------------------------------------------------------------- */
/* Field discovery                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Did that query actually answer, or did it come back without data?
 *
 * A rejected GraphQL request normally throws out of the client, but a transport
 * that returns `{ errors, data: null }` without throwing would make every probe
 * look like a success and put non-existent field names into the sample query —
 * which would then fail for real, with no fall-back left. Checking that the
 * connection is present costs nothing and closes that path.
 */
const answered = (response: unknown): boolean =>
  isPlainRecord(response) && isPlainRecord(response['companies']);

const probeField = async (
  client: GreenlightApiClient,
  selection: Record<string, unknown>,
): Promise<boolean> => {
  try {
    const response = await client.query({
      companies: {
        __args: { first: 1 },
        edges: { node: { id: true, ...selection } },
      },
    });

    return answered(response);
  } catch {
    return false;
  }
};

export interface CompanyProbe {
  readonly paths: CompanyFieldPaths;
  /** Field names to put in the sample's selection set. */
  readonly selection: Record<string, unknown>;
  readonly notes: readonly string[];
}

/**
 * Find out which of the candidate fields this workspace's Company object has.
 *
 * Reported rather than assumed: the panel says "industry was read from
 * `sector`", or says that no industry-like field exists at all, which is a
 * different and much more actionable problem than "we found no industries".
 */
export const probeCompanyFields = async (
  client: GreenlightApiClient,
): Promise<CompanyProbe> => {
  const selection: Record<string, unknown> = { id: true, name: true };
  const industry: string[] = [];
  const region: string[] = [];
  const size: string[] = [];
  const notes: string[] = [];

  for (const candidate of COMPANY_INDUSTRY_FIELD_CANDIDATES) {
    if (await probeField(client, { [candidate]: true })) {
      selection[candidate] = true;
      industry.push(candidate);
    }
  }

  for (const candidate of COMPANY_REGION_FIELD_CANDIDATES) {
    if (await probeField(client, { [candidate]: true })) {
      selection[candidate] = true;
      region.push(candidate);
    }
  }

  if (await probeField(client, { address: { addressCountry: true } })) {
    selection['address'] = { addressCountry: true };
    region.push(COMPANY_ADDRESS_REGION_PATH);
  }

  for (const candidate of COMPANY_SIZE_FIELD_CANDIDATES) {
    if (await probeField(client, { [candidate]: true })) {
      selection[candidate] = true;
      size.push(candidate);
    }
  }

  if (industry.length === 0) {
    notes.push(
      'This workspace has no industry field on Company — Twenty does not ship one, and no custom field named industry, sector, vertical or similar was found. Nothing can be proposed for industry until one exists and is filled in.',
    );
  } else {
    notes.push(`Industry read from Company.${industry.join(', Company.')}.`);
  }

  if (region.length === 0) {
    notes.push(
      'No country or region field answered on Company, so nothing can be proposed for region.',
    );
  } else {
    notes.push(`Region read from Company.${region.join(', Company.')}.`);
  }

  if (size.length === 0) {
    notes.push(
      'No employee-count field answered on Company, so nothing can be proposed for company size.',
    );
  } else {
    notes.push(`Company size read from Company.${size.join(', Company.')}.`);
  }

  return { paths: { industry, region, size }, selection, notes };
};

/* -------------------------------------------------------------------------- */
/* Samples                                                                     */
/* -------------------------------------------------------------------------- */

interface SampleResult {
  readonly nodes: readonly Record<string, unknown>[];
  readonly notes: readonly string[];
}

/**
 * Walk a connection newest-first, keyed on `createdAt`.
 *
 * Newest-first, and stated in the panel copy, because if only part of the book
 * can be examined the recent part is the more honest answer to "who do we sell
 * to now". A dead segment from four years ago is exactly the kind of evidence
 * that should not be shaping today's profile.
 *
 * If the ordered query is rejected — `orderBy` enum spellings are the one thing
 * in here that cannot be checked without a live schema — it falls back to a
 * single unordered page and says so, because a smaller honest sample beats a
 * blank panel.
 */
const fetchSample = async (
  client: GreenlightApiClient,
  {
    connection,
    selection,
    pages,
    label,
  }: {
    connection: string;
    selection: Record<string, unknown>;
    pages: number;
    label: string;
  },
): Promise<SampleResult> => {
  const notes: string[] = [];
  const nodes: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < pages; page += 1) {
    const args: Record<string, unknown> = {
      first: PAGE_SIZE,
      orderBy: [{ createdAt: 'DescNullsLast' }],
    };

    if (cursor !== null) {
      args['filter'] = { createdAt: { lte: cursor } };
    }

    let batch: Record<string, unknown>[];

    try {
      const response = await client.query({
        [connection]: { __args: args, edges: { node: selection } },
      });

      batch = readConnectionNodes(response, connection);
    } catch (error) {
      logGreenlight('icp_sample_page_failed', {
        connection,
        page,
        error: describeError(error),
      });

      if (page > 0) {
        notes.push(
          `Reading ${label} stopped early after ${nodes.length} records; the figures below are based on those.`,
        );
        break;
      }

      const fallback = await fetchUnorderedPage(client, connection, selection);

      notes.push(
        fallback.length === 0
          ? `Greenlight could not read ${label} from this workspace just now.`
          : `Greenlight could not page through ${label}, so it examined ${fallback.length} records rather than up to ${pages * PAGE_SIZE}.`,
      );

      return { nodes: fallback, notes };
    }

    let added = 0;

    for (const node of batch) {
      const id = typeof node['id'] === 'string' ? node['id'] : null;

      if (id !== null && seen.has(id)) {
        continue;
      }

      if (id !== null) {
        seen.add(id);
      }

      nodes.push(node);
      added += 1;
    }

    const last = batch[batch.length - 1];
    const lastCreatedAt =
      last !== undefined && typeof last['createdAt'] === 'string'
        ? last['createdAt']
        : null;

    // Short page, no usable cursor, or a page that advanced nothing: all three
    // mean the walk is finished. The last one is what stops an unmoving cursor
    // spinning for ten pages over the same sixty records.
    if (batch.length < PAGE_SIZE || lastCreatedAt === null || added === 0) {
      break;
    }

    cursor = lastCreatedAt;
  }

  return { nodes, notes };
};

const fetchUnorderedPage = async (
  client: GreenlightApiClient,
  connection: string,
  selection: Record<string, unknown>,
): Promise<Record<string, unknown>[]> => {
  try {
    const response = await client.query({
      [connection]: { __args: { first: PAGE_SIZE }, edges: { node: selection } },
    });

    return readConnectionNodes(response, connection);
  } catch (error) {
    logGreenlight('icp_sample_fallback_failed', {
      connection,
      error: describeError(error),
    });

    return [];
  }
};

/** Best effort. A total drives an extrapolation; it must never stop the panel. */
const countConnection = async (
  client: GreenlightApiClient,
  connection: 'companies' | 'people',
): Promise<number | null> => {
  try {
    const request =
      connection === 'people'
        ? buildCountRequest('all')
        : { companies: { totalCount: true } };

    const response = await client.query(request);

    if (connection === 'people') {
      return readTotalCount(response);
    }

    const node = isPlainRecord(response) ? response['companies'] : null;
    const total = isPlainRecord(node) ? node['totalCount'] : null;

    return typeof total === 'number' && Number.isFinite(total) && total >= 0
      ? Math.floor(total)
      : null;
  } catch (error) {
    logGreenlight('icp_count_failed', {
      connection,
      error: describeError(error),
    });

    return null;
  }
};

/* -------------------------------------------------------------------------- */
/* Deps                                                                        */
/* -------------------------------------------------------------------------- */

export interface IcpDeps {
  readonly client: GreenlightApiClient;
  /** Only touched when the admin asks for a re-score. */
  readonly store: BackfillStateStore;
  readonly now: Date;
  /** Server-derived. Never taken from the request body. */
  readonly requestedBy: string;
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                     */
/* -------------------------------------------------------------------------- */

const CONFIG_MISSING_MESSAGE =
  'Greenlight has no configuration record on this workspace yet, so there is nothing to review. It is created when the app is installed; if this persists, re-run the install hook.';

export const readIcpReviewStatus = async ({
  client,
}: Pick<IcpDeps, 'client'>): Promise<IcpControlResult> => {
  let record: Record<string, unknown> | null;

  try {
    record = (await loadIcpConfigRecord(client)).record;
  } catch (error) {
    return result(200, {
      outcome: 'config_unreadable',
      message: `Greenlight could not read its configuration record, so it cannot tell you whether your profile is set. Scoring is unaffected. (${describeError(error)})`,
    });
  }

  if (record === null) {
    return result(200, { outcome: 'config_missing', message: CONFIG_MISSING_MESSAGE });
  }

  return result(200, {
    outcome: 'ok',
    message: '',
    status: readIcpStatus(record),
  });
};

/**
 * Derive a profile from the workspace's own data and measure what applying it
 * would do. Nothing is written.
 */
export const proposeIcpForWorkspace = async ({
  client,
  now,
}: Pick<IcpDeps, 'client' | 'now'>): Promise<IcpControlResult> => {
  let record: Record<string, unknown> | null;

  try {
    record = (await loadIcpConfigRecord(client)).record;
  } catch (error) {
    return result(200, {
      outcome: 'config_unreadable',
      message: `Greenlight could not read its configuration record. (${describeError(error)})`,
    });
  }

  if (record === null) {
    return result(200, { outcome: 'config_missing', message: CONFIG_MISSING_MESSAGE });
  }

  const status = readIcpStatus(record);
  const probe = await probeCompanyFields(client);
  const totalCompanies = await countConnection(client, 'companies');

  const sample = await fetchSample(client, {
    connection: 'companies',
    selection: { ...probe.selection, createdAt: true },
    pages: COMPANY_SAMPLE_PAGES,
    label: 'your companies',
  });

  const companies: CompanyFacts[] = sample.nodes.map((node) =>
    toCompanyFacts(node, probe.paths),
  );

  const proposal = proposeIcp(
    analyseCompanies({ companies, totalCompanies, paths: probe.paths }),
  );

  const notes = [...probe.notes, ...sample.notes];

  if (
    totalCompanies !== null &&
    totalCompanies > companies.length &&
    companies.length > 0
  ) {
    notes.push(
      `Based on the ${companies.length.toLocaleString('en-US')} most recently added of your ${totalCompanies.toLocaleString('en-US')} companies.`,
    );
  }

  const impact = await measureImpact({
    client,
    record,
    now,
    selection: proposal.selection,
  });

  return result(200, {
    outcome: 'proposed',
    message: '',
    status,
    proposal,
    impact: impact.impact,
    selection: proposal.selection,
    notes: [...notes, ...impact.notes],
  });
};

const measureImpact = async ({
  client,
  record,
  now,
  selection,
}: {
  client: GreenlightApiClient;
  record: Record<string, unknown>;
  now: Date;
  selection: IcpSelection;
}): Promise<{ impact: IcpImpact; notes: readonly string[] }> => {
  const totalLeads = await countConnection(client, 'people');

  const sample = await fetchSample(client, {
    connection: 'people',
    // Parity with the scoring path is the whole point: the same selection the
    // backfill uses, including the workspace's own configured field names, so a
    // preview measures what scoring will actually see rather than a richer
    // record this module could have fetched and the engine never will.
    selection: {
      ...backfillPersonSelection(configuredSelectionFields(record)),
      createdAt: true,
    },
    pages: LEAD_SAMPLE_PAGES,
    label: 'your leads',
  });

  const notes = [...sample.notes];

  if (
    totalLeads !== null &&
    totalLeads > sample.nodes.length &&
    sample.nodes.length > 0
  ) {
    notes.push(
      `Impact measured on the ${sample.nodes.length.toLocaleString('en-US')} most recently added of your ${totalLeads.toLocaleString('en-US')} leads, then scaled.`,
    );
  }

  return {
    impact: previewIcpImpact({
      leads: sample.nodes,
      configRecord: record,
      selection,
      now,
      totalLeads,
    }),
    notes,
  };
};

/** Score a sample against an edited profile. Nothing is written. */
export const previewIcpForWorkspace = async ({
  client,
  now,
  selection,
  warnings,
}: Pick<IcpDeps, 'client' | 'now'> & {
  selection: IcpSelection;
  warnings: readonly string[];
}): Promise<IcpControlResult> => {
  let record: Record<string, unknown> | null;

  try {
    record = (await loadIcpConfigRecord(client)).record;
  } catch (error) {
    return result(200, {
      outcome: 'config_unreadable',
      message: `Greenlight could not read its configuration record. (${describeError(error)})`,
    });
  }

  if (record === null) {
    return result(200, { outcome: 'config_missing', message: CONFIG_MISSING_MESSAGE });
  }

  const impact = await measureImpact({ client, record, now, selection });

  return result(200, {
    outcome: 'previewed',
    message: '',
    status: readIcpStatus(record),
    impact: impact.impact,
    selection,
    warnings,
    notes: impact.notes,
  });
};

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

const writeIcpAuditRow = async (
  client: GreenlightApiClient,
  now: Date,
  summary: string,
  detail: Record<string, unknown>,
): Promise<void> => {
  try {
    await client.mutation({
      createGreenlightAuditLog: {
        __args: {
          data: {
            name: summary,
            // `CONFIG_CHANGED` is what it is: the configuration changed. Same
            // precedent as the install hook and the backfill, and the row's
            // `ruleTrace` carries the profile that was written together with the
            // impact estimate it was accepted against — so "who decided this,
            // when, and what were they told it would do" has one answer.
            eventType: 'CONFIG_CHANGED',
            occurredAt: now.toISOString(),
            leadObjectNameSingular: '',
            leadRecordId: null,
            leadDisplayName: '',
            actorType: 'USER',
            actorDisplayName: String(detail['requestedBy'] ?? 'Unknown'),
            ruleTrace: detail,
            score: null,
            band: 'UNSCORED',
            decision: 'UNSCORED',
            overrideReason: '',
            traceId: '',
          },
        },
        id: true,
      },
    });
  } catch (error) {
    logGreenlight('icp_audit_write_failed', {
      summary,
      error: describeError(error),
    });
  }
};

/**
 * Patch the config record, tolerating a workspace whose metadata predates the
 * two review columns.
 *
 * The profile is what matters; the review stamp is provenance. If the stamp
 * cannot be written the profile still must be, so the write is retried without
 * it rather than abandoned — and the caller is told, because a panel that keeps
 * saying "not reviewed" after a successful apply needs an explanation on screen
 * rather than a shrug.
 */
const patchConfig = async (
  client: GreenlightApiClient,
  configId: string,
  patch: Record<string, unknown>,
  reviewPatch: Record<string, unknown>,
): Promise<{ ok: true; reviewRecorded: boolean } | { ok: false; error: string }> => {
  try {
    await client.mutation({
      updateGreenlightConfig: {
        __args: { id: configId, data: { ...patch, ...reviewPatch } },
        id: true,
      },
    });

    return { ok: true, reviewRecorded: true };
  } catch (error) {
    logGreenlight('icp_config_write_with_review_failed', {
      configId,
      error: describeError(error),
    });
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: 'the review columns are not available' };
  }

  try {
    await client.mutation({
      updateGreenlightConfig: { __args: { id: configId, data: patch }, id: true },
    });

    return { ok: true, reviewRecorded: false };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
};

const configIdOf = (record: Record<string, unknown>): string | null =>
  typeof record['id'] === 'string' && record['id'].length > 0
    ? record['id']
    : null;

export const applyIcpToWorkspace = async ({
  client,
  store,
  now,
  requestedBy,
  selection,
  warnings,
  rescore,
}: IcpDeps & {
  selection: IcpSelection;
  warnings: readonly string[];
  rescore: boolean;
}): Promise<IcpControlResult> => {
  let record: Record<string, unknown> | null;

  try {
    record = (await loadIcpConfigRecord(client)).record;
  } catch (error) {
    return result(502, {
      outcome: 'config_unreadable',
      message: `Greenlight could not read its configuration record, so nothing was changed. (${describeError(error)})`,
    });
  }

  if (record === null) {
    return result(200, { outcome: 'config_missing', message: CONFIG_MISSING_MESSAGE });
  }

  const configId = configIdOf(record);

  if (configId === null) {
    return result(502, {
      outcome: 'config_unusable',
      message:
        'Greenlight found a configuration record without an id, so it did not write to it. Nothing has changed.',
    });
  }

  // Measured again here, server-side, rather than trusting the number the panel
  // was showing. The sample it is measured on is the current one, and the
  // figure lands in the audit row — so the record says what the person was told
  // this would do at the moment they said yes, not what a screen said ten
  // minutes earlier.
  const impact = await measureImpact({ client, record, now, selection });

  const before = {
    icpIndustries: record['icpIndustries'] ?? null,
    icpRegions: record['icpRegions'] ?? null,
    icpSizeBands: record['icpSizeBands'] ?? null,
  };

  const written = await patchConfig(
    client,
    configId,
    toIcpConfigPatch(selection),
    {
      icpReviewedAt: now.toISOString(),
      icpReviewDecision: ICP_REVIEW_DECISION_VALUES.applied,
    },
  );

  if (!written.ok) {
    return result(502, {
      outcome: 'write_failed',
      message: `Greenlight could not write the profile, so nothing has changed. (${written.error})`,
      status: readIcpStatus(record),
      impact: impact.impact,
      selection,
      warnings,
      notes: impact.notes,
    });
  }

  logGreenlight('icp_applied', {
    configId,
    requestedBy,
    industries: selection.industries.length,
    regions: selection.regions.length,
    sizeBands: selection.sizeBands.length,
    newlyGatedInSample: impact.impact.newlyGated,
    sampled: impact.impact.sampled,
  });

  await writeIcpAuditRow(
    client,
    now,
    `CONFIG_CHANGED · Greenlight ICP applied · ${selection.industries.length} industries, ${selection.regions.length} regions, ${selection.sizeBands.length} size bands`,
    {
      action: 'icp_applied',
      requestedBy,
      before,
      after: toIcpConfigPatch(selection),
      impact: {
        sampled: impact.impact.sampled,
        newlyGated: impact.impact.newlyGated,
        newlyApproved: impact.impact.newlyApproved,
        estimatedNewlyGated: impact.impact.estimatedNewlyGated,
        averageScoreBefore: impact.impact.averageScoreBefore,
        averageScoreAfter: impact.impact.averageScoreAfter,
      },
      rescoreRequested: rescore,
      engineVersion: SCORING_ENGINE_VERSION,
    },
  );

  const rescoreOutcome = rescore
    ? await requestRescore({ client, store, now, requestedBy })
    : {
        started: false,
        message:
          'Existing leads keep the scores they already have. New and edited leads are judged against the new profile from now on; re-score existing leads from "Score existing leads" whenever you are ready.',
      };

  const updated = { ...record, ...toIcpConfigPatch(selection) };

  return result(200, {
    outcome: 'applied',
    message: written.reviewRecorded
      ? 'Profile saved. Every lead scored from now on is judged against it.'
      : 'Profile saved. Greenlight could not stamp the review date on the record — the profile itself is in place, and this panel may keep showing the profile as unreviewed until the app metadata is next synced.',
    status: readIcpStatus(
      written.reviewRecorded
        ? {
            ...updated,
            icpReviewedAt: now.toISOString(),
            icpReviewDecision: ICP_REVIEW_DECISION_VALUES.applied,
          }
        : updated,
    ),
    impact: impact.impact,
    selection,
    warnings,
    notes: impact.notes,
    rescore: rescoreOutcome,
  });
};

/**
 * Re-score existing leads by starting the backfill that already exists, in `all`
 * mode.
 *
 * Reused rather than reimplemented, and that is the whole point: the backfill
 * already paces itself against the rate limit, resumes after a crash, honours
 * decisions a colleague released by hand, and is visible while it runs. A second
 * bulk path built here would have to re-earn every one of those properties and
 * would get at most one of them right.
 */
const requestRescore = async ({
  client,
  store,
  now,
  requestedBy,
}: IcpDeps): Promise<{ started: boolean; message: string }> => {
  try {
    const started = await startBackfill({
      client,
      store,
      now,
      mode: 'all',
      requestedBy: `${requestedBy} (ICP change)`,
    });

    return {
      started: started.body.outcome === 'started',
      message: started.body.message,
    };
  } catch (error) {
    logGreenlight('icp_rescore_start_failed', { error: describeError(error) });

    return {
      started: false,
      message: `The profile was saved, but Greenlight could not start the re-score. Start it yourself from "Score existing leads". (${describeError(error)})`,
    };
  }
};

/**
 * Record that the workspace looked at this and chose to leave the profile open.
 *
 * This is not a dismissal and it is not "remind me later". The permissive
 * default is a legitimate answer — plenty of businesses genuinely do sell to
 * every industry in every country — and until now the record could not tell that
 * answer apart from nobody ever having been asked. A warning that cannot be
 * answered is a warning people learn to scroll past, which is how the original
 * defect would come back wearing a new surface.
 */
export const leaveIcpOpen = async ({
  client,
  now,
  requestedBy,
}: Pick<IcpDeps, 'client' | 'now' | 'requestedBy'>): Promise<IcpControlResult> => {
  let record: Record<string, unknown> | null;

  try {
    record = (await loadIcpConfigRecord(client)).record;
  } catch (error) {
    return result(502, {
      outcome: 'config_unreadable',
      message: `Greenlight could not read its configuration record, so nothing was changed. (${describeError(error)})`,
    });
  }

  if (record === null) {
    return result(200, { outcome: 'config_missing', message: CONFIG_MISSING_MESSAGE });
  }

  const configId = configIdOf(record);

  if (configId === null) {
    return result(502, {
      outcome: 'config_unusable',
      message:
        'Greenlight found a configuration record without an id, so it did not write to it.',
    });
  }

  const written = await patchConfig(
    client,
    configId,
    {},
    {
      icpReviewedAt: now.toISOString(),
      icpReviewDecision: ICP_REVIEW_DECISION_VALUES.leftOpen,
    },
  );

  if (!written.ok) {
    return result(502, {
      outcome: 'write_failed',
      message: `Greenlight could not record that decision, so this panel will keep asking. (${written.error})`,
      status: readIcpStatus(record),
    });
  }

  logGreenlight('icp_left_open', { configId, requestedBy });

  await writeIcpAuditRow(
    client,
    now,
    'CONFIG_CHANGED · Greenlight ICP deliberately left open',
    {
      action: 'icp_left_open',
      requestedBy,
      note: 'No industry, region or size filtering. Scores are built from contact quality and compliance only.',
      engineVersion: SCORING_ENGINE_VERSION,
    },
  );

  const updated = {
    ...record,
    icpReviewedAt: now.toISOString(),
    icpReviewDecision: ICP_REVIEW_DECISION_VALUES.leftOpen,
  };

  return result(200, {
    outcome: 'left_open',
    message:
      'Recorded. Industry, region and company size stay switched off, and scores continue to be built from contact quality and compliance alone. You can change this at any time.',
    status: readIcpStatus(updated),
  });
};

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

export const runIcpCommand = async (
  command: IcpCommand,
  deps: IcpDeps,
): Promise<IcpControlResult> => {
  switch (command.action) {
    case 'propose':
      return proposeIcpForWorkspace(deps);
    case 'preview':
      return previewIcpForWorkspace({
        ...deps,
        selection: command.selection,
        warnings: command.warnings,
      });
    case 'apply':
      return applyIcpToWorkspace({
        ...deps,
        selection: command.selection,
        warnings: command.warnings,
        rescore: command.rescore,
      });
    case 'leave-open':
      return leaveIcpOpen(deps);
    default:
      return readIcpReviewStatus(deps);
  }
};
