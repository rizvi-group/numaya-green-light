# Numaya Greenlight — Technical Architecture

## Deployment Model: Embedded in Customer's Twenty CRM

```
┌─ Customer's Twenty CRM Instance ──────────────────────────────┐
│                                                                 │
│  ┌─ Greenlight App (npm @numaya/greenlight) ────────────┐    │
│  │                                                        │    │
│  │  Rules Engine                                          │    │
│  │  ├─ Score calculator (ICP/rules/weights)              │    │
│  │  ├─ Deterministic (no external call)                  │    │
│  │  └─ Always produces a score                           │    │
│  │                                                        │    │
│  │  Gate Queue                                            │    │
│  │  ├─ Lead records held for review                      │    │
│  │  ├─ Override mechanism (human release)                │    │
│  │  └─ Trace log per lead (why scored X)                 │    │
│  │                                                        │    │
│  │  Configuration Layer 1 (App Variables)                │    │
│  │  ├─ USE_TWENTY_AI (boolean, default true)            │    │
│  │  ├─ LLM_BASE_URL + LLM_API_KEY (fallback, optional) │    │
│  │  ├─ SEARCH_PROVIDER (required: Brave/Serper/none)   │    │
│  │  ├─ SEARCH_API_KEY (if provider configured)          │    │
│  │  ├─ MONTHLY_ENRICHMENT_CAP (integer)                 │    │
│  │  └─ LICENCE_KEY (customer purchases from Numaya)     │    │
│  │                                                        │    │
│  │  Configuration Layer 2 (CRM Records)                  │    │
│  │  ├─ ICP settings (industries, regions, size)          │    │
│  │  ├─ Rule set (enable/disable + severity)             │    │
│  │  ├─ Score weights per component                       │    │
│  │  └─ Field shelf lives (cache duration)               │    │
│  │                                                        │    │
│  │  Configuration Layer 3 (Field Mapping)                │    │
│  │  ├─ Which object = lead                               │    │
│  │  ├─ Decision-maker field                              │    │
│  │  └─ Ready-for-outreach stage                          │    │
│  │                                                        │    │
│  │  Enrichment (Optional)                                │    │
│  │  ├─ Call Twenty's AI (if enabled in workspace)       │    │
│  │  ├─ OR call customer's LLM (if Twenty AI not setup) │    │
│  │  ├─ Call search provider (customer configures)       │    │
│  │  ├─ Write sourced fields (URL + date + confidence)   │    │
│  │  ├─ Respect MONTHLY_ENRICHMENT_CAP                   │    │
│  │  └─ Degrade to rules-only if provider fails         │    │
│  │                                                        │    │
│  │  License Validation (Phone-Home)                      │    │
│  │  ├─ Validate LICENCE_KEY at install + periodically   │    │
│  │  ├─ Numaya license service: create/validate/activate │    │
│  │  ├─ Offline grace period + cached entitlement        │    │
│  │  └─ Expire to rules-only if license invalid          │    │
│  │                                                        │    │
│  └────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Twenty CRM Data + API                                         │
│  ├─ Lead objects (stored in customer's DB)                    │
│  ├─ Greenlight config records                                  │
│  ├─ Score + gate flags on leads                               │
│  └─ Trace logs (app logs)                                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
        ▲                    ▲                ▲              ▲
        │ (Twenty's AI       │ (customer's    │              │
        │  if enabled)       │  LLM if        │              │
        │                    │  fallback)     │              │
        │                    │                │              │
   ┌────┴─────┐      ┌──────┴────┐  ┌─────────┴──┐   ┌──────┴───────┐
   │ Twenty    │      │ OpenAI    │  │ Search     │   │  Numaya      │
   │ AI        │      │ /Anthropic│  │ Provider   │   │  License     │
   │ (native)  │      │ /etc      │  │ (Brave/    │   │  Service     │
   │           │      │ (BYOK)    │  │  Serper)   │   │ (phone-home) │
   └───────────┘      └───────────┘  │ (BYOK)     │   └──────────────┘
                                      └────────────┘
```

## Execution Paths

### Path 1: Scoring (On Every Lead Event)

**Trigger:** Lead created/updated in Twenty

**Deterministic (no external calls):**
1. Load lead fields
2. Load ICP + rules from config records
3. Run each enabled rule (e.g., "does company match ICP?", "is role decision-maker?")
4. Combine scores per weight
5. Compare to band thresholds
6. Write score + decision to lead record
7. If score < gate threshold → hold in gate queue (visible, overridable)
8. Write trace log (rule-by-rule decision path)

**Fail-open:** Scoring always succeeds. If config records can't load, use seeded defaults. If weights malformed, use neutral weights. Lead is never silently dropped.

---

### Path 2: Enrichment (Optional, If Enabled)

**Trigger:** Lead passed deterministic gate OR admin explicitly requests enrichment

**Requirements:**
- `USE_TWENTY_AI=true` (default) OR customer provided `LLM_BASE_URL` + `LLM_API_KEY`
- `SEARCH_PROVIDER` configured (Brave/Serper/none)
- Monthly enrichment cap not exceeded
- Field shelf-life cache miss (value is stale)

**Process:**
1. Check if customer paid for enrichment (license key has `enrichment: true` scope)
2. If enrichment disabled → skip to Path 3
3. Determine LLM source:
   - If `USE_TWENTY_AI=true` && Twenty workspace has AI configured → use Twenty's AI integration
   - Else if customer provided `LLM_BASE_URL` + `LLM_API_KEY` → use customer's key
   - Else → skip LLM, degrade to rules-only
4. Query search provider (with **customer's key**) for lead company/person info
5. Pass search results + lead fields to LLM (via Twenty's AI or customer's endpoint)
6. LLM extracts missing fields (title, company size, industry, etc.)
7. Write each enriched field with `_source_url`, `_retrieved_at`, `_confidence`
8. Increment per-workspace enrichment counter
9. If counter >= `MONTHLY_ENRICHMENT_CAP` → alert in UI, degrade to rules-only next run

**Fail-open:** If LLM unreachable, search unavailable, or rate-limited → skip enrichment, write trace log, continue. Lead is never blocked waiting for enrichment.

---

### Path 3: License Validation (Periodic + On Install)

**Trigger:** Install, nightly (or on-demand from UI)

**Process:**
1. Read `LICENCE_KEY` from app variables
2. On install only: `activate(key, deviceFingerprint: <twenty-workspace-id>, deviceName: <workspace-name>)`
   — consumes one activation slot, idempotent on the fingerprint
3. On install + nightly: `validate(key, deviceFingerprint: <twenty-workspace-id>, feature: "enrichment")`
4. Response carries `valid`, `reason`, `hasFeature`. A failed licence is a normal `200` with
   `valid: false` — branch on the boolean, not on HTTP status
5. **Cache locally** in Twenty's app storage (24h TTL)
6. If `valid: false` → write to trace log, disable enrichment, allow rules-only indefinitely.
   `reason: device_not_activated` is recoverable: re-activate, then re-validate
7. If transport error + cache miss → allow rules-only (72h offline grace)

Exact contract, reason codes, and the licence-key-only auth model: `LICENSING_INTEGRATION.md`.

**Fail-open:** Network down? Use cached license. Cache stale? Allow rules-only. Never block the lead gate.

---

### Path 4: Lead Override (Human Review)

**Trigger:** User clicks "Release" on a held lead in gate queue

**Process:**
1. Move lead from "gated" to "ready for outreach"
2. Write override log (who, when, reason/none)
3. Clear the gate flag
4. Lead flows to sales rep

**Audit trail:** Every override logged in Twenty audit (built-in).

---

## Implemented Data Model (v0.1)

Twenty ships **no Lead object** — the standard objects are Person, Company and Opportunity. Greenlight
attaches its gate to **Person**: it is the record a rep actually contacts, it already carries `jobTitle`
(decision-maker signal) and `emails`/`phones` (contactability), and it relates to Company so ICP
industry/region/size can be read through the relation. Company was rejected because gating a company
gates every contact at it; Opportunity because it only exists *after* qualification, downstream of the gate.

Fields grafted onto Person (`isUIEditable: false` — the engine owns these values):

| Field | Type |
|---|---|
| `greenlightScore` | NUMBER, nullable |
| `greenlightDecision` | SELECT |
| `greenlightTrace` | RAW_JSON |

**Field names are camelCase, not snake_case.** Twenty field names are GraphQL identifiers, so the
`greenlight_score` spelling used earlier in this document is not legal. Anything referring to the snake_case
names is stale.

### Layer 3 cannot move these fields at runtime

`defineField` binds a field to an object at **build** time. There is no runtime attachment. So
`GreenlightConfig.leadObjectNameSingular` records which object the workspace *considers* the lead and gates
the **source**-field mapping (`decisionMakerFieldName`, `readyForOutreachFieldName`, `optOutFieldNames`) —
but it cannot relocate the three score fields. v0.1 physically ships them on Person only. Genuine
multi-object support means declaring all three fields three times up front, not flipping a config value.
Nothing downstream should hardcode `person`; read it from the config record.

### The audit log is append-only by convention, not by enforcement

Twenty has no immutability flag. `GreenlightAuditLog` sets `isUICreatable: false` and `isUIEditable: false`,
which stops hand-editing from the CRM UI, but a workspace admin with destroy rights can still delete rows.
Do not claim tamper-proof audit in the security page.

It points at the scored record **polymorphically** — `leadObjectNameSingular` + `leadRecordId` + a
denormalised `leadDisplayName` — rather than by relation. A real relation would mint an inverse field on the
customer's standard object and make the audit row a dependent of the thing it audits. The cost is no
clickable link from an audit row in the UI.

### Defaults live in the field schema

The SDK supports `defaultValue` on field manifests, so the permissive defaults below (empty ICP = everything
qualifies, bands 80/60/40, gate 40, shelf life 30 days) ship in the schema itself. The post-install hook
still has to **create the config record**, but it no longer invents the values.

SDK gotcha: literal string `defaultValue`s must carry their own quotes (`"'PERSON'"`, `"''"`). Bare strings
are reserved for computed defaults (`'uuid'`, `'now'`). `dev:build` warns but does not fail — do not
"correct" these back.

## Configuration Seeding (Post-Install Hook)

On install, `defineApplication` hook runs **once** (idempotent):

1. Create `GreenlightConfig` record with defaults:
   - ICP: all industries/regions/sizes (permissive)
   - Rules: all enabled at default severity
   - Weights: equal distribution
   - Bands: [excellent, good, fair, poor] with neutral thresholds
   - Field shelf-lives: 30 days default

2. Create `GreenlightAuditLog` object (append-only)

3. Map field names to customer's actual lead schema (e.g., "which field is title?")
   - Default mapping: standard lead object field names
   - User refines via config UI if different

4. Return UI message: "Greenlight ready. First lead will score in <10s."

**Idempotency:** If `GreenlightConfig` exists, skip creation. Upgrading later re-runs but skips object creation.

---

## Least-Privilege Role (Twenty RBAC) — as implemented

Twenty has no Lead, Account or Contact objects; the earlier version of this section named objects that do
not exist. Actual grants in `defineApplicationRole`:

| Object | Read | Update |
|---|---|---|
| `person` | ✔ | ✔ |
| `company` | ✔ | — |
| `greenlightConfig` | ✔ | ✔ |
| `greenlightAuditLog` | ✔ | ✔ |

All blanket flags (`canReadAllObjectRecords`, `canUpdateAllObjectRecords`, `canSoftDeleteAllObjectRecords`,
`canDestroyAllObjectRecords`) are `false`. Delete is off everywhere. `ObjectPermissionManifest` has no
create flag — update covers create.

### Field-level least privilege is not achievable, and we did not fake it

`RoleConfig.fieldPermissions` compiles to `restrictedFields: Record<string, {canRead?, canUpdate?}>` on
`ObjectPermissions` (`twenty-sdk/dist/define/index.d.ts` L230, L288). It is a **deny-list layered on an
object grant — there is no allow-list form.** Restricting Greenlight's Person writes to just its three
fields would mean enumerating every *other* Person field as denied, and a workspace's custom fields have
identifiers that do not exist at build time. The deny-list would silently gain holes each time an admin adds
a field.

So the honest position: **Greenlight can write any Person field, and the role does not prevent it.** The
restraint is in the code, not enforced by RBAC. Say this plainly on the security page rather than implying
field-level scoping.

---

## Data Egress (For DPA)

Data leaves customer's Twenty instance only to:

1. **LLM Provider** (customer's choice: OpenAI/Anthropic/etc.)
   - What: Lead fields + search results (lead contact name, company, from search)
   - Key: Customer's own API key
   - Processor: Respective LLM vendor (customer handles their DPA with them)

2. **Search Provider** (customer's choice: Brave/Serper/SearXNG self-hosted)
   - What: Query (company name, person name)
   - Key: Customer's own API key
   - Processor: Respective search vendor (or customer if self-hosted)

3. **Numaya Licensing Service** (one-way phone-home)
   - What: Licence key + workspace ID (as `deviceFingerprint`) + workspace name (as `deviceName`)
   - Where: Numaya Licensing service — base URL TBD, see `LICENSING_INTEGRATION.md`
   - Frequency: `activate` once at install; `validate` on install + nightly (cached 24h)
   - Processor: Numaya. No lead or contact data is sent — only the key and the workspace identifier.

**No other external calls.** Scoring is entirely local to customer's Twenty instance.

---

## Failure Scenarios & Graceful Degradation

| Scenario | Behavior |
|----------|----------|
| LLM provider down | Enrichment skipped, rules-only scoring, trace logged |
| Search provider down | Enrichment skipped (can't get external data), rules-only scoring |
| License service unreachable | Use cached license (24h TTL). If cache miss, allow rules-only. |
| License expired | Enrichment disabled, rules-only scoring allowed (advisory mode) |
| Lead config missing | Use seeded defaults (should never happen post-install) |
| Monthly enrichment cap hit | Enrichment disabled, alert shown in UI, allow rules-only for rest of month |
| Lead lost / record deleted | Not possible (only held in gate queue within Twenty's DB, never remotely) |

**Golden rule:** Lead is never blocked from reaching a rep. Gate is advisory + human-overridable. If system errors, lead passes through unscored but flagged.

---

## Idempotency & Retry Safety

- **Install hook:** Decorated with `@Idempotent()`. Running twice creates zero duplicates. Upgrade re-runs; branching on `previousVersion` avoids re-seeding if only a patch changed.
- **Scoring on lead events:** Idempotency key derived from lead ID + timestamp. Two identical events within 5s window are de-duped by Twenty's event system.
- **License validation:** Cached 24h, no extra calls if cache hit.
- **Enrichment API calls:** Only issue if field shelf-life cache miss + enrichment budget remains. Retries use exponential backoff, capped at 5 min.

---

## Upgrade & Uninstall

**Upgrade:**
- Config records + audit logs persist
- New rules added to defaults if missing (config merge, not replace)
- Installed listeners re-register (no duplicates)
- No data loss

**Uninstall:**
- Delete `GreenlightConfig` + `GreenlightAuditLog` objects
- Remove score/gate fields from Lead object
- Unregister listeners
- Keep audit trail (Twenty CRM's deleted-object backups retain it)

---

## Testing Surface

**What needs testing:**
1. Rules engine (combinatorics of ICP/weights/bands)
2. Enrichment request/response (JSON parsing from LLM + search)
3. License validation (valid/expired/invalid/network-error paths)
4. Fail-open on each provider (LLM down, search down, license down)
5. Field mapping (custom lead object names)
6. Idempotency (duplicate events, retry safety)
7. Upgrade hook (config merge logic)
8. Uninstall (complete cleanup, no orphaned fields)

**CI/CD target:** a disposable Twenty staging instance (docker-compose, or the upstream spawn action in CI) with seeded lead data. Never a production workspace. All paths exercised before release.

---

## No Cluster Dependencies

- No Numaya license service deployment needed (lives on cloud/external)
- No observability stack deployed (customer uses their own, or app emits structured logs to Twenty)
- No message queue deployed (enrichment is inline/async within Twenty)
- No separate auth/identity system (Twenty's workspace auth is the boundary)

**Greenlight is entirely self-contained inside Twenty CRM, runnable anywhere Twenty runs.**
