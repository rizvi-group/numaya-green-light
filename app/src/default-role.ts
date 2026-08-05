import {
  defineApplicationRole,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import {
  APP_DISPLAY_NAME,
  DEFAULT_ROLE_UNIVERSAL_IDENTIFIER,
  GREENLIGHT_AUDIT_LOG_OBJECT_UNIVERSAL_IDENTIFIER,
  GREENLIGHT_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/universal-identifiers';

/**
 * The role every Greenlight logic function runs as.
 *
 * ## What it needs, object by object
 *
 * | Object               | Read | Write | Why                                                                     |
 * |----------------------|------|-------|-------------------------------------------------------------------------|
 * | `person`             | yes  | yes   | The lead being scored; score/decision/trace and the suppression fields.  |
 * | `company`            | yes  | yes   | ICP inputs are read through the relation; capture creates one. See below.|
 * | `opportunity`        | yes  | yes   | The deal lanes of the pipeline board; readiness and next-action fields.  |
 * | `task` / `taskTarget`| yes  | no    | Stage exit criteria ask whether an activity was logged against a deal.   |
 * | `note` / `noteTarget`| yes  | no    | Same, for the "a note since the meeting" criterion.                      |
 * | `greenlightConfig`   | yes  | yes   | Read on every run; created at install and patched on upgrade.            |
 * | `greenlightAuditLog` | yes  | yes   | Every decision appends a row.                                            |
 *
 * Nothing else. The previous `canReadAllObjectRecords: true` granted read over
 * every object in the workspace — messages, calendar events, connected
 * accounts, API keys, workspace members — to a function that only ever wanted
 * `Person.jobTitle`.
 *
 * ## Two grants that were argued down rather than added
 *
 * **`calendarEvent` is deliberately absent.** PIPELINE_SPEC.md's exit-criteria
 * table originally read "a discovery call logged (Twenty Task or CalendarEvent
 * in the past)". Reading the calendar object means reading every meeting in the
 * workspace — attendees, titles, times, including everything unrelated to sales
 * — to answer one boolean about one deal. Task and Note are records somebody
 * deliberately attached to *this* opportunity, and they answer the same question
 * with a fraction of the exposure. The criterion is therefore "an activity was
 * logged", and a workspace whose reps live in the calendar and never log a task
 * will see that criterion sit unmet rather than have Greenlight read their diary
 * to guess. Stated on the ICP page's own principle: an app that quietly widens
 * its reach to improve a number is doing the wrong trade on the customer's
 * behalf.
 *
 * **`company` write is a genuine reversal, recorded as one.** The row above used
 * to read "no", and the comment on the grant itself used to say Greenlight had
 * "no reason to ever write to a company record, permanently". That was true of a
 * passive scorer and stopped being true when capture became the product's entry
 * point: typing a company name for a brand-new lead has to create the Company,
 * because Twenty has no Lead object to hold it instead.
 *
 * Twenty bundles create with update — `ObjectPermissionManifest` has no separate
 * create flag — so "create but never modify" is not expressible here and is
 * enforced in the capture path instead: it links to an existing Company by
 * domain or name and only ever inserts when no match is found, never patching a
 * company record a human already curated. That is a weaker guarantee than a
 * permission bit and it is named as weaker on purpose.
 *
 * Twenty bundles create with update: `ObjectPermissionManifest` exposes
 * read / update / softDelete / destroy and no separate create flag, so
 * `canUpdateObjectRecords` is what lets the hook create the config record and
 * the scoring run append an audit row.
 *
 * Delete is off everywhere. Greenlight has no delete path: gating never removes
 * a lead (that is the product's central promise), the audit log is append-only,
 * and the uninstall hook deliberately deletes nothing — the platform's deletion
 * migration handles teardown. `canDestroyAllObjectRecords` was already false;
 * `canSoftDeleteAllObjectRecords` was true and had no caller.
 *
 * ## Where least privilege stops being expressible
 *
 * Object granularity is exact. **Field granularity is not**, and the gap is in
 * the SDK, not in this file.
 *
 * Ideally the role would grant update on exactly the Person fields Greenlight
 * owns — `greenlightScore`, `greenlightDecision`, `greenlightTrace` written by
 * the scoring run, and the four `greenlightSuppress*` columns written by the two
 * block-list actions — and read on the handful the rules consult. The SDK's
 * field-level primitive is
 * `fieldPermissions: { objectUniversalIdentifier, fieldUniversalIdentifier,
 * canReadFieldValue?, canUpdateFieldValue? }`, and the runtime shape it feeds is
 * named `restrictedFields: Record<string, { canRead?, canUpdate? }>` on
 * `ObjectPermissions` (`twenty-sdk/dist/define/index.d.ts`). That name is the
 * evidence: field permissions are a **deny-list layered on top of an object
 * grant**, not an allow-list. There is no "grant only these fields" form.
 *
 * Expressing the intent as a deny-list would mean enumerating every *other*
 * field on Person with `canUpdateFieldValue: false`. That fails twice over:
 * `STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.fields` covers only the standard
 * columns, and a workspace's own custom fields have identifiers that do not
 * exist when this manifest is built — so the deny-list would be silently
 * incomplete the moment an admin adds a field, which is worse than an honest
 * object-level grant. The same argument rules out restricting reads.
 *
 * So: object-level least privilege is fully expressed here; field-level least
 * privilege is not achievable in SDK 2.26.0 and is deliberately not faked. The
 * residual exposure is that a compromised or buggy Greenlight function could
 * write any Person or Company field, not merely its own three. The mitigation
 * that *is* available — `isUIEditable: false` on the score fields — is already
 * applied in `src/fields/`, and it addresses a different threat (humans editing
 * engine-owned values), not this one.
 *
 * ARCHITECTURE.md's "Least-Privilege Role" table names Lead / Account / Contact.
 * Twenty has no such objects; the equivalents are Person and Company, and there
 * is no Lead object at all — see the data-model section of the same document.
 */
export default defineApplicationRole({
  universalIdentifier: DEFAULT_ROLE_UNIVERSAL_IDENTIFIER,
  label: `${APP_DISPLAY_NAME} default function role`,
  description: `${APP_DISPLAY_NAME} default function role`,

  // Blanket grants, all off. Every permission below is opt-in per object.
  canReadAllObjectRecords: false,
  canUpdateAllObjectRecords: false,
  canSoftDeleteAllObjectRecords: false,
  canDestroyAllObjectRecords: false,
  canUpdateAllSettings: false,
  canAccessAllTools: false,

  objectPermissions: [
    {
      // The lead. Read to score it, update to write score / decision / trace.
      objectUniversalIdentifier:
        STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
      canSoftDeleteObjectRecords: false,
      canDestroyObjectRecords: false,
    },
    {
      // ICP inputs are read through Person -> Company. Write exists for exactly
      // one caller — capture creating a Company that does not exist yet — and
      // the header comment records why that reversed an explicit "read-only,
      // permanently" commitment.
      objectUniversalIdentifier:
        STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.company.universalIdentifier,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
      canSoftDeleteObjectRecords: false,
      canDestroyObjectRecords: false,
    },
    {
      // The deal half of the pipeline board. Update covers create, which the
      // handoff needs: crossing the Qualified -> New line is the only path in
      // the app that writes a new Opportunity.
      objectUniversalIdentifier:
        STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.opportunity.universalIdentifier,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
      canSoftDeleteObjectRecords: false,
      canDestroyObjectRecords: false,
    },
    {
      // Read-only, and it should stay that way: exit criteria ask whether a
      // human logged an activity. An app that could write the task would be
      // able to satisfy its own criterion, which makes the readiness number
      // worthless.
      objectUniversalIdentifier:
        STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.task.universalIdentifier,
      canReadObjectRecords: true,
      canUpdateObjectRecords: false,
      canSoftDeleteObjectRecords: false,
      canDestroyObjectRecords: false,
    },
    {
      // The join row. Reading `task` alone cannot tell you which opportunity an
      // activity belongs to.
      objectUniversalIdentifier:
        STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.taskTarget.universalIdentifier,
      canReadObjectRecords: true,
      canUpdateObjectRecords: false,
      canSoftDeleteObjectRecords: false,
      canDestroyObjectRecords: false,
    },
    {
      // "A note logged since the meeting" — same reasoning as task, including
      // why write stays off.
      objectUniversalIdentifier:
        STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.note.universalIdentifier,
      canReadObjectRecords: true,
      canUpdateObjectRecords: false,
      canSoftDeleteObjectRecords: false,
      canDestroyObjectRecords: false,
    },
    {
      objectUniversalIdentifier:
        STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.noteTarget.universalIdentifier,
      canReadObjectRecords: true,
      canUpdateObjectRecords: false,
      canSoftDeleteObjectRecords: false,
      canDestroyObjectRecords: false,
    },
    {
      // Update covers create: the post-install hook seeds this record and the
      // upgrade path patches it.
      objectUniversalIdentifier: GREENLIGHT_CONFIG_OBJECT_UNIVERSAL_IDENTIFIER,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
      canSoftDeleteObjectRecords: false,
      canDestroyObjectRecords: false,
    },
    {
      // Append-only in intent. Delete stays off here as well as in the UI flags
      // on the object itself, so the app cannot erase its own audit trail even
      // by accident.
      objectUniversalIdentifier:
        GREENLIGHT_AUDIT_LOG_OBJECT_UNIVERSAL_IDENTIFIER,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
      canSoftDeleteObjectRecords: false,
      canDestroyObjectRecords: false,
    },
  ],
});
