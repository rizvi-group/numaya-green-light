import { defineObject, FieldType } from 'twenty-sdk/define';

import { GREENLIGHT_CONFIG_ICP_REVIEW_FIELD_UNIVERSAL_IDENTIFIERS } from 'src/constants/icp-identifiers';
import {
  GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS,
  GREENLIGHT_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/universal-identifiers';

/**
 * Default value for the Layer 3 "which object is the lead" mapping.
 *
 * Twenty ships Person / Company / Opportunity — there is no Lead object. Person
 * is the lead-bearing object for v0.1: it is the record a rep actually reaches
 * out to, it already carries the decision-maker signal (`jobTitle`) and the
 * contactability signals (`emails`, `phones`), and it links to Company for the
 * ICP checks. Company is an input to scoring, not the thing being gated;
 * Opportunity only exists *after* qualification, which is downstream of the gate.
 */
export const DEFAULT_LEAD_OBJECT_NAME_SINGULAR = 'person';

/**
 * GreenlightConfig — Configuration Layers 2 and 3 in one CRM-editable record.
 *
 * Singleton-ish by convention, not by schema: Twenty has no single-record object
 * type, so the install hook seeds exactly one record and the scoring engine reads
 * the oldest one. Keeping it a normal object means an admin can clone it to stage
 * a rule change before promoting it, which is cheaper than building a config UI.
 *
 * RAW_JSON vs typed fields — the rule applied throughout this file:
 *
 *   Typed field  ->  the value is a scalar a human will tune from the record
 *                    page (a threshold, a day count, a toggle, a list of strings).
 *                    Twenty renders these as real inputs with validation.
 *
 *   RAW_JSON     ->  the value is a *map keyed by something that ships with the
 *                    release* (rule ids, score components, field names) or a list
 *                    of nested objects. Flattening those into typed fields would
 *                    mean a schema migration — and a new permanent
 *                    universalIdentifier — every time we add a rule or a scoring
 *                    component. That is exactly the churn universalIdentifiers
 *                    are supposed to prevent.
 *
 * Note on `defaultValue` quoting: the SDK reserves bare strings for computed
 * defaults ('uuid', 'now'), so a literal string default has to carry its own
 * single quotes — "'Default'", not 'Default'. This looks like a typo and is not;
 * `yarn twenty dev:build` warns if you unwrap it.
 */
export default defineObject({
  universalIdentifier: GREENLIGHT_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER,
  nameSingular: 'greenlightConfig',
  namePlural: 'greenlightConfigs',
  labelSingular: 'Greenlight Configuration',
  labelPlural: 'Greenlight Configuration',
  description:
    'Workspace-level lead gate settings: ICP, rules, weights, band thresholds, cache lifetimes and field mapping.',
  icon: 'IconAdjustments',
  isSearchable: false,
  labelIdentifierFieldMetadataUniversalIdentifier:
    GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.name,
  fields: [
    {
      universalIdentifier: GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.name,
      type: FieldType.TEXT,
      name: 'name',
      label: 'Name',
      description:
        'Label for this configuration set. The install hook seeds one record named "Default".',
      icon: 'IconAbc',
      defaultValue: "'Default'",
    },
    {
      universalIdentifier:
        GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.isGateEnabled,
      type: FieldType.BOOLEAN,
      name: 'isGateEnabled',
      label: 'Gate enabled',
      description:
        'When off, leads are still scored and traced but nothing is held for review. Scoring never stops — the gate is advisory either way.',
      icon: 'IconShieldCheck',
      defaultValue: true,
    },

    // --- Layer 2: ICP -------------------------------------------------------
    {
      universalIdentifier:
        GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.icpIndustries,
      type: FieldType.ARRAY,
      name: 'icpIndustries',
      label: 'ICP industries',
      description:
        'Industries that count as in-profile, matched case-insensitively. Empty means "every industry qualifies" — the permissive default the install hook seeds.',
      icon: 'IconBuildingFactory',
      // ARRAY, not RAW_JSON: a flat list of strings is exactly what Twenty's
      // chip editor is for, and admins edit this constantly.
      defaultValue: [],
    },
    {
      universalIdentifier:
        GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.icpRegions,
      type: FieldType.ARRAY,
      name: 'icpRegions',
      label: 'ICP regions',
      description:
        'Regions or country codes that count as in-profile. Empty means every region qualifies.',
      icon: 'IconWorld',
      defaultValue: [],
    },
    {
      universalIdentifier:
        GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.icpSizeBands,
      type: FieldType.RAW_JSON,
      name: 'icpSizeBands',
      label: 'ICP size bands',
      description:
        'Employee-count bands and how well each fits the profile. Shape: [{ "label": "smb", "minEmployees": 1, "maxEmployees": 50, "fit": 1 }]. Empty array means size is not scored.',
      icon: 'IconRulerMeasure',
      // RAW_JSON: each band is a nested object with two numeric bounds and a fit
      // weight. Three typed fields per band, with the band count unknown up
      // front, is not a schema — it is a spreadsheet pretending to be one.
      defaultValue: { bands: [] },
    },

    // --- Layer 2: has anyone decided the three above? -----------------------
    //
    // The three lists above are permissive by default, and that default is
    // correct: Greenlight cannot know a customer's target market, and inventing
    // one would gate real leads on a guess. What the record could not say, until
    // these two fields existed, is whether the emptiness was *chosen*.
    //
    // That distinction is the whole difference between a broken install and a
    // correct one. "Nobody has ever looked at this" and "we sell to everyone and
    // left it open on purpose" produce an identical record and completely
    // different scores-you-should-trust, and with no way to tell them apart, a
    // surface that warns about the empty profile can only warn forever — which
    // is how a warning becomes furniture.
    //
    // Written by the ICP review panel, and editable by hand like everything else
    // here. A workspace that configures its ICP straight from the record page
    // leaves these at their defaults, which reads as "not reviewed" while the
    // lists are plainly not empty; the panel treats a non-empty profile as
    // configured regardless, so the stamp is provenance, never a gate.
    {
      universalIdentifier:
        GREENLIGHT_CONFIG_ICP_REVIEW_FIELD_UNIVERSAL_IDENTIFIERS.icpReviewDecision,
      type: FieldType.SELECT,
      name: 'icpReviewDecision',
      label: 'ICP review',
      description:
        'Whether a human has decided what the three lists above should be. "Not reviewed" is the shipped state and means nobody has been asked yet — not that the profile is wrong.',
      icon: 'IconTargetArrow',
      options: [
        {
          position: 0,
          label: 'Not reviewed',
          value: 'NOT_REVIEWED',
          color: 'orange',
        },
        { position: 1, label: 'Applied', value: 'APPLIED', color: 'green' },
        {
          position: 2,
          label: 'Left open deliberately',
          value: 'LEFT_OPEN',
          color: 'blue',
        },
      ],
      defaultValue: "'NOT_REVIEWED'",
    },
    {
      universalIdentifier:
        GREENLIGHT_CONFIG_ICP_REVIEW_FIELD_UNIVERSAL_IDENTIFIERS.icpReviewedAt,
      type: FieldType.DATE_TIME,
      name: 'icpReviewedAt',
      label: 'ICP reviewed at',
      description:
        'When the profile above was last accepted or deliberately left open. Blank means it has never been reviewed.',
      icon: 'IconCalendarCheck',
      // DATE_TIME rather than DATE: an ICP change and the re-score it triggers
      // happen minutes apart, and "did this score come before or after the
      // profile changed" is a question a date alone cannot answer.
      isNullable: true,
    },

    // --- Layer 2: rules and weights ----------------------------------------
    {
      universalIdentifier:
        GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.ruleSettings,
      type: FieldType.RAW_JSON,
      name: 'ruleSettings',
      label: 'Rule settings',
      description:
        'Per-rule enable flag and severity, keyed by rule id. Shape: { "<ruleId>": { "enabled": true, "severity": "blocking" | "critical" | "major" | "minor" | "advisory" } }. Rules missing from this map fall back to their shipped default.',
      icon: 'IconChecklist',
      // RAW_JSON: keyed by the rule catalogue, which grows every release. A
      // typed field pair per rule would mint two permanent universalIdentifiers
      // per new rule and force an upgrade migration each time.
      defaultValue: {},
    },
    {
      universalIdentifier:
        GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.scoreWeights,
      type: FieldType.RAW_JSON,
      name: 'scoreWeights',
      label: 'Score weights',
      description:
        'Relative weight per scoring component, keyed by component id, e.g. { "icpFit": 1, "decisionMaker": 1, "dataCompleteness": 1 }. Weights are normalised at scoring time, so they need not sum to anything. Empty means equal weighting.',
      icon: 'IconScale',
      // RAW_JSON for the same reason as ruleSettings: the component set is owned
      // by the scoring engine and changes with it, not with the workspace.
      defaultValue: {},
    },

    // --- Layer 2: bands and the gate ---------------------------------------
    // Typed NUMBERs, deliberately. These four are the values an admin reaches
    // for first and tunes most often, and they are the ones where a typo inside
    // a JSON blob would silently gate every lead in the workspace.
    {
      universalIdentifier:
        GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.bandExcellentThreshold,
      type: FieldType.NUMBER,
      name: 'bandExcellentThreshold',
      label: 'Excellent band threshold',
      description:
        'Scores at or above this value land in the Excellent band. Scores run 0-100.',
      icon: 'IconTrendingUp',
      // These four defaults MUST match src/scoring/defaults.ts. The engine is
      // the thing that actually reads them; a manifest default that disagrees
      // produces a config record the code silently overrides.
      defaultValue: 85,
    },
    {
      universalIdentifier:
        GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.bandGoodThreshold,
      type: FieldType.NUMBER,
      name: 'bandGoodThreshold',
      label: 'Good band threshold',
      description: 'Scores at or above this value land in the Good band.',
      icon: 'IconTrendingUp',
      defaultValue: 70,
    },
    {
      universalIdentifier:
        GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.bandFairThreshold,
      type: FieldType.NUMBER,
      name: 'bandFairThreshold',
      label: 'Fair band threshold',
      description:
        'Scores at or above this value land in the Fair band. Anything below is Poor.',
      icon: 'IconTrendingDown',
      defaultValue: 50,
    },
    {
      universalIdentifier:
        GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.gateThreshold,
      type: FieldType.NUMBER,
      name: 'gateThreshold',
      label: 'Gate threshold',
      description:
        'Leads scoring below this value are held in the gate queue for human review. Held leads stay visible and releasable — the gate never deletes or hides a lead.',
      icon: 'IconBarrierBlock',
      // Floor of the Fair band: fair and above is cleared to work.
      defaultValue: 50,
    },

    // --- Layer 2: cache lifetimes ------------------------------------------
    {
      universalIdentifier:
        GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.defaultShelfLifeDays,
      type: FieldType.NUMBER,
      name: 'defaultShelfLifeDays',
      label: 'Default shelf life (days)',
      description:
        'How long an enriched field is considered fresh before it is re-fetched. Applies to any field without an explicit override below.',
      icon: 'IconClockHour4',
      // Typed: this single number is what most workspaces will ever change.
      defaultValue: 30,
    },
    {
      universalIdentifier:
        GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.fieldShelfLives,
      type: FieldType.RAW_JSON,
      name: 'fieldShelfLives',
      label: 'Per-field shelf lives',
      description:
        'Overrides for the default above, in days, keyed by field name: { "jobTitle": 90, "employeeCount": 30 }. Anything absent uses the default.',
      icon: 'IconClockCog',
      // RAW_JSON: keyed by the customer's own field names, so the key set is
      // unknowable at build time. Typed fields are impossible here by construction.
      defaultValue: {},
    },

    // --- Layer 3: field mapping --------------------------------------------
    {
      universalIdentifier:
        GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.leadObjectNameSingular,
      type: FieldType.SELECT,
      name: 'leadObjectNameSingular',
      label: 'Lead object',
      description:
        'Which standard object Greenlight treats as the lead. v0.1 writes score, decision and trace fields to Person only; Company and Opportunity are declared here so the mapping can be recorded, but selecting them leaves those records unscored until their score fields ship.',
      icon: 'IconTargetArrow',
      options: [
        { position: 0, label: 'Person', value: 'PERSON', color: 'green' },
        { position: 1, label: 'Company', value: 'COMPANY', color: 'gray' },
        {
          position: 2,
          label: 'Opportunity',
          value: 'OPPORTUNITY',
          color: 'gray',
        },
      ],
      defaultValue: "'PERSON'",
    },
    {
      universalIdentifier:
        GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.decisionMakerFieldName,
      type: FieldType.TEXT,
      name: 'decisionMakerFieldName',
      label: 'Decision-maker field',
      description:
        'Name of the field on the lead object that carries the seniority signal. Defaults to Person.jobTitle; point it at a custom field if the workspace stores role elsewhere.',
      icon: 'IconUserStar',
      defaultValue: "'jobTitle'",
    },
    {
      universalIdentifier:
        GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.decisionMakerMatchValues,
      type: FieldType.ARRAY,
      name: 'decisionMakerMatchValues',
      label: 'Decision-maker match values',
      description:
        'Case-insensitive substrings that mark the field above as a decision maker, e.g. "ceo", "founder", "head of". Empty disables the decision-maker rule.',
      icon: 'IconListSearch',
      // ARRAY rather than MULTI_SELECT: the values are free text the workspace
      // invents, not a fixed option set we can ship.
      defaultValue: [
        "'ceo'",
        "'cto'",
        "'coo'",
        "'cfo'",
        "'founder'",
        "'owner'",
        "'president'",
        "'partner'",
        "'vp'",
        "'vice president'",
        "'head of'",
        "'director'",
      ],
    },
    {
      universalIdentifier:
        GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.readyForOutreachFieldName,
      type: FieldType.TEXT,
      name: 'readyForOutreachFieldName',
      label: 'Ready-for-outreach field',
      description:
        'Name of the stage/status field that marks a lead as ready for a rep. Left blank on a stock Twenty workspace, because Person has no stage field — set it to a custom SELECT such as "leadStatus", or to "stage" when the lead object is Opportunity.',
      icon: 'IconFlag',
      // Field name + value stored separately rather than as one blob: the pair
      // is two scalars, and an admin picking them out of a config UI needs to
      // see and edit them independently.
      isNullable: true,
    },
    {
      universalIdentifier:
        GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.readyForOutreachValue,
      type: FieldType.TEXT,
      name: 'readyForOutreachValue',
      label: 'Ready-for-outreach value',
      description:
        'The value of the field above that means "ready for outreach", e.g. "QUALIFIED". Releasing a gated lead sets this value.',
      icon: 'IconFlagCheck',
      isNullable: true,
    },
    {
      universalIdentifier:
        GREENLIGHT_CONFIG_FIELD_UNIVERSAL_IDENTIFIERS.optOutFieldNames,
      type: FieldType.ARRAY,
      name: 'optOutFieldNames',
      label: 'Opt-out fields',
      description:
        'Your own opt-out field names, e.g. "doNotContact". Any one of them being true blocks the lead on compliance grounds. These are read *in addition to* Greenlight\'s own "Do not contact" field on the person, not instead of it — either source saying so is enough. Leave empty if you have no opt-out column of your own; Greenlight ships one.',
      icon: 'IconHandStop',
      defaultValue: [],
    },
  ],
});
