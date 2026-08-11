# Sales Team Records — Design Specification

**Status:** Design · nothing built
**Decided:** Ships inside Greenlight. Sales staff see their **own** record, never a colleague's.
Notes are **operational only** — availability, capabilities, working preferences. No performance or
disciplinary notes are kept in this system.

---

## 1. What this is

A record of **who is on the sales team, what they can handle, and when they are available.**

The scope decision that shapes everything: managers keep no private notes here. That removes the
sharpest risk from the earlier draft — a rep reading their manager's assessment of them — and it
changes what the data is *for*. Availability, coverage and capability are not filing-cabinet data.
They are the inputs to **which rep should get this lead**, which is Greenlight's own subject.

That is also the honest answer to "why does this belong in a lead quality gate": a gate that decides
a lead is worth working, without knowing who is free to work it or who speaks the language, has
stopped one step short.

**Still true:** compensation on a contract is confidential between a manager and one employee, and
one rep must not read another's record. The self-scoping in §3 remains the design's spine.

---

## 2. Findings from the live workspace and the 2.29 server

Researched against `crm.rizvigoc.com` (Twenty 2.29.0) and the 2.29 server image, 2026-08-11/12.

### 2.1 The roles already exist

**Admin** (2), **Member** (10), **Numaya Greenlight default function role**, **Sales Manager** (1),
**Sales Rep** (0 assigned). The feature fits these rather than inventing parallel names.

### 2.2 Sales Rep can currently read every object in the workspace

See / Edit / Delete Records on **All Objects** are all on, with *"No permissions have been set for
individual objects."* Member is the same. **Objects shipped without permission work would be
readable and editable by every rep on install.**

### 2.3 A per-object rule does override the blanket grant

`object-permission.service.js`:

```js
const hasReadPermissionAfterUpdate = resolvedCanRead ?? flatRole.canReadAllObjectRecords;
```

An explicit per-object permission wins. An admin can deny these objects to Sales Rep without
touching their access to Companies, People or Opportunities.

### 2.4 ⚠ Row-level permission predicates require an Enterprise plan

`row-level-permission-predicate-group.service.js`:

```js
const hasValidEnterprisePlan = this.enterprisePlanService.isValid();
return hasValidEnterprisePlan && isRowLevelPermissionEnabled;
```

The module is stamped `/* @license Enterprise */`, and `crm.rizvigoc.com` reports
`ENTERPRISE_KEY: null`. **"Each rep sees only their own row" cannot come from Twenty's permission
system on this instance.**

### 2.5 Predicate semantics, for the record

Predicates AND by default; groups allow OR; each compares a field **on the object itself** against a
workspace-member field, so it cannot traverse a relation. Moot per 2.4, and the reason §3 is the
design rather than a workaround.

---

## 3. Architecture: two audiences, two boundaries

| Audience | Sees | Boundary |
|---|---|---|
| **Managers and admins** | Every staff record, capability, availability entry, contract, note | Twenty RBAC — object permissions on a shipped role |
| **Sales staff** | **Their own** record: preferences, capabilities, availability, notes about them | A Greenlight **logic function** that resolves the caller's workspace member server-side and answers only about them |

Reps hold **no object permission** on these objects. They never query them; they call a route that
can only answer about the caller. Advantages over a permission flag:

1. Works without an Enterprise licence (2.4).
2. A rep cannot reach a colleague's record by URL, REST, search or view export — there is no
   permission to reach it with.
3. Scoping lives in one function with tests, not in a flag that must be right on every row forever.

Caller identity comes from the platform: 2.29's route trigger passes `userId` and `userWorkspaceId`
into `logicFunctionTriggerService.run`, so the route never trusts a client-supplied identity.

---

## 4. Data model

### 4.1 `greenlightSalesStaff` — the person

| Field | Type | Notes |
|---|---|---|
| `name` | TEXT | |
| `workspaceMember` | RELATION → `workspaceMember` | MANY_TO_ONE, `SET_NULL`. What the self-service route matches on |
| `employmentStatus` | SELECT | `PROSPECTIVE`, `ACTIVE`, `ON_LEAVE`, `NOTICE`, `DEPARTED` |
| `teamRole` | SELECT | `SALES_REP`, `SALES_MANAGER`, `SALES_ENGINEER`, `SDR`, `OTHER` |
| `manager` | RELATION → `greenlightSalesStaff` | Self-relation |
| `startedOn` / `endedOn` | DATE_TIME | |
| `workEmail` | TEXT | Duplicated deliberately, so a departed member's record survives account deletion |

**Working preferences** — the part a rep may edit about themselves:

| Field | Type | Notes |
|---|---|---|
| `timeZone` | SELECT (IANA) | e.g. `Australia/Sydney` |
| `workingDays` | ARRAY | `MON`…`SUN` |
| `preferredHoursFrom` / `preferredHoursTo` | TEXT (`HH:mm`) | Local to `timeZone`. A manager in another zone must never see raw times without the zone beside them |
| `preferredContactMode` | SELECT | `EMAIL`, `PHONE`, `SLACK`, `TEAMS`, `IN_PERSON` |
| `preferredMeetingLength` | NUMBER | Minutes |
| `outOfHoursContact` | SELECT | `NEVER`, `URGENT_ONLY`, `ANY_TIME` |

Hours are stored as local strings plus an IANA zone rather than UTC timestamps: "I prefer 9–5" is a
recurring intent, not an instant, and UTC breaks it twice a year at daylight-saving boundaries.

**Capabilities** — what this person can be given:

| Field | Type | Notes |
|---|---|---|
| `languages` | ARRAY | Spoken languages, for matching a lead's market |
| `coverageRegions` | ARRAY | Territories they sell into. Deliberately the same vocabulary as the ICP's `regions`, so lead and rep can be compared without translation |
| `industryExpertise` | ARRAY | Same vocabulary as ICP `industries`, for the same reason |
| `productLines` | ARRAY | What they are cleared to sell |
| `certifications` | ARRAY | |
| `seniority` | SELECT | `JUNIOR`, `MID`, `SENIOR`, `PRINCIPAL` — pairs with deal size |
| `maxActiveLeads` | NUMBER | Working capacity, not a quota |
| `acceptingNewLeads` | BOOLEAN | The fast switch a manager flips when someone is swamped |

Sharing the ICP's vocabulary for regions and industries is the single most consequential modelling
choice here: it is what would later let "this lead is Australian professional services" meet "this
rep covers Australian professional services" without a mapping table nobody maintains.

**Not stored, deliberately:** date of birth, home address, national ID or tax number, bank details,
next of kin, health or disability information, right-to-work documents. Different risk class,
belongs in an HR system. Note that `ON_LEAVE` and an availability entry can express "unavailable
until the 14th" without recording *why*, and they should.

### 4.2 `greenlightStaffAvailability` — dated exceptions

Preferences describe a normal week; this describes the exceptions, and it is a separate object
because it has its own lifecycle and needs querying by date.

| Field | Type | Notes |
|---|---|---|
| `staff` | RELATION → `greenlightSalesStaff` | MANY_TO_ONE, CASCADE |
| `kind` | SELECT | `LEAVE`, `PUBLIC_HOLIDAY`, `TRAINING`, `REDUCED_HOURS`, `EXTRA_COVER` |
| `startsOn` / `endsOn` | DATE_TIME | |
| `note` | TEXT | Optional, operational — "conference, email only" |

No reason-for-absence field. `LEAVE` is sufficient for routing and avoids collecting health data by
the back door.

### 4.3 `greenlightStaffNote` — operational notes, one object

Per the scope decision, there is **no private note object**. Every note here is the kind a manager
would be comfortable with the subject reading, and the subject *can* read their own.

| Field | Type | Notes |
|---|---|---|
| `summary` / `body` | TEXT | |
| `staff` | RELATION → `greenlightSalesStaff` | MANY_TO_ONE, CASCADE |
| `noteType` | SELECT | `AVAILABILITY`, `CAPABILITY`, `COVERAGE`, `ONBOARDING`, `ADMIN` |
| `occurredOn` | DATE_TIME | |
| `author` | RELATION → `workspaceMember` | |

The note *types* are the enforcement of scope: there is no `PERFORMANCE` or `CONCERN` option. If a
manager later needs those, that is a different feature with the two-object split the previous draft
described — and it should be a deliberate decision, not something that arrives by someone typing a
performance review into an `ADMIN` note.

Reps still cannot read each other's notes: §3 answers only about the caller.

### 4.4 `greenlightStaffContract`

| Field | Type | Notes |
|---|---|---|
| `name` | TEXT | |
| `staff` | RELATION → `greenlightSalesStaff` | MANY_TO_ONE, CASCADE |
| `contractType` | SELECT | `EMPLOYMENT`, `CONTRACTOR`, `COMMISSION_PLAN`, `AMENDMENT` |
| `status` | SELECT | `DRAFT`, `ACTIVE`, `SUPERSEDED`, `TERMINATED` |
| `effectiveFrom` / `effectiveTo` | DATE_TIME | |
| `baseCompensation` / `variableCompensation` | CURRENCY | The one genuinely confidential thing left in the model |
| `quotaAmount` | CURRENCY | |
| `noticePeriodDays` | NUMBER | |
| `documentUrl` | TEXT | Pointer to the signed PDF; the app stores the link, not the document |

Amendments supersede rather than overwrite.

---

## 5. Permission design

1. **App function role** — read/update on all four objects; it is what the self-service route reads
   through.
2. **Shipped assignable role** — "Greenlight Sales Team Manager": read + update on all four, no
   destroy, no settings. Named distinctly from the workspace's own "Sales Manager".
3. **Deny rules (customer-controlled).** Every staff-assignable role granting "See Records on All
   Objects" — today **Sales Rep** and **Member** — needs object-level rules turning read/update/
   delete **off** for all four objects. The app cannot do this; it is the step where the feature is
   safe or not.
4. **Exposure check (app-controlled).** A "Who can see staff records" panel naming every
   user-assignable role that can currently read the objects — green only when that is the manager
   role and Admin. Runs post-install too, writing an audit row, so a missed step is visible rather
   than assumed. *Open:* whether the app's role can read role metadata to perform the check; if not,
   the fallback is an explicit admin acknowledgement, and it should be labelled as the weaker thing
   it is.

---

## 6. UI surfaces

| Surface | Audience | Mechanism |
|---|---|---|
| Sidebar **Sales Team** view | managers, admins | Object view (RBAC) |
| Staff record: preferences, capabilities, availability, contracts, notes | managers, admins | Record page |
| **Team availability** view — who is free this week | managers, admins | View over availability + `acceptingNewLeads` |
| Command menu **"My work preferences"** | every rep | Front component → self-service route |
| Command menu **"Who can see staff records"** | managers, admins | Exposure check panel |

Navigation items are not a security boundary — the boundary is §5.3 for managers, §3 for reps.

---

## 7. Compliance

- Availability and capability data is still personal data, but the removal of performance notes
  takes this out of the territory where a subject-access request produces something contentious.
- No reason-for-absence, no health data (§4.2).
- Every write appends to the existing Greenlight audit log.
- Retention for `DEPARTED` staff: contract history argues for keeping records; indefinite
  accumulation is not a policy. **Open.**

---

## 8. Scope

**v1** — four objects; shipped manager role; Sales Team and Team Availability views; record page;
availability, capability and note entry; the self-service "My work preferences" panel (view own
record, edit own preferences and availability); exposure check; post-install warning; audit rows.

**v2, and the reason this belongs in Greenlight** — routing: match a gated-and-passed lead to a rep
by shared ICP vocabulary (region, industry), language, capacity and current availability. Nothing in
v1 should make that harder, which is why §4.1 reuses the ICP vocabularies verbatim.

**Not in v1** — document upload; commission calculation against closed Opportunities; approval
workflows; reps editing anything but their own preferences and availability.

**Never** — the sensitive HR fields in §4.1, and performance or disciplinary notes (§4.3).

---

## 9. Decisions and what is left

**Decided 2026-08-12: contracts hold terms**, not documents. The object records what was agreed —
type, status, effective dates, compensation, quota, notice period — and `documentUrl` stays a plain
link to wherever the signed PDF actually lives. No file storage, no upload path, no assumption that
this system is the system of record for the executed document.

That keeps `baseCompensation` and `variableCompensation` in the model, so they remain the one
genuinely confidential thing here. Two mitigations, both in v1:

- The shipped manager role is the only role granted read on the contract object, and the exposure
  check (§5.4) names any other role that can currently read it.
- The self-service route never returns contract compensation, even to the subject. A rep asking
  about their own pay is a conversation with their manager, not a CRM panel — and a route that
  cannot return the field cannot leak it to the wrong caller through a bug in matching.

**Left open, not blocking v1:**

1. **Retention for departed staff** (§7). Contract history argues for keeping records; indefinite
   accumulation is not a policy.
2. **Should a rep edit their own availability**, or only request it? Assumed edit; approval
   workflows are explicitly v2.
