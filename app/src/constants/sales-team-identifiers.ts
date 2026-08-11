/**
 * Identifiers for the sales-team records — staff, availability, notes, contracts.
 *
 * Design lives in `SALES_TEAM_SPEC.md`. Two things from it are load-bearing here
 * and are repeated so a reader of this file does not have to go and find them.
 *
 * ## The vocabularies are shared with the ICP on purpose
 *
 * `coverageRegions` and `industryExpertise` below carry the same values an admin
 * types into the ICP's `icpRegions` and `icpIndustries`. That is what would let
 * "this lead is Australian professional services" meet "this rep covers
 * Australian professional services" without a mapping table nobody maintains.
 * Nothing in v1 reads them that way; v1's job is to make v2 possible without a
 * migration.
 *
 * ## The self-service route never enumerates the staff directory
 *
 * `src/default-role.ts` refuses `workspaceMember` deliberately — read on it is
 * read over the customer's whole staff directory. The sales-team feature does
 * not reverse that. The staff object stores a workspace-member id in a relation,
 * and the self-service route resolves *the caller's own* id through
 * `currentUser` on the metadata API (see `src/identity/actor.ts`) and filters an
 * app-owned object by it. No directory grant, no enumeration, and a rep asking
 * about themselves is the only question the route can answer.
 */

/* -------------------------------------------------------------------------- */
/* Objects                                                                     */
/* -------------------------------------------------------------------------- */

export const SALES_STAFF_OBJECT_UNIVERSAL_IDENTIFIER =
  '0c0617fc-000a-4a0a-a4ce-0e0f74f50674';

export const STAFF_AVAILABILITY_OBJECT_UNIVERSAL_IDENTIFIER =
  '496b6fd6-49fd-45be-92e5-41ab52d58a03';

export const STAFF_NOTE_OBJECT_UNIVERSAL_IDENTIFIER =
  '9125d4eb-02c5-4996-a77d-970a5d43d80c';

export const STAFF_CONTRACT_OBJECT_UNIVERSAL_IDENTIFIER =
  'a01f6362-9f0a-4c7b-b7c8-8de9d8c028e8';

/* -------------------------------------------------------------------------- */
/* greenlightSalesStaff fields                                                 */
/* -------------------------------------------------------------------------- */

export const SALES_STAFF_FIELD_UNIVERSAL_IDENTIFIERS = {
  name: 'd21fdb59-7229-4264-beaa-59eb1009875b',
  workspaceMember: '52aee27b-9a19-48db-ac56-2bfe8fefb8d2',
  employmentStatus: '9cabbada-6908-485a-9c37-1e080ab04d8a',
  teamRole: 'd7bf260f-ccdf-4d0f-a6da-25a45dd11d87',
  manager: '9b49bbf7-efc5-4e5a-ac55-00a242c8938c',
  startedOn: 'e73b3e96-83f9-4e90-878c-26e4a0b13da6',
  endedOn: '8afc7c3c-2f55-479a-84c6-323dce461ab9',
  workEmail: 'aa36c9af-951a-4e02-bc77-0f1427f54839',

  // Working preferences
  timeZone: 'f2a9f551-0a40-411b-b636-ae8e6b170919',
  workingDays: '1116100f-196b-471a-b93a-84520873c250',
  preferredHoursFrom: '8f82f5d5-2577-4a0d-93aa-f4c2e521f8c1',
  preferredHoursTo: '8bf04b91-6826-4417-8750-6dbb472e3bd4',
  preferredContactMode: '1b39bea9-17f3-4f17-98fd-d35259409c92',
  preferredMeetingLength: '42ca336c-4405-4008-b0bf-a4e106205082',
  outOfHoursContact: 'e8b89fcc-c619-41c3-8974-eb3b96427c08',

  // Capabilities
  languages: 'afe7298b-c02d-427a-892b-f12104c49a83',
  coverageRegions: 'cd900da1-4a82-4a96-b102-5cb039c7c712',
  industryExpertise: '0d3d8d18-eec7-4997-ae7d-c5be26e6473e',
  productLines: '7dd93cc0-0fec-4701-bc95-d457a5613e2a',
  certifications: 'dc2cb76f-166f-479e-ad69-886972a55937',
  seniority: '16b3bc1b-86f5-44fb-9085-f7bcee3fa830',
  maxActiveLeads: '9b0b93ba-6583-4eff-85c0-87e465881d2a',
  acceptingNewLeads: '1a773591-13a0-405c-8246-d6672bcbf923',
} as const;

/** Inverse relation fields minted on the objects we point at. */
export const SALES_STAFF_INVERSE_FIELD_UNIVERSAL_IDENTIFIERS = {
  /** On `workspaceMember` — the staff record for this user. */
  workspaceMemberStaff: 'a369bd0b-19b3-4537-9b8d-9c730a8015b5',
  /** On `greenlightSalesStaff` — the reports of a manager. */
  managerReports: '1481d5bc-5c9c-478b-8a7c-d404b9908173',
} as const;

/* -------------------------------------------------------------------------- */
/* greenlightStaffAvailability fields                                          */
/* -------------------------------------------------------------------------- */

export const STAFF_AVAILABILITY_FIELD_UNIVERSAL_IDENTIFIERS = {
  name: '99cb67b0-9146-461a-9832-bafa9079af0b',
  staff: '97157d82-4bf6-479b-ba97-39dc6e5295fe',
  kind: '59a12079-c30c-438e-98b3-e47b2c3de687',
  startsOn: 'b3c71f83-49b0-46f9-94df-27dc8b61e667',
  endsOn: '1e44b163-7708-409c-8ad6-7a9d749bc85f',
  note: '9c9b6677-16e7-4921-a68d-e675e6fe9b0c',
} as const;

export const STAFF_AVAILABILITY_INVERSE_FIELD_UNIVERSAL_IDENTIFIER =
  '059f7faf-ceb5-45ae-b80f-cf2128e1b4e8';

/* -------------------------------------------------------------------------- */
/* greenlightStaffNote fields                                                  */
/* -------------------------------------------------------------------------- */

export const STAFF_NOTE_FIELD_UNIVERSAL_IDENTIFIERS = {
  name: '33e4cd24-a32e-4ddf-b194-d8c847727f70',
  body: '4968e9b2-d819-443c-b54b-470e13971131',
  staff: 'e4da13d5-1c7d-41cb-9c51-c82128af6c6f',
  noteType: '29670d44-b02f-47de-ab25-acfef3e2ead7',
  occurredOn: '06bc59ac-df8a-4f24-a129-1cefabb88f05',
  author: 'e9fb8885-64cd-4172-a9cb-c9b001629612',
} as const;

export const STAFF_NOTE_INVERSE_FIELD_UNIVERSAL_IDENTIFIERS = {
  staffNotes: '27314527-5554-4e4a-9576-fbbce76360be',
  authorNotes: '256f47d0-60fe-482c-ab62-59d952ad9e73',
} as const;

/* -------------------------------------------------------------------------- */
/* greenlightStaffContract fields                                              */
/* -------------------------------------------------------------------------- */

export const STAFF_CONTRACT_FIELD_UNIVERSAL_IDENTIFIERS = {
  name: '355c1237-6ada-43c1-b167-95bafeab5363',
  staff: '0fd6967d-8167-449b-bc34-319c06f17f80',
  contractType: 'fa96e189-2f2c-4a48-99fd-03888c57acf4',
  status: '7ac0b9ab-0829-4293-bbb6-d833b194860e',
  effectiveFrom: 'af218809-fd58-41df-8672-bfd6dcd8f552',
  effectiveTo: '058accc1-1f33-481c-aff8-abd83c839ce7',
  baseCompensation: '6a6af588-c9b7-430d-8f3d-ba61026f6b59',
  variableCompensation: '3ef0ae06-18ab-4815-a095-78ba99601994',
  quotaAmount: '8e02964c-fd76-46f5-9a52-61f72ad16660',
  noticePeriodDays: '49e3af0e-1534-4ba3-b0e4-dfd38227e338',
  documentUrl: '5b6f348b-bf51-4946-8a95-7c1afffe1684',
} as const;

export const STAFF_CONTRACT_INVERSE_FIELD_UNIVERSAL_IDENTIFIER =
  '510e4c8f-6658-45a7-aa4b-f4b0ffd90419';

/* -------------------------------------------------------------------------- */
/* Role, route, views, panel                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The role a workspace assigns to whoever manages the team.
 *
 * Named "Greenlight Sales Team Manager" rather than "Sales Manager" because the
 * customer's workspace already has a role called exactly that, with its own
 * meaning and its own assignees. Shipping a second role under the same label is
 * how an admin grants the wrong one.
 */
export const SALES_TEAM_MANAGER_ROLE_UNIVERSAL_IDENTIFIER =
  '562fb112-d2ce-4c2e-ae8f-7cbb824f7d16';

export const STAFF_SELF_SERVICE_LOGIC_FUNCTION_UNIVERSAL_IDENTIFIER =
  '16de41cb-2280-40ba-b130-90ce99feaa48';

export const STAFF_SELF_SERVICE_FRONT_COMPONENT_UNIVERSAL_IDENTIFIER =
  '416dce86-9a20-4782-8a2f-b56259871364';

export const STAFF_SELF_SERVICE_COMMAND_MENU_ITEM_UNIVERSAL_IDENTIFIER =
  '6972182e-982f-4ce6-856d-ea7589dffd9e';

export const STAFF_SELF_SERVICE_ROUTE_PATH = '/greenlight/my-work';

export const STAFF_SELF_SERVICE_CLIENT_PATH = `/s${STAFF_SELF_SERVICE_ROUTE_PATH}`;

/* -------------------------------------------------------------------------- */
/* Vocabularies                                                                */
/* -------------------------------------------------------------------------- */

export const WORKING_DAYS = [
  'MON',
  'TUE',
  'WED',
  'THU',
  'FRI',
  'SAT',
  'SUN',
] as const;

export type WorkingDay = (typeof WORKING_DAYS)[number];

/**
 * `HH:mm`, local to the staff member's own `timeZone` — never UTC.
 *
 * "I prefer 9 to 5" is a recurring intent, not an instant. Stored as a UTC
 * timestamp it is wrong for half the year in every zone that observes daylight
 * saving, and it is wrong immediately for anyone who moves. Stored as local time
 * plus an IANA zone it stays true, and the reader is forced to render the zone
 * beside it — which is the honest thing to show a manager in another country.
 */
export const PREFERRED_HOURS_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
