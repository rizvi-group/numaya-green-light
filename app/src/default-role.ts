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
 * | `company`            | yes  | no    | ICP industry / size / region are read through the relation.              |
 * | `greenlightConfig`   | yes  | yes   | Read on every run; created at install and patched on upgrade.            |
 * | `greenlightAuditLog` | yes  | yes   | Every decision appends a row.                                            |
 *
 * Nothing else. The previous `canReadAllObjectRecords: true` granted read over
 * every object in the workspace — messages, calendar events, connected
 * accounts, API keys, workspace members — to a function that only ever wanted
 * `Person.jobTitle`.
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
      // ICP inputs are read through Person -> Company. Read-only, permanently:
      // Greenlight has no reason to ever write to a company record.
      objectUniversalIdentifier:
        STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.company.universalIdentifier,
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
