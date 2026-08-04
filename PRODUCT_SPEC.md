# Numaya Greenlight — Product Specification

**Status:** Draft · Nothing built yet  
**Package:** `@numaya/greenlight`  
**Target:** Twenty marketplace (npm distribution)  
**Billing:** Vendor-side (not marketplace)  

---

## Core Value

Lead quality gate for sales CRM. Defines sales-ready standard, blocks unqualified leads before reaching reps, scores/enriches what passes. Configurable rules, weights, ICP per workspace. Optional AI + web search enrichment.

## Technical Architecture

### Three Configuration Layers

**Layer 1: App Variables (secrets)**
- `USE_TWENTY_AI` — boolean, default true (use Twenty's native AI if configured)
- `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` (fallback, optional BYOK)
- `SEARCH_PROVIDER` — Brave | Serper | none (customer configures)
- `SEARCH_API_KEY` (secret, if search provider selected)
- `MONTHLY_ENRICHMENT_CAP` — integer
- `LICENCE_KEY` — purchased from Numaya

**Layer 2: Config Records (CRM-editable)**
- ICP: industries, regions, size bands
- Rule set: enable/disable, severity levels
- Score weights per component
- Band thresholds + SLAs
- Field shelf lives

**Layer 3: Field Mapping (schema-flexible)**
- Which object = lead
- Decision-maker field
- "Ready for outreach" stage
- Opt-out fields

### Provider Abstraction

| Capability | Interface | v1.0 Adapters |
|---|---|---|
| **Reasoning** | Twenty's AI (native) or OpenAI-compatible | Twenty AI (default) · OpenAI · Anthropic · Azure (BYOK fallback) |
| **Search** | `SearchProvider` | Brave · Serper · **none** (rules-only) |

### Failure Modes & Safety

**Fail-open design:**
- License server unreachable → leads pass unscored, flagged
- LLM/search provider down → degrade to rules-only
- Lead never lost, always visible queue

**Production checklist:**
- Idempotency keys on all event-triggered runs
- Per-tenant rate-limit buckets (not global)
- Capped exponential backoff + Retry-After respect
- Circuit breaker per provider
- Hard per-tenant spend cap + alerts (70/85/95% → 100%)
- Structured logs + trace ID per run
- Upgrade safety (idempotent hooks, `previousVersion` branching)
- Uninstall cleanup (removes created objects, preserves data)
- Least-privilege role (only touch necessary objects/fields)

### AI Safety Mitigations

| Risk | Mitigation |
|---|---|
| Indirect prompt injection (OWASP LLM01) | Untrusted content in separate context, scorer only reads validated fields, no writes during extraction |
| Hallucinated enrichment | No unsourced values; every enriched field has source URL + date + confidence. Visually distinct from human data. |
| Cost blowout | Per-tenant cap, model routing (cheap for verification, capable for briefings), caching within field shelf-life |
| Automated decision-making (GDPR Art. 22) | Advisory + override by design; human can always release blocked lead, reason logged |

**Regulatory note:** Sales lead scoring likely NOT high-risk under EU AI Act Annex III (covers employment/credit/education, not sales prospects). Art. 22 applicability to "not being contacted" is unsettled. Override design is cheap insurance. **Get legal counsel before any compliance claims.**

---

## Licensing & Revenue

**License:** Source-available (PolyForm Small Business / BSL 1.1 / Elastic 2.0)
- Public repo required for npm provenance
- Permits self-hosting for small users, blocks commercial resale
- ELv2 forbids removing license-key functionality

**Anti-free-riding:** Server-side value (if scoring is hosted, forking client gains nothing)

**Validation:** Phone-home + offline grace period + cached entitlement

**Meter:** Per-workspace base + pay-for-enrichment usage (not per-seat)

**Price anchor:** Below Twenty's $9/user/month (add-on can't exceed host)

**Trial:** Card required (~31% conversion vs 9% opt-in, 3-5% freemium)

**Infrastructure:** Existing Numaya Licensing service — **verified live 2026-08-02** (product/policy/licence model, `validate` + `activate` + suspend/revoke/reactivate, webhooks). Greenlight is just a client, and needs only the customer's licence key at runtime — no org credential ships in the app. Contract: `LICENSING_INTEGRATION.md`.

---

## Roadmap

| Version | Status | Scope |
|---------|--------|-------|
| **v0.1** | Internal | Rules-only, seeded defaults, gate queue with override. No AI/search/license. Proves deterministic half. |
| **v0.2** | Internal | Enrichment behind provider interface. Two adapters minimum, so the abstraction is exercised rather than assumed. Role re-verification first rule. |
| **v0.3** | Hardening | Multi-tenant: field mapping, per-tenant caps, circuit breakers, trace IDs, fail-open, install/uninstall hooks, Vitest CI. |
| **v0.9** | Pilot | Two external friendly workspaces (non-ICP). Discover local assumptions, rewrite defaults. Full docs + license enforcement. |
| **v1.0** | Listed | Public repo + npm provenance, source-available license, full docs, security page + DPA, 3 real installs, dev-channel launch. |

**Revenue note:** Twenty marketplace is new/small — distribution + trust mechanism, not acquisition channel. Plan for near-zero marketplace revenue Y1. Public repo unlocks dev-audience launches.

---

## Docs Artifacts (Required)

- **Quickstart:** Install → first scored lead, <10min, no AI configured
- **Config reference:** Every variable, every config field, all defaults + rationale
- **Scoring model explainer:** Full weight table public (buyers deserve transparency)
- **Rule catalogue:** Each rule: what/why/fix (same text in-app)
- **Troubleshooting:** Provider errors, rate limits, cap exhaustion, license states, degradation modes
- **Changelog:** Semver + upgrade notes for schema/weight changes
- **Security & Privacy:** Data egress paths, providers, keys, DPA, sub-processor list
- **Support policy:** 1 published 90%+ SLA (honest loose beats missed tight)

---

## Open Technical Questions

| Question | Impact | Resolution |
|----------|--------|-----------|
| Does Twenty marketplace have billing rail? | Decides if we build license+billing | Ask Twenty directly (not in docs) |
| Public source required? | Npm provenance + dev-launch channel | Settled: Yes (enables distribution) |
| Which domain for license/docs/support? | Branding + email deliverability | `numaya.ai` subdomain keeps alignment |
| Sell hosted enrichment service or app-only? | Data processor obligations + DPA | BYOK-only at v1.0. Revisit with demand. |
| Use Skills/Agents (alpha API)? | Moving surface risk | No. Keep prompts in app source. |
| Trademark "Greenlight"? | Brand risk | Run proper search before assets (cheap vs rename) |

---

## Deployment Model

**Embedded in customer's Twenty CRM instance.** No vendor-operated infrastructure is load-bearing. Customer installs via npm → Twenty marketplace. All configuration + execution happens inside customer's Twenty workspace.

### What Greenlight Provides (Self-Contained)

- Scoring engine (rules, weights, ICP, deterministic)
- Configuration UI + data model (CRM objects/fields)
- Fail-open logic (degrade gracefully when external services unavailable)
- License key validation (phone-home with offline grace period + cached entitlement)
- Trace logs visible in Twenty (why lead scored X)

### What Customer Provides (BYOK)

- **LLM provider:** OpenAI | Anthropic | Azure OpenAI | Ollama | vLLM | OpenRouter | any OpenAI-compatible base URL (API key in app variables)
- **Search provider:** SearXNG (self-host) | Brave | Serper (API key in app variables)
- **License key:** From Numaya licensing service — phone-home validation only. No customer data is sent, and no inference runs on vendor infrastructure.

### Embedded Observability (No External Stack)

- Structured logs written to Twenty's app logs (query via Twenty API)
- Trace ID per run, searchable in app
- No external monitoring/alerting (customer operates their own observability if desired)
- Enrichment spend tracked in-app (per-tenant cap checked, alerts shown in CRM UI)

### CI/CD Pipeline (Vendor-Side Only)

- GitHub Actions build + npm publish
- Test against a disposable Twenty staging instance (docker-compose or Twenty's own test env)
- No production cluster access needed
- Provenance publishing (npm public repo, `@numaya/greenlight`)

### Documentation + Support

- Docs-as-code in repo (markdown)
- README → npm → Twenty marketplace listing
- DPA + security page published on `numaya.ai`
- No external issue tracking; support via email/support portal

---

## Dependencies Unknown/Unverified

1. **Twenty marketplace billing infrastructure** — No evidence it exists. Must confirm before pricing.
2. **Twenty install hook lifecycle** — Post-install seeding behavior, upgrade triggers, uninstall cleanup scope
3. **Twenty application role permissions** — Least-privilege boundary (which objects/fields reachable by app)
4. **Twenty API rate limits** — Per-workspace QPS when scoring high-volume lead feeds
5. **License validation endpoint** — Numaya license service phone-home API (create/validate/activate/suspend) availability + rate limits for customer calls
6. **Sub-processor list** — Who touches customer data (OpenAI/Anthropic/Brave/Serper/SearXNG/whatever LLM customer uses)

---

## Assumptions to Validate

### Twenty CRM Platform
- Event handlers complete within timeout (need LLM calls to finish, 10–30s typical)
- App can create custom objects + fields on install (idempotent)
- Least-privilege RBAC is enforced at API level (not just UI)
- Workspace isolation prevents app from reading other workspaces' data
- Field mapping queries available (enumerate Lead object fields for config UI)

### Product Viability
- ICP-agnostic default rule set will transfer across workspaces (v0.9 pilot will test)
- Field shelf-life caching reduces enrichment calls sufficiently
- Fail-open (rules-only mode) is genuinely useful without AI/search
- Override + logging satisfies GDPR Art. 22 "not solely automated"
- Customers will configure field mapping (not all workspaces name leads identically)
- Customers have LLM API keys they're willing to share in app variables (not a blocker; alternatives exist)
