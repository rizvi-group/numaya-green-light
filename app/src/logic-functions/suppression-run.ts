/**
 * The I/O half of the block-list actions, kept out of the two `define*` files so
 * it can be exercised against a fake API client.
 *
 * Every rule about what may be suppressed, what may be lifted and what gets
 * recorded lives in `src/gate/suppression-decision.ts`, which is pure. This
 * module reads the lead, calls the decision, executes it, and appends the audit
 * row. The only impure things it touches are the client and the `now` it is
 * handed; there is no `new Date()` and no `new CoreApiClient()` below.
 *
 * ## Ordering: record first, write second
 *
 * The audit row is appended **before** the Person is written, which is the same
 * order `scoring-run.ts` uses and for the same reason. If the audit write
 * succeeds and the record write fails, the trail over-records — an entry exists
 * for a change that did not land, and the reviewer is told exactly that.
 * Reversed, a successful record write followed by a failed audit write would
 * leave somebody silently on or off a do-not-contact list with nothing saying
 * who put them there. An append-only trail may repeat itself; it may not lose an
 * entry.
 *
 * A failed audit write is therefore a *clean refusal*: nothing has touched the
 * lead yet, so the action is abandoned rather than performed unlogged.
 *
 * ## The re-score is not this function's job
 *
 * Writing `greenlightSuppressed` emits `person.updated`, and that field is on
 * `SCORING_TRIGGER_PERSON_FIELDS`, so the platform re-scores the lead on its own
 * and the engine writes the resulting `greenlightDecision`. This module
 * deliberately does not write that column: the gate decision is the engine's to
 * make, and two writers on one decision column is how a decision starts
 * disagreeing with the trace that is supposed to explain it.
 *
 * ## Both actions share one body
 *
 * Add and remove differ only in which parser and which decision function run.
 * Everything after that — the audit row, the ordering, the failure reporting —
 * is identical, deliberately, because it is far too easy to let the rarer of two
 * near-identical paths quietly become the less well audited one. The asymmetry
 * that *should* exist (a mandatory note and an explicit acknowledgement to
 * remove someone) lives in the pure module, where it is testable.
 */

import { auditBandValue } from 'src/gate/release-decision';
import {
  buildSuppressionAuditSummary,
  decideSuppress,
  decideUnsuppress,
  parseSuppressRequest,
  parseUnsuppressRequest,
  SUPPRESSION_FIELD_NOTE,
  SUPPRESSION_FIELD_REASON,
  SUPPRESSION_FIELD_SUPPRESSED,
  SUPPRESSION_FIELD_SUPPRESSED_AT,
  type CurrentSuppressionState,
  type ParseResult,
  type SuppressionDecision,
} from 'src/gate/suppression-decision';
import {
  describeError,
  isPlainRecord,
  logGreenlight,
  readConnectionNodes,
  type GreenlightApiClient,
} from 'src/logic-functions/greenlight-api';

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

/** The Person columns both actions need in order to decide anything. */
export const suppressionLeadSelection = (): Record<string, unknown> => ({
  id: true,
  name: { firstName: true, lastName: true },
  greenlightDecision: true,
  greenlightScore: true,
  // Read for one reason: the audit row's band. Without it a SUPPRESSED row
  // carried a real score beside a defaulted "Unscored" band, contradicting the
  // GATED row for the same lead — the same defect the release path had.
  greenlightTrace: true,
  [SUPPRESSION_FIELD_SUPPRESSED]: true,
  [SUPPRESSION_FIELD_REASON]: true,
  [SUPPRESSION_FIELD_SUPPRESSED_AT]: true,
  [SUPPRESSION_FIELD_NOTE]: true,
});

const asTrimmedString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length === 0 ? null : trimmed;
};

/**
 * `Person.name` is a FULL_NAME composite. Local rather than imported from
 * `scoring-run.ts` so these two functions do not bundle the whole scoring engine
 * to render one label — the same reason `release-lead.logic-function.ts` carries
 * its own copy.
 */
const displayNameOf = (node: Record<string, unknown>): string => {
  const name = node['name'];

  if (isPlainRecord(name)) {
    const parts = [name['firstName'], name['lastName']]
      .map((part) => (typeof part === 'string' ? part.trim() : ''))
      .filter((part) => part.length > 0);

    if (parts.length > 0) {
      return parts.join(' ');
    }
  }

  return typeof node['id'] === 'string' ? node['id'] : 'Unknown lead';
};

export const toSuppressionState = (
  recordId: string,
  node: Record<string, unknown>,
): CurrentSuppressionState => ({
  recordId,
  displayName: displayNameOf(node),
  suppressed: node[SUPPRESSION_FIELD_SUPPRESSED] === true,
  reasonCode: asTrimmedString(node[SUPPRESSION_FIELD_REASON]),
  suppressedAt: asTrimmedString(node[SUPPRESSION_FIELD_SUPPRESSED_AT]),
  note: asTrimmedString(node[SUPPRESSION_FIELD_NOTE]) ?? '',
  decision: asTrimmedString(node['greenlightDecision']),
  score:
    typeof node['greenlightScore'] === 'number' ? node['greenlightScore'] : null,
  trace: node['greenlightTrace'] ?? null,
});

const fetchLead = async (
  client: GreenlightApiClient,
  recordId: string,
): Promise<CurrentSuppressionState | null> => {
  const response = await client.query({
    people: {
      __args: { filter: { id: { eq: recordId } }, first: 1 },
      edges: { node: suppressionLeadSelection() },
    },
  });

  const [node] = readConnectionNodes(response, 'people');

  return node === undefined ? null : toSuppressionState(recordId, node);
};

/* -------------------------------------------------------------------------- */
/* The run                                                                     */
/* -------------------------------------------------------------------------- */

export interface SuppressionRunInput {
  readonly client: GreenlightApiClient;
  /** The parsed HTTP body, untyped on purpose. */
  readonly body: unknown;
  readonly now: Date;
  /** Server-derived. Never taken from the request body. */
  readonly actorDisplayName: string;
}

export interface SuppressionRunResult {
  readonly status: number;
  readonly body: {
    readonly outcome: string;
    readonly changed: boolean;
    readonly message: string;
    readonly auditWritten: boolean;
  };
}

interface IdentifiedRequest {
  readonly leadObjectNameSingular: string;
  readonly recordId: string;
}

interface ActionSpec<TRequest extends IdentifiedRequest, TOutcome extends string> {
  readonly logEvent: string;
  parse(body: unknown): ParseResult<TRequest>;
  decide(input: {
    request: TRequest;
    lead: CurrentSuppressionState;
    now: Date;
  }): SuppressionDecision<TOutcome>;
}

const refuse = (
  outcome: string,
  message: string,
  status: number,
): SuppressionRunResult => ({
  status,
  body: { outcome, changed: false, message, auditWritten: false },
});

const run = async <TRequest extends IdentifiedRequest, TOutcome extends string>(
  { client, body, now, actorDisplayName }: SuppressionRunInput,
  spec: ActionSpec<TRequest, TOutcome>,
): Promise<SuppressionRunResult> => {
  const parsed = spec.parse(body);

  if (!parsed.ok) {
    return refuse('invalid_request', parsed.message, 400);
  }

  const request = parsed.request;

  let lead: CurrentSuppressionState | null;

  try {
    lead = await fetchLead(client, request.recordId);
  } catch (error) {
    return refuse(
      'lookup_failed',
      `Greenlight could not read this lead, so nothing was changed. Try again. (${describeError(
        error,
      )})`,
      502,
    );
  }

  if (lead === null) {
    return refuse('record_not_found', 'That lead no longer exists.', 404);
  }

  const decision = spec.decide({ request, lead, now });

  if (decision.write === null) {
    return {
      status: 200,
      body: {
        outcome: decision.outcome,
        changed: false,
        message: decision.message,
        auditWritten: false,
      },
    };
  }

  let auditWritten = false;

  if (decision.shouldWriteAuditRow && decision.auditEventType !== null) {
    try {
      await client.mutation({
        createGreenlightAuditLog: {
          __args: {
            data: {
              name: buildSuppressionAuditSummary(
                decision.auditEventType,
                lead.displayName,
                String(decision.write[SUPPRESSION_FIELD_REASON] ?? 'CLEARED'),
              ),
              eventType: decision.auditEventType,
              occurredAt: now.toISOString(),
              leadObjectNameSingular: request.leadObjectNameSingular,
              leadRecordId: request.recordId,
              leadDisplayName: lead.displayName,
              actorType: 'HUMAN',
              actorDisplayName,
              ruleTrace: { rules: [] },
              score: lead.score,
              // Same rule as the release path: the band comes out of the trace
              // the scoring run recorded, so one lead cannot end up with two
              // bands across its own audit rows.
              band: auditBandValue(lead.trace),
              // The state the record was in when the human acted. The re-score
              // this write triggers is what moves it, and that run appends its
              // own row — this one must not pre-empt a decision it did not make.
              decision: lead.decision ?? 'UNSCORED',
              overrideReason: decision.auditReason,
              traceId: `${decision.auditEventType.toLowerCase()}-${request.recordId}-${now.getTime()}`,
            },
          },
          id: true,
        },
      });

      auditWritten = true;
    } catch (error) {
      logGreenlight('suppression_audit_write_failed', {
        leadRecordId: request.recordId,
        action: spec.logEvent,
        error: describeError(error),
      });

      return refuse(
        'audit_failed',
        'Greenlight could not write the audit entry, so it left the record alone too. An unrecorded change to a do-not-contact list is worse than no change at all — try again.',
        502,
      );
    }
  }

  try {
    await client.mutation({
      updatePerson: {
        __args: { id: request.recordId, data: { ...decision.write } },
        id: true,
      },
    });
  } catch (error) {
    logGreenlight('suppression_write_failed', {
      leadRecordId: request.recordId,
      action: spec.logEvent,
      auditWritten,
      error: describeError(error),
    });

    return {
      status: 502,
      body: {
        outcome: 'write_failed',
        changed: false,
        message:
          'Greenlight recorded this action in the audit log but could not write it to the record, so it is not in force. Open the lead and check it before relying on either state.',
        auditWritten,
      },
    };
  }

  logGreenlight(spec.logEvent, {
    leadRecordId: request.recordId,
    outcome: decision.outcome,
    actorDisplayName,
  });

  return {
    status: 200,
    body: {
      outcome: decision.outcome,
      changed: true,
      message: decision.message,
      auditWritten,
    },
  };
};

export const runSuppressLead = (
  input: SuppressionRunInput,
): Promise<SuppressionRunResult> =>
  run(input, {
    logEvent: 'lead_suppressed',
    parse: parseSuppressRequest,
    decide: decideSuppress,
  });

export const runUnsuppressLead = (
  input: SuppressionRunInput,
): Promise<SuppressionRunResult> =>
  run(input, {
    logEvent: 'lead_unsuppressed',
    parse: parseUnsuppressRequest,
    decide: decideUnsuppress,
  });
