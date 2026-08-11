import { defineRole } from 'twenty-sdk/define';

import {
  SALES_STAFF_OBJECT_UNIVERSAL_IDENTIFIER,
  SALES_TEAM_MANAGER_ROLE_UNIVERSAL_IDENTIFIER,
  STAFF_AVAILABILITY_OBJECT_UNIVERSAL_IDENTIFIER,
  STAFF_CONTRACT_OBJECT_UNIVERSAL_IDENTIFIER,
  STAFF_NOTE_OBJECT_UNIVERSAL_IDENTIFIER,
} from 'src/constants/sales-team-identifiers';

/**
 * The role a workspace assigns to whoever manages the sales team.
 *
 * ## Why the app ships a role at all
 *
 * Because the alternative is asking every customer to hand-build one, and the
 * thing they would be hand-building is a permission set whose mistakes are
 * invisible. Shipping it means "who may read team records" has one answer with
 * a name, and the exposure check has something specific to compare against.
 *
 * ## Why it is not called "Sales Manager"
 *
 * The workspace this was designed against already has a role called exactly
 * that, with its own assignees and its own meaning. A second role under the
 * same label is how an admin grants the wrong one — so this is named for the
 * app that owns it.
 *
 * ## What it deliberately does not grant
 *
 * - **No destroy, anywhere.** A team record and its contract history are the
 *   evidence of what somebody was working to. Removing them should require an
 *   admin acting deliberately, not a manager clearing a list.
 * - **No settings access.** Managing people is not administering a workspace.
 * - **No `canReadAllObjectRecords`.** The four grants below are the whole role;
 *   a manager of the sales team has no business reading connected accounts or
 *   API keys by virtue of that job.
 *
 * ## What this role cannot do, and no app role can
 *
 * It cannot stop anybody *else* reading these objects. On a stock workspace the
 * Sales Rep and Member roles both carry "See Records on All Objects", which
 * covers every object this app ships the moment it installs. Closing that is a
 * per-object deny rule on those roles, in the customer's own settings, and it is
 * the step where this feature is either safe or not. `SALES_TEAM_SPEC.md` §5.3
 * says so at more length, and the exposure check exists because a documented
 * step is not the same as a step somebody took.
 */
export default defineRole({
  universalIdentifier: SALES_TEAM_MANAGER_ROLE_UNIVERSAL_IDENTIFIER,
  label: 'Greenlight Sales Team Manager',
  description:
    'Can read and maintain sales team records: working preferences, capabilities, availability, notes and contract terms. Cannot delete them, and grants nothing else.',
  canReadAllObjectRecords: false,
  canUpdateAllObjectRecords: false,
  canSoftDeleteAllObjectRecords: false,
  canDestroyAllObjectRecords: false,
  canUpdateAllSettings: false,
  canBeAssignedToUsers: true,
  // Not agents and not API keys. This role reads compensation; a key carrying it
  // would be a copy of that access living outside anybody's account, and an
  // agent holding it would put the same data behind a prompt.
  canBeAssignedToAgents: false,
  canBeAssignedToApiKeys: false,
  objectPermissions: [
    {
      objectUniversalIdentifier: SALES_STAFF_OBJECT_UNIVERSAL_IDENTIFIER,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
      canSoftDeleteObjectRecords: false,
      canDestroyObjectRecords: false,
    },
    {
      objectUniversalIdentifier:
        STAFF_AVAILABILITY_OBJECT_UNIVERSAL_IDENTIFIER,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
      canSoftDeleteObjectRecords: false,
      canDestroyObjectRecords: false,
    },
    {
      objectUniversalIdentifier: STAFF_NOTE_OBJECT_UNIVERSAL_IDENTIFIER,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
      canSoftDeleteObjectRecords: false,
      canDestroyObjectRecords: false,
    },
    {
      objectUniversalIdentifier: STAFF_CONTRACT_OBJECT_UNIVERSAL_IDENTIFIER,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
      canSoftDeleteObjectRecords: false,
      canDestroyObjectRecords: false,
    },
  ],
});
