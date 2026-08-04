import { CoreApiClient } from 'twenty-client-sdk/core';
import { defineLogicFunction } from 'twenty-sdk/define';

import { ENRICH_LEAD_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER } from 'src/constants/enrichment-identifiers';
import { readEnrichmentEnvironment } from 'src/enrichment';
import { readPublishedLicenceState } from 'src/logic-functions/licence-cache-store';
import {
  createReasoningPort,
  createSearchPort,
} from 'src/logic-functions/enrich-adapters';
import { runLeadEnrichment } from 'src/logic-functions/enrich-run';
import { kvEnrichmentStore } from 'src/logic-functions/enrich-store';
import { isPlainRecord } from 'src/logic-functions/greenlight-api';

/**
 * Enrich a lead once the deterministic gate has reached a verdict.
 *
 * A shell, like every other `define*` file here: the decisions live in
 * `src/enrichment/`, the I/O in `enrich-run.ts`, and this file exists to hand
 * over a real client, a real clock, real providers and the published licence
 * state.
 *
 * ===========================================================================
 * ## The trigger
 *
 * ARCHITECTURE.md's Path 2 trigger is "lead passed the deterministic gate OR
 * admin explicitly requests enrichment". `greenlightDecision` is the field
 * `scoring-run.ts` writes at the end of every scored run, so `person.updated`
 * narrowed to that single field *is* "the gate has just reached a verdict",
 * expressed in the platform's own vocabulary rather than re-derived here.
 *
 * It fires on every verdict, not only on `PASS`. That is deliberate and it is
 * the more useful reading of the spec: the measured finding behind this whole
 * feature is that an unconfigured ICP plus incomplete records makes scoring
 * measure *"do we hold contact details"* rather than *"is this a fit"*. The leads
 * that most need enrichment are therefore precisely the ones sitting at `GATE`
 * with an empty industry — enriching only the ones that already passed would
 * enrich the leads that needed it least. The one verdict it skips is `BLOCKED`:
 * a compliance stop must not be followed by us going and looking that person up
 * on the internet.
 *
 * ## Why this loop is bounded
 *
 * There *is* a cycle here, deliberately, and it is two hops long.
 *
 * `greenlightEnrichment` is on `SCORING_TRIGGER_PERSON_FIELDS`, because
 * `resolveFieldMapping` appends `greenlightEnrichment.fields.<key>.parsedValue`
 * to every enrichable key and an enriched value is therefore a scoring input. An
 * enriched lead that had to wait for its next unrelated edit before the score
 * moved was enrichment writing data nothing read. So: enrichment writes → the
 * scorer wakes → the scorer may write `greenlightDecision` → we wake again.
 *
 * Three things stop that being a loop, in the order they bite:
 *
 *  1. **We never wake ourselves directly.** This function's `updatedFields`
 *     names exactly one field, `greenlightDecision`, and the enrichment run
 *     writes exactly three: `greenlightEnrichment`, `greenlightEnrichedAt` and
 *     `greenlightEnrichmentStatus`. Those two sets are still disjoint, so our own
 *     write is never dispatched back to us. The platform enforces this, not us.
 *  2. **The scorer usually writes nothing.** Its outcome fingerprint covers the
 *     score, band, decision and every rule verdict. If enrichment changed no
 *     value a rule reads — nothing was accepted, or a human value already sat
 *     ahead of the enriched path — the fingerprint is unchanged, the scorer skips
 *     both its writes, `greenlightDecision` never changes and we are never woken.
 *     The chain stops before it starts.
 *  3. **The shelf-life cache closes the second hop.** When the score *does* move
 *     and we are woken, the gap analysis finds every field either freshly
 *     enriched or inside the unresolved back-off window, requests nothing, and
 *     returns `no_gaps` before touching a provider **and before writing
 *     anything**. No write means the scorer is not woken again. The whole cycle
 *     costs one key-value read and terminates.
 *
 * Even in the pathological case where a later run does find a fresh gap, each hop
 * strictly shrinks the set of unfilled enrichable fields (sourced ⇒ fresh, not
 * sourced ⇒ unresolved), so the chain is bounded by the five entries in
 * `ENRICHABLE_FIELD_SPECS` and again by the monthly spend cap.
 *
 * `__tests__/enrich-score-cycle.test.ts` drives both runs against one shared
 * record and asserts the chain settles — including the case where enrichment
 * genuinely moves the score — rather than trusting this comment.
 * `enrich-run.test.ts` asserts (1) and (2) as set membership.
 *
 * ## Timeout
 *
 * 60s. The search client's own budget is 6s and each of the two model calls is
 * capped at 20s, which leaves room for the record reads and the single write.
 * Being killed here costs one lead's enrichment and nothing else — the budget
 * counter is written before the first provider call, so a killed run cannot
 * spend twice.
 * ===========================================================================
 */

/** The one verdict enrichment does not follow. See above. */
const BLOCKED_DECISION = 'BLOCKED';

const readDecisionAfter = (event: unknown): string | null => {
  if (!isPlainRecord(event)) {
    return null;
  }

  const properties = event['properties'];

  if (!isPlainRecord(properties)) {
    return null;
  }

  const after = properties['after'];

  if (!isPlainRecord(after)) {
    return null;
  }

  const decision = after['greenlightDecision'];

  return typeof decision === 'string' ? decision : null;
};

const readRecord = (event: unknown): Record<string, unknown> | null => {
  if (!isPlainRecord(event)) {
    return null;
  }

  const properties = event['properties'];

  if (!isPlainRecord(properties)) {
    return null;
  }

  const after = properties['after'];

  return isPlainRecord(after) ? after : null;
};

const readRecordId = (
  event: unknown,
  record: Record<string, unknown> | null,
): string | null => {
  if (isPlainRecord(event) && typeof event['recordId'] === 'string') {
    return event['recordId'];
  }

  return record !== null && typeof record['id'] === 'string' ? record['id'] : null;
};

const handler = async (event: unknown) => {
  const record = readRecord(event);
  const leadRecordId = readRecordId(event, record);

  if (leadRecordId === null) {
    return { status: 'skipped', reason: 'event_unreadable' };
  }

  if (readDecisionAfter(event) === BLOCKED_DECISION) {
    return { status: 'skipped', reason: 'compliance_blocked' };
  }

  return runLeadEnrichment(
    {
      client: new CoreApiClient(),
      store: kvEnrichmentStore,
      environment: readEnrichmentEnvironment(process.env),
      createReasoning: createReasoningPort,
      createSearch: createSearchPort,
      licence: await readPublishedLicenceState(),
      now: new Date(),
    },
    { leadRecordId, lead: record },
  );
};

export default defineLogicFunction({
  universalIdentifier: ENRICH_LEAD_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER,
  name: 'greenlight-enrich-lead',
  description:
    'Fills firmographic gaps on a lead after the Greenlight gate has scored it, using the workspace’s own AI and search providers. Every value is stored with the page it came from. Never blocks a lead: no licence, no provider, or a reached spend cap all skip quietly.',
  timeoutSeconds: 60,
  handler,
  databaseEventTriggerSettings: {
    eventName: 'person.updated',
    // Exactly one field, and not one of the three this run writes, so we can
    // never wake ourselves. The scorer *can* wake us, and we can wake the
    // scorer — see "Why this loop is bounded" above for why that settles.
    updatedFields: ['greenlightDecision'],
  },
});
