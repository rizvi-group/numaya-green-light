# Twenty CRM Platform Validation Checklist

These are the unknowns blocking implementation. Must validate against live Twenty instance before building.

## App Platform APIs

### Installation & Lifecycle
- [ ] `defineApplication` hook runs post-install, idempotent? (Re-running should not duplicate objects)
- [x] `previousVersion` parameter available in upgrade hook? **Yes** — `InstallPayload` is
      `{ previousVersion?: string; newVersion: string }`, passed to `definePreInstallLogicFunction` and
      `definePostInstallLogicFunction`. Both accept `shouldRunOnVersionUpgrade`; post-install also accepts
      `shouldRunSynchronously`.
- [ ] Uninstall hook receives full context (which objects were created)? — `defineUninstallLogicFunction`
      exists, but its payload is only `{ version?: string }`. It does **not** enumerate created objects.
- [x] Can app create custom objects + fields? **Yes** — `GreenlightConfig` (19 fields) and
      `GreenlightAuditLog` (14 fields) both build and sync.
- [x] Field types available? **Yes, and more than expected.** Application variables accept TEXT, ARRAY,
      BOOLEAN, DATE, DATE_TIME, NUMBER, NUMERIC, RAW_JSON, RICH_TEXT, SELECT, MULTI_SELECT. Object fields
      additionally include ACTOR, ADDRESS, CURRENCY, EMAILS, FILES, FULL_NAME, LINKS, PHONES, RATING,
      RELATION, UUID.
- [x] Can app create fields on existing objects? **Yes** — `defineField` with
      `STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier`. Build-time binding only; there is
      no runtime object selection.

### Event Listeners
- [ ] Event trigger on lead created/updated? (Need to score new leads)
- [ ] Event includes full lead record data?
- [ ] Can event listener write back to the record that triggered it?
- [ ] Listener retry behavior on error? (Should fail silently, not block the UI)
- [ ] Max payload size for event handler? (Search results + LLM context could be large)

### Configuration Storage
- [ ] Application variables typed (TEXT, NUMBER, SELECT, SECRET)?
- [ ] `isSecret: true` hides value in UI + logs?
- [ ] Variables injected as `process.env.*` strings?
- [ ] Can app read variables within event handlers (synchronously)?

### Least-Privilege RBAC
- [ ] `defineApplicationRole` limits scope to specific objects/fields?
- [ ] Role enforced on app's API calls (not just UI)?
- [ ] Can role read but not write certain objects?

### Logging & Audit
- [ ] App can write to CRM audit log (who, what, when)?
- [ ] App can emit structured logs (queryable by timestamp + app name)?
- [ ] Logs retained for 30 days minimum?

---

## Lead Object Schema

### Standard Fields (Must Exist or Be Configurable)
- [ ] Company object exists (for ICP: industry, size, revenue, region)?
- [ ] Lead object links to Company?
- [ ] Lead has standard fields: firstName, lastName, email, phone?
- [ ] Lead has decision-maker indicator field (or custom mapping)?
- [ ] Lead has pipeline/stage field (standard naming)?
- [ ] Lead has source field (to track where lead came from)?

### Custom Fields We Add
- [x] Can we add computed/read-only fields to lead? **Yes** — `isUIEditable: false`. Shipped on Person:
  - `greenlightScore` (NUMBER 0–100, nullable)
  - `greenlightDecision` (SELECT)
  - `greenlightTrace` (RAW_JSON: rule-by-rule breakdown)
  - Note: names must be camelCase — Twenty field names are GraphQL identifiers.
- [x] Can we add a relationship field (lead → GreenlightAuditLog)? **Possible but rejected** — a relation
  mints an inverse field on the customer's standard object. Using a polymorphic pointer instead.

### Field Mapping Flexibility
- [ ] API to enumerate all fields on an object (needed for config UI)?
- [ ] Customer can map "which field is the title?" → field selection UI?
- [ ] App can dynamically read/write to renamed fields?

---

## API Rate Limits & Performance

### GraphQL / REST API
- [ ] What's the rate limit? (Per workspace? Per API key?)
- [ ] How to handle rate limit errors (Retry-After header)?
- [ ] Batch query support (fetch 100 leads in one call)?
- [ ] Max query/mutation payload size?

### Webhook / Event Delivery
- [ ] Guaranteed delivery? (What if app crashes mid-event?)
- [ ] Timeout for event handler? (How long can scoring take?)
- [ ] Retry on handler failure? (How many times? Backoff?)
- [ ] Dedup on re-delivery? (Need idempotency key in our code)

---

## Marketplace & Distribution

### npm Publishing
- [ ] Provenance signing works from public repo only?
- [ ] `@numaya` npm scope claimable today (before release)?
- [ ] npm package metadata (README, keywords, license) auto-pulls from package.json?

### Twenty Marketplace
- [ ] Marketplace has billing rail (payment processor)? (**Critical unanswered**)
- [ ] If yes: automatic billing to customer card, splits between Numaya + Twenty?
- [ ] If no: we handle billing ourselves (license server, metering)?
- [ ] How does marketplace "distribution" work (app discovery, installation)?
- [ ] Can app be listed without using marketplace billing? (e.g., docs say "buy from numaya.ai, install here")?

---

## License Key Validation

### Phone-Home Design
- [ ] Numaya license service API available? (create/validate/activate/suspend endpoints)
- [ ] Rate limits on validate endpoint? (Customer calls it nightly, could be thousands of customers)
- [ ] Request/response format documented?
- [ ] Can customer use offline mode (grace period) if license service down?

### Integration
- [ ] Where do we store license key? (App variables as SECRET?)
- [ ] Can app make HTTPS requests from within Twenty? (firewall, proxy considerations?)
- [ ] TLS cert validation required (not self-signed)?

---

## Data & Privacy

### Customer Data Isolation
- [ ] Workspace-level isolation enforced? (App can only access its own workspace's data)
- [ ] No cross-workspace data leakage?

### Audit Trail
- [ ] Every app action logged (who triggered it, timestamp, what changed)?
- [ ] Audit log retained per retention policy?
- [ ] Deleted objects soft-deleted (audit trail preserved)?

### Data Egress
- [ ] Customer data never leaves their workspace unless app explicitly calls external API?
- [ ] No telemetry home (Twenty can't see customer's data)?
- [ ] No automatic backups to external services?

---

## Stability & Scaling

### Lead Volume
- [ ] Can Twenty handle 1000 lead creates/updates per day (event triggers)?
- [ ] Event queue unbounded or rate-limited?
- [ ] If app scoring takes 5s per lead, does Twenty queue events or drop them?

### App Lifecycle
- [ ] App can disable itself gracefully (e.g., license invalid → rules-only, no enrichment)?
- [ ] App doesn't bring down Twenty if it crashes (sandboxed process)?
- [ ] App errors don't cascade to other apps?

---

## Implementation Risk

**Must-validate before code:**
1. **Marketplace billing** — If no rail exists, we build billing ourselves (Numaya license server already exists, low risk). But if one exists + has different terms, pivoting is expensive.
2. **Event handler timeout** — If timeout is 1s, LLM calls (which can take 10s) won't work. Redesign needed (async queue).
3. **Least-privilege role enforcement** — If role is only UI-enforced (not API), data access isn't truly scoped. Security risk.
4. **Workspace isolation** — If app can see other workspaces' data, multi-tenant fails. Deal-breaker.

---

## Questions to Ask Twenty Team

1. **Marketplace:** Do you have a payment processor integrated? Can vendors set their own pricing?
2. **App platform:** What's the event handler timeout? Can we call external APIs from within handlers?
3. **Field mapping:** Can an app query "all fields on Lead object" so we can build a config UI?
4. **Rate limits:** Per-workspace API rate limits? Can we batch 100 leads in one query?
5. **RBAC:** Is `defineApplicationRole` enforced at the API level or only in UI?
6. **Offline:** If the app can't reach an external service (LLM, search, license), what's our responsibility? Can we degrade gracefully?

## Licensing Service Validation

**Status: RESOLVED (2026-08-02).** Service is live, contract verified by end-to-end smoke test, and the
`Numaya Greenlight` product + three policies are provisioned in both Sandbox and Production.
Full contract and the behaviours that will bite you: `LICENSING_INTEGRATION.md`.

- [x] Licensing service exists and is reachable
- [x] Request/response schema confirmed against the live service
- [x] Authentication model confirmed — `validate`/`activate` need only the customer's licence key,
      so no org credential ships in the app
- [x] `suspended` / activation-limit / feature-absent responses tested
- [x] **REST base URL + auth header confirmed (2026-08-04)** — the contract had been exercised via MCP
      only. Both were settled against the service's published OpenAPI document and by live HTTPS calls;
      see `LICENSING_INTEGRATION.md`. The base URL ships as the `LICENCE_API_BASE_URL` application
      variable so a private deployment can be pointed elsewhere.
- [ ] Rate limits on `validate` not yet established (app calls it nightly per workspace)
- [ ] Offline grace behaviour (24h cache → 72h grace) is Greenlight-side, still to be built + tested
- [ ] Enrichment metering model undecided (app-side cap vs `Usage` policy) — see `LICENSING_INTEGRATION.md`
