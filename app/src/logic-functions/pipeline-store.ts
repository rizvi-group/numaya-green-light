/**
 * Everything the pipeline says to Twenty, and nothing it decides.
 *
 * The split is the same one `enrich-store.ts` draws against `enrich-run.ts` and
 * that `icp-run.ts` draws against `src/icp/`: the lane a card sits in, the
 * action it carries and the arithmetic behind its readiness are all decided in
 * `src/pipeline/`, which is pure and has 135 tests. This module builds the
 * GraphQL, flattens Twenty's composites into the snapshot shapes that core
 * reads, and writes the answers back. It makes exactly one judgement of its own
 * and that judgement is `linkOrCreateCompany`, which is documented where it
 * lives because it is standing in for a permission the platform cannot express.
 *
 * ## Reads never throw
 *
 * Every function here that reads returns a value plus, where the caller needs to
 * say so on screen, the reason it is weaker than it should be. A page of records
 * that fails to load costs that page and produces a notice; it never costs the
 * board. `BoardResponse.notices` exists precisely so that "the screen looks
 * complete and is not" is unreachable, and the notices are minted here, next to
 * the failure, rather than by a caller guessing what went wrong.
 *
 * ## The `undefined` / `null` distinction is enforced at this boundary
 *
 * `src/pipeline/types.ts` is built around it: `undefined` means *we did not read
 * this*, `null` means *we read it and it is empty*. That distinction is only
 * true if the code doing the reading honours it, which is this file. So a field
 * left out of a selection is left off the snapshot entirely rather than
 * defaulted to `null`, and an activity page that may have been truncated leaves
 * the opportunities it did not cover `undefined` instead of asserting they have
 * no notes. Getting that backwards produces a card that tells a salesperson to
 * fix something that is not broken, and it only has to happen twice before
 * nobody believes the board again.
 */

import {
  planEnrichment,
  readEnrichmentPayload,
  type EnrichableFieldKey,
} from 'src/enrichment';
import {
  describeError,
  isPlainRecord,
  logGreenlight,
  oldestByCreatedAt,
  readConnectionNodes,
  type GreenlightApiClient,
} from 'src/logic-functions/greenlight-api';
import { greenlightConfigSelection } from 'src/logic-functions/greenlight-config-record';
import type {
  LeadSnapshot,
  OpportunitySnapshot,
  PipelineLane,
} from 'src/pipeline/types';

/* -------------------------------------------------------------------------- */
/* Paging                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Twenty's documented page ceiling, and the batch size the backfill has been
 * running at since it shipped. Restated from `BACKFILL_PAGE_SIZE` rather than
 * imported so this module does not depend on the backfill's chunk arithmetic,
 * which is about a cron tick's rate budget and has nothing to do with painting a
 * screen.
 */
export const PIPELINE_PAGE_SIZE = 60;

/**
 * The board's request budget, against Twenty's 100-per-minute ceiling.
 *
 *     1   configuration read
 *     1   opportunity-selection probe, only when the extended one is rejected
 *    25   Person pages          (25 × 60 = 1,500 people)
 *     6   Opportunity pages     (6 × 60 = 360 deals)
 *    12   activity pages        (6 batches × { tasks, notes })
 *     ────
 *    45   requests, worst case, for one complete repaint
 *
 * Fifty-five requests of headroom is what is left for live scoring while
 * somebody is looking at the board, which is the number that actually matters:
 * a board that painted itself by throttling the gate would have optimised the
 * wrong thing, exactly as the backfill's chunk size argues at greater length.
 *
 * A workspace larger than 1,500 leads sees a notice saying so rather than a
 * silently short board. The alternative — paging until exhaustion — is a screen
 * whose cost is unbounded in the customer's data, and a rep scrolling past 1,500
 * cards is a rep who should be filtering.
 */
export const BOARD_PERSON_PAGES = 25;
export const BOARD_OPPORTUNITY_PAGES = 6;

export interface PagedRecords {
  readonly nodes: readonly Record<string, unknown>[];
  /** True when more records exist than were read. */
  readonly truncated: boolean;
  readonly notices: readonly string[];
}

/**
 * Walk a connection newest-first, keyed on `createdAt`.
 *
 * The same walk `icp-run.ts` uses for its samples and for the same two reasons:
 * if only part of the book can be read, the recent part is the more useful part;
 * and a page that came back short, gave no usable cursor, or advanced nothing is
 * the end of the walk — the last of those is what stops an unmoving cursor
 * spinning over the same sixty records until the function times out.
 *
 * A rejected page after the first keeps what was already read. A rejected *first*
 * page is the difference between a partial board and no board, so it degrades to
 * one unordered page before giving up, and says which happened.
 */
export const walkConnection = async (
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
): Promise<PagedRecords> => {
  const notices: string[] = [];
  const nodes: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let truncated = false;

  for (let page = 0; page < pages; page += 1) {
    const args: Record<string, unknown> = {
      first: PIPELINE_PAGE_SIZE,
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
      logGreenlight('pipeline_page_failed', {
        connection,
        page,
        error: describeError(error),
      });

      if (page > 0) {
        notices.push(
          `Greenlight stopped reading ${label} after ${nodes.length} records, so the board is showing those and may be missing more.`,
        );

        return { nodes, truncated: true, notices };
      }

      const fallback = await readOnePage(client, connection, selection);

      notices.push(
        fallback.length === 0
          ? `Greenlight could not read ${label} from this workspace just now, so that part of the board is empty rather than wrong. Nothing has been changed.`
          : `Greenlight could not page through ${label}, so the board is built from ${fallback.length} records rather than up to ${pages * PIPELINE_PAGE_SIZE}.`,
      );

      return { nodes: fallback, truncated: fallback.length > 0, notices };
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

    if (batch.length < PIPELINE_PAGE_SIZE || lastCreatedAt === null || added === 0) {
      return { nodes, truncated: false, notices };
    }

    cursor = lastCreatedAt;

    // A full last page means the walk hit its page allowance rather than the end
    // of the data. The board says so instead of implying it has everything.
    if (page === pages - 1) {
      truncated = true;
      notices.push(
        `Greenlight read the ${nodes.length} most recent ${label} for this board. If this workspace has more than that, they are not on the screen — filter or search for them instead.`,
      );
    }
  }

  return { nodes, truncated, notices };
};

const readOnePage = async (
  client: GreenlightApiClient,
  connection: string,
  selection: Record<string, unknown>,
): Promise<Record<string, unknown>[]> => {
  try {
    const response = await client.query({
      [connection]: {
        __args: { first: PIPELINE_PAGE_SIZE },
        edges: { node: selection },
      },
    });

    return readConnectionNodes(response, connection);
  } catch (error) {
    logGreenlight('pipeline_page_fallback_failed', {
      connection,
      error: describeError(error),
    });

    return [];
  }
};

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

export interface PipelineConfigRead {
  readonly record: Record<string, unknown> | null;
  readonly notices: readonly string[];
}

/**
 * The configuration record, or a stated absence.
 *
 * `resolvePipelineConfig` repairs anything unusable and never throws, so a null
 * record is not an error state — it is the shipped defaults, and the board is
 * still correct under them. What it is not is *silent*: a workspace whose gate
 * threshold is being guessed at should be told, because every readiness figure
 * on the screen is computed against it.
 */
export const readPipelineConfigRecord = async (
  client: GreenlightApiClient,
): Promise<PipelineConfigRead> => {
  try {
    const response = await client.query({
      greenlightConfigs: { edges: { node: greenlightConfigSelection() } },
    });

    const record = oldestByCreatedAt(
      readConnectionNodes(response, 'greenlightConfigs'),
    );

    return {
      record,
      notices:
        record === null
          ? [
              'Greenlight could not find its configuration record, so the board is using the shipped defaults for the gate threshold and for how long a stage is expected to take.',
            ]
          : [],
    };
  } catch (error) {
    logGreenlight('pipeline_config_read_failed', { error: describeError(error) });

    return {
      record: null,
      notices: [
        'Greenlight could not read its configuration just now, so the board is using the shipped defaults for the gate threshold and for how long a stage is expected to take. Everything else on the screen is current.',
      ],
    };
  }
};

/**
 * The two knobs `PipelineConfig` carries, read off the CRM record.
 *
 * `stageDwellDays` has no field on `GreenlightConfig` and deliberately none is
 * invented here: `resolvePipelineConfig` supplies `DEFAULT_STAGE_DWELL_DAYS`
 * when the key is absent, which is the correct answer until an admin has
 * something to set it with.
 */
export const toPipelineConfigInput = (
  record: Record<string, unknown> | null,
): unknown => {
  if (record === null) {
    return undefined;
  }

  return { gateThreshold: record['gateThreshold'] };
};

const readShelfLife = (
  record: Record<string, unknown> | null,
): { defaultDays: number; perField: Record<string, number> } => {
  const raw = record?.['defaultShelfLifeDays'];
  const defaultDays =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 30;

  const perFieldRaw = record?.['fieldShelfLives'];
  const perField: Record<string, number> = {};

  if (isPlainRecord(perFieldRaw)) {
    for (const [key, value] of Object.entries(perFieldRaw)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        perField[key] = value;
      }
    }
  }

  return { defaultDays, perField };
};

/* -------------------------------------------------------------------------- */
/* Selections                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The Person columns a board read needs, and no others.
 *
 * Narrower than `backfillPersonSelection` on purpose: the board does not score,
 * so it needs no phones, no city and no linkedin link. Wider in exactly one
 * place — `greenlightEnrichment` — because the Enriching lane is derived from
 * whether a provider could plausibly still fill a gap, and that question is
 * answered by `planEnrichment` reading the enrichment payload.
 *
 * Note what is absent. The workspace's own opt-out columns are not selected,
 * because their names are a Layer 3 mapping and an unknown field name fails the
 * whole query rather than coming back empty — which would take the board down to
 * read a field most workspaces do not have. `LeadSnapshot.optedOut` is therefore
 * left `undefined`, which reads as "we did not check" rather than "they have not
 * opted out", and Greenlight's own `greenlightSuppressed` still answers the
 * compliance question for every record the block-list actions have touched.
 */
export const pipelinePersonSelection = (): Record<string, unknown> => ({
  id: true,
  createdAt: true,
  updatedAt: true,
  name: { firstName: true, lastName: true },
  emails: { primaryEmail: true },
  jobTitle: true,
  companyId: true,
  company: { id: true, name: true },
  greenlightScore: true,
  greenlightDecision: true,
  greenlightTrace: true,
  greenlightSuppressed: true,
  greenlightSuppressionReason: true,
  greenlightEnrichment: true,
  greenlightEnrichmentStatus: true,
});

/**
 * The Opportunity columns, with `ownerId` behind a probe.
 *
 * Stock Twenty's Opportunity has no owner column; plenty of workspaces add one,
 * and the `owner assigned` exit criterion asks for it by that name. Selecting a
 * field that does not exist fails the entire request, so the extended selection
 * is tried once and the base one is the fall-back — the same ladder
 * `loadIcpConfigRecord` walks, for the same reason, and with the same outcome
 * when it fails: the criterion reports `indeterminate` rather than asserting
 * that nobody owns a deal we never looked at.
 */
export const pipelineOpportunitySelection = (
  withOwner: boolean,
): Record<string, unknown> => ({
  id: true,
  createdAt: true,
  updatedAt: true,
  name: true,
  stage: true,
  amount: { amountMicros: true, currencyCode: true },
  closeDate: true,
  companyId: true,
  pointOfContactId: true,
  greenlightAdvisedAt: true,
  ...(withOwner ? { ownerId: true } : {}),
});

/**
 * Does this workspace's Opportunity answer to `ownerId`?
 *
 * One request, at `first: 1`, once per board read. Cheaper than discovering the
 * answer by having the first full page rejected, and the answer is reported to
 * the caller so the board can say why an owner criterion is unanswerable rather
 * than leaving a rep to wonder.
 */
export const probeOpportunityOwner = async (
  client: GreenlightApiClient,
): Promise<boolean> => {
  try {
    const response = await client.query({
      opportunities: {
        __args: { first: 1 },
        edges: { node: { id: true, ownerId: true } },
      },
    });

    return isPlainRecord(response) && isPlainRecord(response['opportunities']);
  } catch {
    return false;
  }
};

/* -------------------------------------------------------------------------- */
/* Flattening                                                                  */
/* -------------------------------------------------------------------------- */

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

const readDisplayName = (person: Record<string, unknown>): string | null => {
  const name = person['name'];

  if (!isPlainRecord(name)) {
    return text(person['displayName']);
  }

  const joined = [name['firstName'], name['lastName']]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' ');

  return joined === '' ? null : joined;
};

const readPrimaryEmail = (person: Record<string, unknown>): string | null => {
  const emails = person['emails'];

  if (isPlainRecord(emails)) {
    return typeof emails['primaryEmail'] === 'string'
      ? emails['primaryEmail']
      : null;
  }

  return typeof person['emails'] === 'string' ? person['emails'] : null;
};

export interface LeadSnapshotOptions {
  /** The configuration record, for enrichment shelf lives. */
  readonly config: Record<string, unknown> | null;
  readonly now: Date;
}

/**
 * A Person row as the pipeline core sees it.
 *
 * `enrichableGaps` is `planEnrichment(...).requested` — the enrichment planner's
 * own answer, handed over rather than recomputed. That matters more than it
 * looks: the Enriching lane and the `ENRICH_THE_RECORD` action both mean "a
 * provider could plausibly fill this", and a second implementation of that
 * question would eventually disagree with the run that actually does the work,
 * putting a card in a lane whose button then declines to do anything.
 *
 * `laneEnteredAt` falls back to `createdAt`. Person lanes are derived and
 * therefore have no stored entry stamp — `LeadSnapshot` says so — and the
 * staleness tier reports itself as approximate on that basis.
 */
export const toLeadSnapshot = (
  person: Record<string, unknown>,
  { config, now }: LeadSnapshotOptions,
): LeadSnapshot => {
  const company = isPlainRecord(person['company']) ? person['company'] : null;

  let enrichableGaps: readonly EnrichableFieldKey[] | undefined;

  try {
    const shelfLife = readShelfLife(config);

    enrichableGaps = planEnrichment({
      lead: person,
      existing: readEnrichmentPayload(person['greenlightEnrichment']),
      defaultShelfLifeDays: shelfLife.defaultDays,
      fieldShelfLifeDays: shelfLife.perField,
      now,
      force: false,
    }).requested;
  } catch (error) {
    // Left `undefined`, which reads as "we did not check" and keeps the lead out
    // of Enriching rather than routing it there on a broken answer.
    logGreenlight('pipeline_gap_analysis_failed', {
      leadRecordId: text(person['id']),
      error: describeError(error),
    });

    enrichableGaps = undefined;
  }

  return {
    id: text(person['id']),
    displayName: readDisplayName(person),
    decision: text(person['greenlightDecision']),
    score:
      typeof person['greenlightScore'] === 'number'
        ? person['greenlightScore']
        : null,
    enrichmentStatus: text(person['greenlightEnrichmentStatus']),
    ...(enrichableGaps === undefined ? {} : { enrichableGaps }),
    suppressed: person['greenlightSuppressed'] === true,
    suppressionReason: text(person['greenlightSuppressionReason']),
    companyId: text(person['companyId']) ?? text(company?.['id']),
    companyName: text(company?.['name']),
    email: readPrimaryEmail(person),
    jobTitle: text(person['jobTitle']),
    trace: person['greenlightTrace'] ?? null,
    createdAt: text(person['createdAt']),
    laneEnteredAt: text(person['updatedAt']) ?? text(person['createdAt']),
  };
};

/** Activity dates, resolved separately because they cost their own queries. */
export interface OpportunityActivity {
  readonly lastDiscoveryCallAt?: string | null;
  readonly lastNoteAt?: string | null;
}

/**
 * An Opportunity row as the pipeline core sees it.
 *
 * `amount` is flattened out of Twenty's `{ amountMicros, currencyCode }`
 * composite here and not in the core, because the core has no opinion about
 * currency and no criterion asks anything of the number beyond whether somebody
 * has put one on the deal. Micros are divided out so the value a criterion sees
 * is the value a human typed.
 */
export const toOpportunitySnapshot = (
  opportunity: Record<string, unknown>,
  activity: OpportunityActivity | undefined,
  { withOwner }: { withOwner: boolean },
): OpportunitySnapshot => {
  const rawAmount = opportunity['amount'];
  const amount = isPlainRecord(rawAmount) ? rawAmount['amountMicros'] : rawAmount;

  return {
    id: text(opportunity['id']),
    name: text(opportunity['name']),
    stage: text(opportunity['stage']),
    amount:
      typeof amount === 'number' && Number.isFinite(amount)
        ? amount / 1_000_000
        : null,
    closeDate: text(opportunity['closeDate']),
    ...(withOwner ? { ownerId: text(opportunity['ownerId']) } : {}),
    pointOfContactId: text(opportunity['pointOfContactId']),
    companyId: text(opportunity['companyId']),
    createdAt: text(opportunity['createdAt']),
    stageEnteredAt: text(opportunity['updatedAt']) ?? text(opportunity['createdAt']),
    ...(activity === undefined ? {} : activity),
  };
};

/* -------------------------------------------------------------------------- */
/* Activity — the two criteria that read Task and Note                         */
/* -------------------------------------------------------------------------- */

export interface ActivityRead {
  readonly byOpportunityId: ReadonlyMap<string, OpportunityActivity>;
  readonly notices: readonly string[];
}

const latest = (left: string | null, right: string | null): string | null => {
  if (left === null) {
    return right;
  }

  if (right === null) {
    return left;
  }

  return left > right ? left : right;
};

/**
 * The most recent Task and the most recent Note against each deal.
 *
 * PIPELINE_SPEC.md's privilege section explains why this is Task and Note and
 * not the workspace calendar: answering "has a discovery call happened" from the
 * diary means reading every meeting in the business to produce one boolean about
 * one deal. These are records a human deliberately attached to *this*
 * opportunity, and `src/default-role.ts` grants read and not write on both — an
 * app that could create the activity could satisfy its own exit criterion.
 *
 * ## Why a full page leaves the rest undefined
 *
 * The join rows are asked for newest-first in batches of sixty opportunity ids.
 * A page that comes back **short** has covered every activity those deals have,
 * so a deal absent from it genuinely has none: `null`, and the criterion reports
 * `unmet`. A page that comes back **full** may have been cut off, so a deal
 * absent from it might have an activity we did not see: left `undefined`, and
 * the criterion reports `indeterminate`.
 *
 * That is the `undefined` / `null` distinction from `src/pipeline/types.ts` doing
 * the work it was written for. Collapsing the two would put "no discovery call
 * logged" on a deal that has one, which sends a rep to book a meeting that has
 * already happened.
 */
export const loadOpportunityActivity = async (
  client: GreenlightApiClient,
  opportunityIds: readonly string[],
): Promise<ActivityRead> => {
  const byOpportunityId = new Map<string, OpportunityActivity>();
  const notices: string[] = [];

  if (opportunityIds.length === 0) {
    return { byOpportunityId, notices };
  }

  const calls = new Map<string, string | null>();
  const notes = new Map<string, string | null>();
  let callsComplete = true;
  let notesComplete = true;

  for (let start = 0; start < opportunityIds.length; start += PIPELINE_PAGE_SIZE) {
    const batch = opportunityIds.slice(start, start + PIPELINE_PAGE_SIZE);

    const taskPage = await readJoinPage(client, {
      connection: 'taskTargets',
      related: 'task',
      relatedSelection: { createdAt: true, dueAt: true },
      opportunityIds: batch,
    });

    if (taskPage === null) {
      callsComplete = false;
    } else {
      callsComplete = callsComplete && !taskPage.truncated;

      for (const [opportunityId, node] of taskPage.rows) {
        const when = text(node['dueAt']) ?? text(node['createdAt']);

        calls.set(opportunityId, latest(calls.get(opportunityId) ?? null, when));
      }

      if (!taskPage.truncated) {
        for (const id of batch) {
          if (!calls.has(id)) {
            calls.set(id, null);
          }
        }
      }
    }

    const notePage = await readJoinPage(client, {
      connection: 'noteTargets',
      related: 'note',
      relatedSelection: { createdAt: true },
      opportunityIds: batch,
    });

    if (notePage === null) {
      notesComplete = false;
    } else {
      notesComplete = notesComplete && !notePage.truncated;

      for (const [opportunityId, node] of notePage.rows) {
        const when = text(node['createdAt']);

        notes.set(opportunityId, latest(notes.get(opportunityId) ?? null, when));
      }

      if (!notePage.truncated) {
        for (const id of batch) {
          if (!notes.has(id)) {
            notes.set(id, null);
          }
        }
      }
    }
  }

  for (const id of opportunityIds) {
    const activity: {
      lastDiscoveryCallAt?: string | null;
      lastNoteAt?: string | null;
    } = {};

    if (calls.has(id)) {
      activity.lastDiscoveryCallAt = calls.get(id) ?? null;
    }

    if (notes.has(id)) {
      activity.lastNoteAt = notes.get(id) ?? null;
    }

    byOpportunityId.set(id, activity);
  }

  if (!callsComplete || !notesComplete) {
    notices.push(
      'Greenlight could not read every task and note attached to these deals, so the criteria that depend on them are shown as unchecked rather than unmet.',
    );
  }

  return { byOpportunityId, notices };
};

const readJoinPage = async (
  client: GreenlightApiClient,
  {
    connection,
    related,
    relatedSelection,
    opportunityIds,
  }: {
    connection: string;
    related: string;
    relatedSelection: Record<string, unknown>;
    opportunityIds: readonly string[];
  },
): Promise<{
  rows: readonly (readonly [string, Record<string, unknown>])[];
  truncated: boolean;
} | null> => {
  try {
    const response = await client.query({
      [connection]: {
        __args: {
          first: PIPELINE_PAGE_SIZE,
          filter: { opportunityId: { in: [...opportunityIds] } },
          orderBy: [{ createdAt: 'DescNullsLast' }],
        },
        edges: {
          node: {
            opportunityId: true,
            [related]: { id: true, ...relatedSelection },
          },
        },
      },
    });

    const nodes = readConnectionNodes(response, connection);

    const rows = nodes.flatMap(
      (node): (readonly [string, Record<string, unknown>])[] => {
        const opportunityId = text(node['opportunityId']);
        const record = node[related];

        return opportunityId === null || !isPlainRecord(record)
          ? []
          : [[opportunityId, record] as const];
      },
    );

    return { rows, truncated: nodes.length >= PIPELINE_PAGE_SIZE };
  } catch (error) {
    logGreenlight('pipeline_activity_read_failed', {
      connection,
      error: describeError(error),
    });

    return null;
  }
};

/* -------------------------------------------------------------------------- */
/* Single-record reads                                                         */
/* -------------------------------------------------------------------------- */

export const loadPerson = async (
  client: GreenlightApiClient,
  personId: string,
): Promise<Record<string, unknown> | null> => {
  const response = await client.query({
    people: {
      __args: { filter: { id: { eq: personId } }, first: 1 },
      edges: { node: pipelinePersonSelection() },
    },
  });

  return readConnectionNodes(response, 'people')[0] ?? null;
};

export const loadOpportunity = async (
  client: GreenlightApiClient,
  opportunityId: string,
  withOwner: boolean,
): Promise<Record<string, unknown> | null> => {
  const response = await client.query({
    opportunities: {
      __args: { filter: { id: { eq: opportunityId } }, first: 1 },
      edges: { node: pipelineOpportunitySelection(withOwner) },
    },
  });

  return readConnectionNodes(response, 'opportunities')[0] ?? null;
};

export const loadOpportunitiesForPerson = async (
  client: GreenlightApiClient,
  personId: string,
  withOwner: boolean,
): Promise<Record<string, unknown>[]> => {
  const response = await client.query({
    opportunities: {
      __args: {
        filter: { pointOfContactId: { eq: personId } },
        first: PIPELINE_PAGE_SIZE,
      },
      edges: { node: pipelineOpportunitySelection(withOwner) },
    },
  });

  return readConnectionNodes(response, 'opportunities');
};

/* -------------------------------------------------------------------------- */
/* Capture — dedupe                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The registrable part of a website or an email address, lower-cased.
 *
 * Deliberately crude: strip a scheme, strip a path, strip `www.`. It is a
 * *matching* key and not a validated domain, and the two failure directions are
 * not symmetric — a key that is too strict creates a duplicate Company, which a
 * human can merge, while a key that is too loose links a lead to somebody else's
 * account, which nobody notices.
 */
export const domainKey = (raw: unknown): string | null => {
  if (typeof raw !== 'string') {
    return null;
  }

  const trimmed = raw.trim().toLowerCase();

  if (trimmed === '') {
    return null;
  }

  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const host = (withoutScheme.split('/')[0] ?? '').replace(/^www\./, '');

  return host.includes('.') && !host.includes('@') && !host.includes(' ')
    ? host
    : null;
};

export const emailDomain = (email: unknown): string | null => {
  if (typeof email !== 'string') {
    return null;
  }

  const at = email.lastIndexOf('@');

  return at === -1 ? null : domainKey(email.slice(at + 1));
};

const COMPANY_MATCH_SELECTION = {
  id: true,
  name: true,
  domainName: { primaryLinkUrl: true },
} as const;

/**
 * Find a Company by domain, then by name. **Read-only, by construction.**
 *
 * Both probes are wrapped: a filter shape this workspace's schema rejects must
 * degrade to "no match found" and let the caller decide, not fail a capture. The
 * failure direction of a rejected probe is a duplicate Company, which is the
 * recoverable one.
 */
export const findCompanyByDomain = async (
  client: GreenlightApiClient,
  domain: string,
): Promise<Record<string, unknown> | null> => {
  try {
    const response = await client.query({
      companies: {
        __args: {
          filter: { domainName: { primaryLinkUrl: { ilike: `%${domain}%` } } },
          first: 20,
        },
        edges: { node: COMPANY_MATCH_SELECTION },
      },
    });

    // The `ilike` is a coarse net; the match is confirmed here on the same
    // normalised key both sides were built from, so `notexample.com` cannot
    // claim a lead belonging to `example.com`.
    return (
      readConnectionNodes(response, 'companies').find((company) => {
        const link = isPlainRecord(company['domainName'])
          ? company['domainName']['primaryLinkUrl']
          : null;

        return domainKey(link) === domain;
      }) ?? null
    );
  } catch (error) {
    logGreenlight('pipeline_company_domain_lookup_failed', {
      error: describeError(error),
    });

    return null;
  }
};

export const findCompanyByName = async (
  client: GreenlightApiClient,
  name: string,
): Promise<Record<string, unknown> | null> => {
  try {
    const response = await client.query({
      companies: {
        __args: { filter: { name: { ilike: name } }, first: 20 },
        edges: { node: COMPANY_MATCH_SELECTION },
      },
    });

    const wanted = name.trim().toLowerCase();

    return (
      readConnectionNodes(response, 'companies').find(
        (company) =>
          typeof company['name'] === 'string' &&
          company['name'].trim().toLowerCase() === wanted,
      ) ?? null
    );
  } catch (error) {
    logGreenlight('pipeline_company_name_lookup_failed', {
      error: describeError(error),
    });

    return null;
  }
};

export const findPersonByEmail = async (
  client: GreenlightApiClient,
  email: string,
): Promise<Record<string, unknown> | null> => {
  try {
    const response = await client.query({
      people: {
        __args: {
          filter: { emails: { primaryEmail: { ilike: email } } },
          first: 20,
        },
        edges: { node: pipelinePersonSelection() },
      },
    });

    const wanted = email.trim().toLowerCase();

    return (
      readConnectionNodes(response, 'people').find(
        (person) => (readPrimaryEmail(person) ?? '').trim().toLowerCase() === wanted,
      ) ?? null
    );
  } catch (error) {
    logGreenlight('pipeline_person_lookup_failed', { error: describeError(error) });

    return null;
  }
};

/* -------------------------------------------------------------------------- */
/* Capture — the only writes to Company in the whole app                       */
/* -------------------------------------------------------------------------- */

/**
 * Create a Company. **The only Company mutation Greenlight issues, anywhere.**
 *
 * `src/default-role.ts` records that `company` write is a reversal of an explicit
 * "read-only, permanently" commitment, and that Twenty bundles create with update
 * — `ObjectPermissionManifest` exposes read / update / softDelete / destroy and
 * no separate create flag — so "may create, may never modify" is not expressible
 * as a permission and is enforced here instead.
 *
 * What "enforced here" means concretely, because a comment is not an enforcement:
 * this module contains exactly one call whose mutation name begins `createCompany`
 * and **no call whose mutation name begins `updateCompany`**. There is no code
 * path from a capture to a patch of an existing Company, because there is no
 * function that could perform one. `linkOrCreateCompany` below reaches this
 * function only when both lookups returned nothing, and
 * `__tests__/pipeline-capture.test.ts` asserts both halves — that a matched
 * company produces no company mutation at all, and that no mutation name across
 * the whole capture chain starts with `update` on Company.
 *
 * That is a weaker guarantee than a permission bit and `default-role.ts` names it
 * as weaker. It is not weakened further here.
 */
const createCompany = async (
  client: GreenlightApiClient,
  data: Record<string, unknown>,
): Promise<string | null> => {
  const response = await client.mutation({
    createCompany: { __args: { data }, id: true },
  });

  const created = isPlainRecord(response) ? response['createCompany'] : null;

  return isPlainRecord(created) ? text(created['id']) : null;
};

export interface CompanyLink {
  readonly companyId: string | null;
  readonly companyName: string | null;
  /** True when an existing record was linked rather than a new one inserted. */
  readonly matchedExisting: boolean;
  readonly notices: readonly string[];
}

/**
 * PIPELINE_SPEC.md § Capture, step 1 and 2: "dedupe against existing Company
 * (domain, then name); create or link".
 *
 * Domain first because it is the identifier two records of the same account are
 * most likely to agree on — "Northwind Logistics", "Northwind Logistics Ltd" and
 * "Northwind" are three names for one `northwind.example`. Name second, matched
 * exactly after normalisation, because a fuzzy name match that linked a lead to
 * the wrong account would be silent and permanent.
 */
export const linkOrCreateCompany = async (
  client: GreenlightApiClient,
  {
    companyName,
    companyWebsite,
    email,
  }: {
    companyName: string | null;
    companyWebsite: string | null;
    email: string | null;
  },
): Promise<CompanyLink> => {
  const domain = domainKey(companyWebsite) ?? emailDomain(email);
  const name = companyName === null ? null : companyName.trim();

  if (domain !== null) {
    const matched = await findCompanyByDomain(client, domain);

    if (matched !== null) {
      return {
        companyId: text(matched['id']),
        companyName: text(matched['name']) ?? name,
        matchedExisting: true,
        notices: [],
      };
    }
  }

  if (name !== null && name !== '') {
    const matched = await findCompanyByName(client, name);

    if (matched !== null) {
      return {
        companyId: text(matched['id']),
        companyName: text(matched['name']) ?? name,
        matchedExisting: true,
        notices: [],
      };
    }
  }

  if ((name === null || name === '') && domain === null) {
    return {
      companyId: null,
      companyName: null,
      matchedExisting: false,
      notices: [
        'No company name or website was given and the email address did not carry a usable domain, so this lead was created without a company. Link one and the score will follow.',
      ],
    };
  }

  const inserted: Record<string, unknown> = {
    name: name === null || name === '' ? (domain as string) : name,
  };

  if (domain !== null) {
    inserted['domainName'] = { primaryLinkUrl: `https://${domain}` };
  }

  try {
    const companyId = await createCompany(client, inserted);

    return {
      companyId,
      companyName: inserted['name'] as string,
      matchedExisting: false,
      notices: [],
    };
  } catch (error) {
    logGreenlight('pipeline_company_create_failed', {
      error: describeError(error),
    });

    return {
      companyId: null,
      companyName: name,
      matchedExisting: false,
      notices: [
        'Greenlight could not create the company for this lead, so the lead was created without one. Nothing existing was changed — link a company by hand and the score will follow.',
      ],
    };
  }
};

/* -------------------------------------------------------------------------- */
/* Capture — Person                                                            */
/* -------------------------------------------------------------------------- */

export const createPerson = async (
  client: GreenlightApiClient,
  {
    firstName,
    lastName,
    email,
    companyId,
  }: {
    firstName: string;
    lastName: string;
    email: string;
    companyId: string | null;
  },
): Promise<string | null> => {
  const data: Record<string, unknown> = {
    name: { firstName, lastName },
    emails: { primaryEmail: email },
  };

  if (companyId !== null) {
    data['companyId'] = companyId;
  }

  const response = await client.mutation({
    createPerson: { __args: { data }, id: true },
  });

  const created = isPlainRecord(response) ? response['createPerson'] : null;

  return isPlainRecord(created) ? text(created['id']) : null;
};

/* -------------------------------------------------------------------------- */
/* Advance — the handoff, and the stage write                                  */
/* -------------------------------------------------------------------------- */

/** Lane id to the SELECT value Twenty stores on `opportunity.stage`. */
export const stageValueFor = (lane: PipelineLane): string => lane.toUpperCase();

/**
 * Create the Opportunity a card crosses the handoff line into.
 *
 * The only path in the app that writes a new Opportunity, which is what
 * PIPELINE_SPEC.md means by "the handoff line is real". Company and point of
 * contact are pre-linked from the Person because a deal that arrives without
 * them is a deal a rep has to repair before it is useful, and every fact needed
 * to link them is already on the card that was dragged.
 */
export const createOpportunityForHandoff = async (
  client: GreenlightApiClient,
  {
    name,
    companyId,
    pointOfContactId,
    stage,
  }: {
    name: string;
    companyId: string | null;
    pointOfContactId: string | null;
    stage: string;
  },
): Promise<string | null> => {
  const data: Record<string, unknown> = { name, stage };

  if (companyId !== null) {
    data['companyId'] = companyId;
  }

  if (pointOfContactId !== null) {
    data['pointOfContactId'] = pointOfContactId;
  }

  const response = await client.mutation({
    createOpportunity: { __args: { data }, id: true },
  });

  const created = isPlainRecord(response) ? response['createOpportunity'] : null;

  return isPlainRecord(created) ? text(created['id']) : null;
};

export const updateOpportunityStage = async (
  client: GreenlightApiClient,
  opportunityId: string,
  stage: string,
): Promise<void> => {
  await client.mutation({
    updateOpportunity: { __args: { id: opportunityId, data: { stage } }, id: true },
  });
};

export const updatePersonDecision = async (
  client: GreenlightApiClient,
  personId: string,
  decision: string,
): Promise<void> => {
  await client.mutation({
    updatePerson: {
      __args: { id: personId, data: { greenlightDecision: decision } },
      id: true,
    },
  });
};

/* -------------------------------------------------------------------------- */
/* Advice writes                                                               */
/* -------------------------------------------------------------------------- */

export interface AdviceWrite {
  readonly nextAction: string;
  readonly nextActionKind: string;
  readonly advisedAt: string;
  /** Null when there was nothing to divide by. See `StageReadiness.percent`. */
  readonly readiness: number | null;
  readonly criteria: unknown;
}

/**
 * Person carries three of the five advice fields and not the other two.
 *
 * `pipeline-identifiers.ts` argues it: readiness and criteria are arithmetic
 * over a *stage's* exit criteria, and a lead with no Opportunity is not in a
 * stage. A readiness percentage on a Captured lead would be a number with
 * nothing behind it.
 */
export const writePersonAdvice = async (
  client: GreenlightApiClient,
  personId: string,
  advice: AdviceWrite,
): Promise<boolean> => {
  try {
    await client.mutation({
      updatePerson: {
        __args: {
          id: personId,
          data: {
            greenlightNextAction: advice.nextAction,
            greenlightNextActionKind: advice.nextActionKind,
            greenlightAdvisedAt: advice.advisedAt,
          },
        },
        id: true,
      },
    });

    return true;
  } catch (error) {
    logGreenlight('pipeline_person_advice_write_failed', {
      personId,
      error: describeError(error),
    });

    return false;
  }
};

/**
 * `greenlightReadiness` is left out of the payload entirely when the percentage
 * is null, rather than written as 0. `StageReadiness.percent` is explicit that
 * "everything is done" and "we could check nothing" must not render as the same
 * full bar, and zero is not the third option — it is the first one, wrong.
 */
export const writeOpportunityAdvice = async (
  client: GreenlightApiClient,
  opportunityId: string,
  advice: AdviceWrite,
): Promise<boolean> => {
  const data: Record<string, unknown> = {
    greenlightNextAction: advice.nextAction,
    greenlightNextActionKind: advice.nextActionKind,
    greenlightAdvisedAt: advice.advisedAt,
    greenlightCriteria: advice.criteria,
  };

  if (advice.readiness !== null) {
    data['greenlightReadiness'] = advice.readiness;
  }

  try {
    await client.mutation({
      updateOpportunity: { __args: { id: opportunityId, data }, id: true },
    });

    return true;
  } catch (error) {
    logGreenlight('pipeline_opportunity_advice_write_failed', {
      opportunityId,
      error: describeError(error),
    });

    return false;
  }
};

/* -------------------------------------------------------------------------- */
/* Audit                                                                       */
/* -------------------------------------------------------------------------- */

export const appendAuditRow = async (
  client: GreenlightApiClient,
  data: Record<string, unknown>,
): Promise<void> => {
  await client.mutation({
    createGreenlightAuditLog: { __args: { data }, id: true },
  });
};
