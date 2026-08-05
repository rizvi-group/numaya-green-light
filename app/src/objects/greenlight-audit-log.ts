import { defineObject, FieldType } from 'twenty-sdk/define';

import {
  GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS,
  GREENLIGHT_AUDIT_LOG_OBJECT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/universal-identifiers';

/**
 * GreenlightAuditLog — append-only record of every decision the gate made.
 *
 * This is the GDPR Art. 22 insurance policy and the "why did this lead score X"
 * answer in one object. Two design notes worth keeping:
 *
 * 1. Append-only is enforced as far as the schema allows: `isUICreatable` and
 *    `isUIEditable` are both false, so nobody hand-writes or edits history from
 *    the CRM UI. The app's own role still writes rows (that permission is
 *    role-level, not object-level). Twenty has no hard immutability flag, so a
 *    workspace admin with destroy rights can still delete rows — that is a
 *    documented limitation, not something the manifest can close.
 *
 * 2. The scored record is referenced polymorphically (object name + record id +
 *    a denormalised display name) rather than by a RELATION to Person. Three
 *    reasons: the lead object is a Layer 3 mapping and may not be Person; a
 *    relation would need an inverse field minted on the standard object, which
 *    is metadata churn on the customer's schema for no user-visible gain; and a
 *    relation makes the audit row a dependent of the lead, whereas the whole
 *    point of an audit trail is that it survives the thing it describes.
 *    `leadDisplayName` is denormalised on purpose so a deleted lead still reads
 *    sensibly a year later.
 *
 * Note on `defaultValue` quoting: the SDK reserves bare strings for computed
 * defaults ('uuid', 'now'), so a literal string default has to carry its own
 * single quotes — "''" for an empty string, "'SCORED'" for a literal. This looks
 * like a typo and is not; `yarn twenty dev:build` warns if you unwrap it.
 */
export default defineObject({
  universalIdentifier: GREENLIGHT_AUDIT_LOG_OBJECT_UNIVERSAL_IDENTIFIER,
  nameSingular: 'greenlightAuditLog',
  namePlural: 'greenlightAuditLogs',
  labelSingular: 'Greenlight Audit Log',
  labelPlural: 'Greenlight Audit Log',
  description:
    'Append-only trace of every Greenlight scoring, gating and override decision.',
  icon: 'IconHistory',
  isSearchable: true,
  isUICreatable: false,
  isUIEditable: false,
  labelIdentifierFieldMetadataUniversalIdentifier:
    GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS.name,
  fields: [
    {
      universalIdentifier: GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS.name,
      type: FieldType.TEXT,
      name: 'name',
      label: 'Summary',
      description:
        'One-line human summary, e.g. "GATED · Jane Doe · 32". Written by the engine; this is the record label.',
      icon: 'IconAbc',
      defaultValue: "''",
    },
    {
      universalIdentifier:
        GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS.eventType,
      type: FieldType.SELECT,
      name: 'eventType',
      label: 'Event',
      description: 'What happened.',
      icon: 'IconBolt',
      options: [
        { position: 0, label: 'Scored', value: 'SCORED', color: 'blue' },
        { position: 1, label: 'Gated', value: 'GATED', color: 'orange' },
        { position: 2, label: 'Released', value: 'RELEASED', color: 'green' },
        { position: 3, label: 'Skipped', value: 'SKIPPED', color: 'gray' },
        {
          position: 4,
          label: 'Config changed',
          value: 'CONFIG_CHANGED',
          color: 'purple',
        },
        { position: 5, label: 'Error', value: 'ERROR', color: 'red' },
        // Appended for the suppression / block-list feature. Appending is safe:
        // option identity derives from `value`, not `position`, so the six
        // options above keep their ids and every existing row keeps its value.
        //
        // These are two events, not one "suppression changed", because they are
        // not symmetric. Adding somebody to the block list stops outreach and is
        // routine; removing them re-enables contact with a person on record
        // asking us to stop, and is the row a DPO will want to filter for on its
        // own. A shared event type would bury the second inside the first.
        //
        // The colours say the same thing: SUPPRESSED is red because the record
        // is now a stop, and UNSUPPRESSED is orange rather than green because
        // lifting a do-not-contact entry is not a good-news event — green would
        // read as "resolved" next to RELEASED and it is nothing of the kind.
        { position: 6, label: 'Suppressed', value: 'SUPPRESSED', color: 'red' },
        {
          position: 7,
          label: 'Unsuppressed',
          value: 'UNSUPPRESSED',
          color: 'orange',
        },
        // Appended for the three subsystems that had no vocabulary of their own
        // and were filing under `CONFIG_CHANGED` / `ERROR`. Appending is safe for
        // the same reason as above — identity is the `value`, not the `position`
        // — and existing rows keep the value they were written with. Nothing
        // migrates old rows; a `CONFIG_CHANGED` row written by the backfill last
        // month is still a true statement about what the row says.
        //
        // Why these four and not one `SUBSYSTEM` catch-all: each answers a
        // different admin question. "Did enrichment ever run on this lead" and
        // "why did it decline to" are the two halves of the only support
        // question Path 2 generates, and a shared value would bury the second
        // inside the first — the same argument as SUPPRESSED / UNSUPPRESSED.
        //
        // The colours: ENRICHED is turquoise because it is an addition to a lead
        // rather than a verdict on one, and must not read as a second kind of
        // SCORED. ENRICHMENT_SKIPPED reuses SKIPPED's gray because it is the
        // same kind of non-event. BACKFILL is sky — adjacent to SCORED's blue,
        // because a backfill is bulk scoring and its rows sit next to the ones it
        // produces. LICENCE is yellow: an entitlement row wants attention
        // without claiming Greenlight is broken, which is what red already means.
        { position: 8, label: 'Enriched', value: 'ENRICHED', color: 'turquoise' },
        {
          position: 9,
          label: 'Enrichment skipped',
          value: 'ENRICHMENT_SKIPPED',
          color: 'gray',
        },
        { position: 10, label: 'Backfill', value: 'BACKFILL', color: 'sky' },
        { position: 11, label: 'Licence', value: 'LICENCE', color: 'yellow' },
        // Appended for the pipeline board. Safe for the third time and for the
        // same reason: identity is the `value`, `position` is display order, and
        // no row migrates.
        //
        // Before these existed the board filed every move under `RELEASED` — the
        // nearest existing value, meaning "a human overrode the engine by hand".
        // That is true of a move made with criteria outstanding and false of the
        // ordinary case, so the log was about to start describing routine
        // pipeline progress using the vocabulary reserved for overrides. The
        // rows would have been individually accurate in their `name` and
        // collectively useless to a filter, which is the failure the
        // SUPPRESSED / UNSUPPRESSED split was introduced to avoid.
        //
        // Two values rather than one, on that same argument. A stage move
        // changes a field on a record that already existed. A handoff **creates
        // the Opportunity** — it is the only path in the app that does, and it is
        // the row somebody answering "when did this deal actually start, and off
        // which lead" needs to find on its own. Collapsing it into MOVED would
        // bury the answer among every drag a rep made afterwards.
        //
        // Neither is an override. Whether the criteria were met is recorded in
        // the row's own fields, not in its event type: a move made anyway is
        // still a MOVED, because a rep who knows something the CRM does not is
        // doing the normal thing rather than a special one.
        //
        // Colours: MOVED is iris — near SCORED's blue, because both are the
        // engine's routine bookkeeping about where a record stands, but distinct
        // enough to separate in a list. HANDED_OFF is grass: green already means
        // RELEASED, and a handoff is not a resolution — it is the start of
        // something, which is the same reason ENRICHED took turquoise rather
        // than a second blue.
        { position: 12, label: 'Moved', value: 'MOVED', color: 'iris' },
        {
          position: 13,
          label: 'Handed off',
          value: 'HANDED_OFF',
          color: 'grass',
        },
      ],
      defaultValue: "'SCORED'",
    },
    {
      universalIdentifier:
        GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS.occurredAt,
      type: FieldType.DATE_TIME,
      name: 'occurredAt',
      label: 'Occurred at',
      description:
        'When the decision was taken. Distinct from createdAt: a retried or replayed run keeps the original decision time.',
      icon: 'IconCalendarClock',
      defaultValue: 'now',
    },

    // --- Which lead (polymorphic — see the class comment) --------------------
    {
      universalIdentifier:
        GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS.leadObjectNameSingular,
      type: FieldType.TEXT,
      name: 'leadObjectNameSingular',
      label: 'Lead object',
      description:
        'Singular API name of the scored object, e.g. "person". Mirrors the Layer 3 field mapping in force at the time.',
      icon: 'IconBox',
      defaultValue: "''",
    },
    {
      universalIdentifier:
        GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS.leadRecordId,
      type: FieldType.UUID,
      name: 'leadRecordId',
      label: 'Lead record ID',
      description: 'Id of the scored record within the object named above.',
      icon: 'IconId',
      isNullable: true,
    },
    {
      universalIdentifier:
        GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS.leadDisplayName,
      type: FieldType.TEXT,
      name: 'leadDisplayName',
      label: 'Lead',
      description:
        'Denormalised label of the scored record, captured at decision time so the trail stays readable after the record changes or is deleted.',
      icon: 'IconUser',
      defaultValue: "''",
    },

    // --- Who ----------------------------------------------------------------
    {
      universalIdentifier:
        GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS.actorType,
      type: FieldType.SELECT,
      name: 'actorType',
      label: 'Actor type',
      description:
        'Whether the engine acted on its own or a human did. Overrides are always HUMAN — that distinction is what keeps the gate out of "solely automated" territory.',
      icon: 'IconUserBolt',
      options: [
        { position: 0, label: 'System', value: 'SYSTEM', color: 'gray' },
        { position: 1, label: 'Human', value: 'HUMAN', color: 'blue' },
        { position: 2, label: 'API', value: 'API', color: 'purple' },
      ],
      defaultValue: "'SYSTEM'",
    },
    {
      universalIdentifier:
        GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS.actorDisplayName,
      type: FieldType.TEXT,
      name: 'actorDisplayName',
      label: 'Actor',
      description:
        'Name of the workspace member who acted, or the engine version for system events. Twenty\'s own createdBy covers the API caller; this field carries the semantic actor.',
      icon: 'IconUser',
      defaultValue: "''",
    },

    // --- Outcome ------------------------------------------------------------
    {
      universalIdentifier:
        GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS.ruleTrace,
      type: FieldType.RAW_JSON,
      name: 'ruleTrace',
      label: 'Rule trace',
      description:
        'Rule-by-rule decision path. Shape: [{ "ruleId": "...", "outcome": "PASS" | "FAIL" | "SKIP", "severity": "...", "weight": 1, "contribution": 12.5, "message": "..." }]. This is the evidence behind the score.',
      icon: 'IconListDetails',
      // RAW_JSON is the only honest option: this is a variable-length array of
      // heterogeneous rule results, one row per rule that ran. Nothing about it
      // is a field a human edits — it is written once and read back verbatim.
      defaultValue: { rules: [] },
    },
    {
      universalIdentifier: GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS.score,
      type: FieldType.NUMBER,
      name: 'score',
      label: 'Score',
      description: 'Resulting score, 0-100. Null when the run failed open.',
      icon: 'IconGauge',
      isNullable: true,
    },
    {
      universalIdentifier: GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS.band,
      type: FieldType.SELECT,
      name: 'band',
      label: 'Band',
      description: 'Band the score fell into, per the configured thresholds.',
      icon: 'IconChartBar',
      options: [
        { position: 0, label: 'Excellent', value: 'EXCELLENT', color: 'green' },
        { position: 1, label: 'Good', value: 'GOOD', color: 'turquoise' },
        { position: 2, label: 'Fair', value: 'FAIR', color: 'yellow' },
        { position: 3, label: 'Poor', value: 'POOR', color: 'red' },
        { position: 4, label: 'Unscored', value: 'UNSCORED', color: 'gray' },
      ],
      defaultValue: "'UNSCORED'",
    },
    {
      universalIdentifier:
        GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS.decision,
      type: FieldType.SELECT,
      name: 'decision',
      label: 'Decision',
      description:
        'The gate outcome. BLOCKED is a compliance stop such as a recorded opt-out. UNSCORED is the fail-open state: something broke, the lead passed through flagged rather than being held.',
      icon: 'IconGavel',
      // Same vocabulary as Person.greenlightDecision, deliberately — see the
      // comment in src/fields/greenlight-decision.field.ts, including why
      // BLOCKED is appended rather than slotted next to GATE.
      options: [
        { position: 0, label: 'Pass', value: 'PASS', color: 'green' },
        { position: 1, label: 'Gate', value: 'GATE', color: 'orange' },
        { position: 2, label: 'Unscored', value: 'UNSCORED', color: 'gray' },
        { position: 3, label: 'Blocked', value: 'BLOCKED', color: 'red' },
      ],
      defaultValue: "'UNSCORED'",
    },
    {
      universalIdentifier:
        GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS.overrideReason,
      type: FieldType.TEXT,
      name: 'overrideReason',
      label: 'Override reason',
      description:
        'Rendered reason a human gave for a manual action: releasing a gated lead, adding someone to the do-not-contact list, or lifting a suppression. On an UNSUPPRESSED row it also names the reason the person was suppressed under, so "which legal-request blocks has this workspace lifted" is answerable from this column alone. Empty on system events.',
      icon: 'IconMessage2',
      defaultValue: "''",
    },
    {
      universalIdentifier:
        GREENLIGHT_AUDIT_LOG_FIELD_UNIVERSAL_IDENTIFIERS.traceId,
      type: FieldType.TEXT,
      name: 'traceId',
      label: 'Trace ID',
      description:
        'Correlation id shared with the structured logs for this run, so a support question can be tied to one execution.',
      icon: 'IconRoute',
      defaultValue: "''",
    },
  ],
});
