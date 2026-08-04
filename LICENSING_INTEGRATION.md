# Greenlight × Numaya Licensing Integration

## Status

**Verified live, and provisioned.** Everything below was read from or created on the running Numaya
Licensing service on 2026-08-02. Behaviour notes come from an end-to-end smoke test in **Sandbox**, not
from the docs.

**Supersedes** the earlier draft, which assumed `POST https://license.numaya.ai/v1/validate` returning
`scopes` + `quotas`. That endpoint does not exist, and `license.numaya.ai` does not resolve in public DNS.
Discard any code written against it, including the `lic_prod_...` key format — real keys are shaped
`NUMAYA-XXXXX-XXXXX-XXXXX-X`.

*(This line previously quoted a real sandbox key verbatim. That key is revoked, but the literal has been
replaced with the shape. Several tests still search output for its fragments — those are deliberate leak
detectors and should stay.)*

---

## ⚠️ 2026-08-04 — the REST layer, and where this document is now wrong

Everything above and below this section was written from the service's **MCP** interface. The service
publishes an OpenAPI document for its REST API at **`https://licensing.rizvigoc.com/openapi.json`**
(*Numaya Licensing - Customer API*). **That spec, and the live responses recorded here, are authoritative
over the rest of this file.**

**The base URL is `https://licensing.rizvigoc.com`.** Not `license.numaya.ai` — that hostname was a
placeholder that entered our own documentation and was then cited by it. It never existed.

**Auth is settled.** The endpoints accept an API key (`Authorization: Bearer nml_live_…` / `nml_test_…`),
a licence key in the `X-Numaya-License-Key` header *or* the request body `key` field, or a dashboard JWT.
Greenlight's client sends the key in the body, which is valid and needs no `Authorization` header. Sending
`X-Numaya-License-Key` as a header with no body key returned `400`, so keep it in the body.

**Paths are `POST /v1/licenses/validate` and `POST /v1/licenses/activate`,** exactly as shipped.

### Gotcha 4 — a sandbox licence is invisible without `X-Numaya-Environment: sandbox`

One host serves both environments. Measured live with a Sandbox Pro key:

```
POST /v1/licenses/validate  {key, feature}                          → 200  valid:false  reason:license_not_found
POST /v1/licenses/validate  {key, feature} + X-Numaya-Environment: sandbox → 200  valid:true   hasFeature:true
POST /v1/licenses/activate  {key, deviceFingerprint}                → 404  license_not_found
```

`validate` reports the misroute **in band, with HTTP 200 and a plausible rejection**. Read naively that
says "bad key". A sandbox customer would be silently and permanently downgraded to rules-only, the logged
reason would read like a typo, and the fail-open ladder would hide it perfectly. `activate` reports the
same cause out of band, as a `404`.

Header value matching is case-insensitive (`sandbox`, `Sandbox`, `SANDBOX` all worked); an unrecognised
value (`banana`) is ignored and the request is served as production.

### `license_not_found` can never mean "the key has a typo" — measured

| Key sent                                | Response                            |
|-----------------------------------------|-------------------------------------|
| Unknown key, any shape                  | **`401`**, empty body               |
| Real key with one character altered     | **`401`**, empty body               |
| Real key, **wrong environment**         | `200 valid:false license_not_found` |
| Real key, right environment             | `200 valid:true`                    |

The key **is** the credential on these endpoints, so a key the service cannot resolve fails
authentication and never reaches the licence lookup. `license_not_found` is therefore only reachable by a
key that authenticated — it exists and is spelled correctly, and no licence matched it *in the environment
the request asked for*. That is what makes the environment diagnosis honest rather than a guess.

Note also that customer licence keys are `NUMAYA-XXXXX-XXXXX-XXXXX-X` in **both** environments and carry
no sandbox marker. The `nml_live_` / `nml_test_` prefixes belong to org API keys, which Greenlight never
holds. There is no way to infer the environment from the key; the only knowable fact is which environment
*we* asked for.

### The `409` body — this document was right for MCP and wrong for REST

The REST layer sends RFC 7807 problem details, `title` included:

```json
{ "type": "https://httpstatuses.io/409", "title": "max_activations_reached", "status": 409,
  "detail": "Max activations reached for this license.", "instance": "/v1/licenses/activate",
  "retryable": false }
```

The body recorded further down this file (`{ "error": true, "statusCode": 409, … }`, no `title`) is what
the MCP layer returns. Two surfaces, two bodies, one status code — which is why the client matches on
`status === 409` and never inspects the body. That decision survives; only its stated justification changes.

### The spec's `required` list over-promises

`ValidateLicenseResponse` marks nineteen fields `required`, including `reason`,
`gracePeriodDaysRemaining` and `maintenanceExpiryAt`. A healthy live response carried **none** of those
three: `reason` is simply absent when the licence is valid, and the two grace/maintenance fields were
absent from every response observed. A parser written to the spec would have rejected every real response.
Greenlight's tolerant parser was right for a better reason than the one originally given — not "the schema
will drift one day" but "the schema is already wrong today".

Also observed: on a `license_not_found` response the service sends sentinel values, not real state —
`licenseId: 00000000-0000-0000-0000-000000000000`, `type: "Perpetual"`, `status: "Revoked"`. Those are
zero-valued enum defaults for a record that was never resolved. **Do not read `status` from a response
whose `valid` is false and whose reason is `license_not_found`** — it will tell you the licence is revoked
when nothing of the sort happened.

### Still true, and re-confirmed live

- `activate` is idempotent on `deviceFingerprint`: a repeat call returns the existing activation id and
  consumes no second slot.
- A second fingerprint past `maxActivations` returns `409`.
- Validating an unknown feature returns `valid: true, hasFeature: false` with **no** `reason` field —
  confirming the valid/hasFeature independence gotcha in the service itself, not just in the MCP layer.

---

### Provisioning

One product, `Numaya Greenlight`, exists in **both** Sandbox and Production, each carrying three policies:

| Policy | Type | Features | Activations |
|---|---|---|---|
| `Greenlight Trial` | `Trial` | `rules`, `enrichment` | 1 |
| `Greenlight Pro Monthly` | `Subscription` | `rules`, `enrichment` | 1 |
| `Greenlight Rules Only` | `Subscription` | `rules` | 1 |

Sandbox and Production carry **different ids for the same names** — a Sandbox policy id will not resolve in
Production and vice versa, which is a much easier mistake to make than it sounds given the identical
labels. The actual UUIDs are deployment state, not product knowledge; they belong with whoever operates the
licensing organisation, not in this repository.

**No licences were issued in Production.** Production has product + policies only, ready for the checkout
flow to issue against.

### Getting a key to develop against

Issue one from the Sandbox `Greenlight Trial` policy and **keep it out of source** — environment variable
or app variable only, never a committed fixture.

Nothing in the test suite needs a real key: no unit test makes a network call, so the only property any
fixture requires is the *shape*, `NUMAYA-XXXXX-XXXXX-XXXXX-X`. `app/src/licensing/__tests__/fixtures.ts`
uses synthetic same-shape keys for exactly this reason.

> **Two real Sandbox keys were committed on 2026-08-02 and are still in git history.** They have been
> removed from the working tree, which does not remove them from history. They must be revoked
> (`numaya_revoke_license`) and replaced. Sandbox-only, no production entitlement — housekeeping, not an
> incident, but it is not done by deleting a line.

Several tests search output for fragments of the old literals. Those are deliberate leak detectors and
should stay.

### Still open

- ~~**REST base URL.**~~ **Closed 2026-08-04.** It is `https://licensing.rizvigoc.com`, confirmed against
  the published OpenAPI document and by live HTTPS calls. Still shipped as the `LICENCE_API_BASE_URL`
  application variable so a private deployment can be pointed elsewhere.
- ~~**Auth header.**~~ **Closed 2026-08-04.** The licence key in the request body is a supported credential;
  no `Authorization` header is needed. See the REST section above.
- **How to obtain the workspace id.** `currentWorkspace` is a **metadata**-API query, not core — the
  least-verified call in the whole path. Isolated behind a port; a `null` result validates without a
  fingerprint rather than failing.
- **Request field names** (`key`, `deviceFingerprint`, `feature`, `deviceName`) were taken from the
  service's own MCP tool schemas rather than this document, which never specified them.
- **Metering decision** — see "Open design decision" below.

> ### ⚠️ The organisation serves other live products — do not touch them
>
> Greenlight is not the only product in the licensing organisation. At least one other live product, with
> its own policies and real paying customers, sits alongside it. It is unrelated to Greenlight and appears
> in these notes only as a read-only shape example — it is the evidence that `allowedFeatures` works on
> licence types other than `Feature`.
>
> Greenlight has its own product and policy ids. Never issue a Greenlight licence from another product's
> policy, never add Greenlight features to another product, and never edit or deactivate a policy that is
> not Greenlight's. A policy is a template that every licence issued from it inherits, so an edit reaches
> backwards into live customers — which makes a careless one an incident rather than a mistake you can
> quietly revert. After provisioning Greenlight, the neighbouring policies were re-read and confirmed
> byte-for-byte unmodified. Do the same after any provisioning run.

---

## Domain model

```
Organization
  └─ Product            (the thing sold)
       └─ Policy        (template: licenseType, expiry, activation limit, allowedFeatures)
            └─ License  (issued to a customer; carries the key)
                 └─ Activation  (one per deviceFingerprint, consumes a slot)
```

### Policy fields

| Field | Notes |
|---|---|
| `licenseType` | `Perpetual` · `Subscription` · `Trial` · `NodeLocked` · `Offline` · `Feature` · `Usage` · `Floating` |
| `tier` | customer-facing label, inherited by every licence |
| `maxActivations` | activation slots per licence |
| `allowedFeatures` | string[] — required for `Feature` type, **works on other types too**. Our `Subscription` policies carry it, and so does a live `Subscription` policy on a neighbouring product, so this is confirmed in production use rather than inferred |
| `expiryDays` | days from issuance; omit for `Perpetual` |
| `maxUsageQuota` / `overageAllowed` | `Usage` type only |
| `floatingPoolSize` / `leaseTtlMinutes` | `Floating` type only |
| `requireKey` | bool, defaulted `true` |

**Gotcha:** `create_product` does **not** accept a `features` array — products are created with
`features: []`. The feature vocabulary is effectively carried by each policy's `allowedFeatures`, and each
issued licence copies it onto itself. Do not expect `product.features` to be populated for Greenlight.

---

## Runtime contract

### `validate(key, deviceFingerprint?, feature?)`

The only call Greenlight's runtime makes. **Needs no management credential** — just the customer's key.
This is why no org secret ships in the app.

Verified response (Trial licence, `feature: "enrichment"`):

```json
{
  "valid": true,
  "reason": null,
  "licenseId": "<uuid of the licence the key resolved to>",
  "type": "Trial",
  "status": "Active",
  "isTrial": true, "isPerpetual": false, "isSubscription": false,
  "daysRemaining": 14,
  "expiryWarning": false,
  "maintenanceExpired": false,
  "inGracePeriod": false,
  "hasFeature": true,
  "features": ["rules", "enrichment"],
  "activatedCount": 0,
  "maxActivations": 1,
  "expiryAt": "2026-08-16T09:58:42.729898Z",
  "tier": "Pro"
}
```

A failed validation is a normal **`200`**, not an HTTP error. Branch on the boolean.

`reason` when `valid: false`: `revoked` · `suspended` · `expired` · `device_not_activated` ·
`feature_not_licensed` · `quota_exceeded`. `null` when valid.

### ⚠️ The activation limit is unenforceable unless you persist the 409

Found while implementing, and it is the interaction of two facts this document already states separately.

Because validity never consults activation (gotcha 2 below), a workspace refused with `409 Max activations
reached` **still gets `valid: true, hasFeature: true` from `validate`.** So handling the 409 only at install
means the next nightly re-validation silently re-enables the paid feature, and `maxActivations` stops
meaning anything from that night onward.

The 409 must be **persisted and re-applied as an override on every resolution**, after the entitlement
decision, and cleared only by a later successful `activate`. Implemented that way in
`app/src/logic-functions/licence-run.ts`.

The `onInstall()` sketch further down this file returns early on 409 and does **not** do this. Treat that
sketch as illustrative, not as the reference implementation.

### ⚠️ Three behaviours that differ from the documented reason codes

These were confirmed by test and **will cause bugs if implemented from the reason list alone**:

**1. `valid` and `hasFeature` are independent. Gate on both.**

A rules-only licence asked about `enrichment` returns `valid: true` **and** `hasFeature: false` — it does
*not* return `reason: feature_not_licensed`. Conversely a suspended licence returns `valid: false,
reason: "suspended"` while still reporting `hasFeature: true`.

```javascript
// CORRECT
const enrichmentOk = res.valid && res.hasFeature;

// WRONG — enables enrichment on an unlicensed feature
if (res.valid) enableEnrichment();
// WRONG — a suspended licence still reports hasFeature: true
if (res.hasFeature) enableEnrichment();
```

**2. `device_not_activated` does not fire for `Trial` / `Subscription`.**

Validating a brand-new licence **before any activation** returned `valid: true`, `activatedCount: 0`.
Activation is a slot-consumption and enforcement mechanism, not a precondition for validity on these
types. Presumably `NodeLocked` behaves differently — untested. So the "auto-activate on
`device_not_activated`, then re-validate" recovery loop is dead code for our policies. Still call
`activate` at install to consume the slot and register the workspace; just don't make validity depend on it.

**3. Activation-limit error shape.**

The tool description says the error title is `max_activations_reached`. The actual response is:

```json
{ "error": true, "statusCode": 409, "message": "Max activations reached for this license.", "retryable": false }
```

Match on `statusCode === 409`, not on a title string.

### `activate(key, deviceFingerprint, deviceName?)`

Verified idempotent — calling twice with the same fingerprint returned the **same activation id** and
consumed no second slot; only `lastSeenAt` moved. A different fingerprint past the limit returned the 409
above.

Call **once at install**, not per launch.

### Management operations (Numaya side only)

`create_product` · `create_license_policy` · `create_license` · `create_license_batch` · `get_license` ·
`list_licenses` · `suspend` · `revoke` · `reactivate`. A `renew` endpoint exists at
`POST /v1/orgs/current/licenses/{id}/renew` but is not exposed as an MCP tool.

These need an **org-scoped API key or JWT**, which stays in Numaya's checkout/admin flow and
**must never ship inside the Greenlight package**.

`create_product`, `create_license`, `create_license_batch` accept **`idempotencyKey`** — pass the checkout
session id so a retry can never double-issue.

`revoke` is permanent and cannot be undone by `reactivate`. `suspend` is the reversible one.

### Webhooks — `register_webhook_subscription(url, eventTypes?)`

Events: `license.created` · `license.suspended` · `license.revoked` · `license.reactivated` ·
`license.floating_pool_near_capacity` · `license.usage_near_quota`.

Returns a signing secret **once**. Verify the `Numaya-Signature` header: HMAC-SHA256 of `"{timestamp}.{body}"`.

Only needed if Numaya wants push-based revocation rather than waiting for the app's nightly `validate`.
Not required for v1.

---

## Mapping onto Greenlight

### deviceFingerprint = Twenty workspace ID

Greenlight's unit of installation is a Twenty workspace, so the workspace UUID is the stable fingerprint,
and `deviceName` is the workspace display name (gives the admin view something readable).
`maxActivations: 1` therefore means "one workspace per licence" — the per-workspace meter the product plan
calls for. Raise it for multi-workspace customers rather than issuing extra keys.

### Features

`rules` — the deterministic gate; on every policy, the free floor.
`enrichment` — the paid capability; checked with `validate(..., feature: "enrichment")` → `hasFeature`.

### Open design decision — enrichment metering

The plan wants **per-workspace base fee + metered enrichment usage**. A policy carries exactly one
`licenseType`, so `Subscription` and `Usage` can't be combined on one policy. Options:

1. **App-side meter (recommended for v1, and what the provisioned policies assume).** Policies stay
   `Subscription`; enrichment volume is capped by the `MONTHLY_ENRICHMENT_CAP` app variable, enforced
   inside Greenlight. No new licensing surface — but the meter is client-side, so it is advisory; a
   determined customer can raise the cap.
2. **`Usage` policy.** Set `maxUsageQuota` + `overageAllowed`, let the service return `quota_exceeded`,
   subscribe to `license.usage_near_quota`. Server-authoritative. The licence object does expose a
   `usageConsumed` counter, but **no usage-reporting call appears in the MCP tool surface** — confirm the
   service exposes one over REST before committing to this.

Ship on (1), migrate later if metering needs to be enforceable.

---

## Integration points

Assumes a thin `licensing` client over the service's HTTP API (base URL TBD).

### 1. Install hook

```javascript
async function onInstall({ workspaceId, workspaceName }) {
  const key = process.env.LICENCE_KEY;

  if (!key) {
    return seedDefaults({ mode: "rules-only", reason: "no_licence_key" });
  }

  // Idempotent on workspaceId — safe on reinstall. Registers the workspace
  // and consumes a slot; validity does NOT depend on it for our policy types.
  try {
    await licensing.activate({
      key,
      deviceFingerprint: workspaceId,
      deviceName: workspaceName,
    });
  } catch (e) {
    if (e.statusCode === 409) {
      // Licence already bound to another workspace. Real customer state, not a crash.
      return seedDefaults({ mode: "rules-only", reason: "max_activations_reached" });
    }
    throw e;
  }

  const res = await licensing.validate({
    key,
    deviceFingerprint: workspaceId,
    feature: "enrichment",
  });

  return seedDefaults({
    mode: res.valid && res.hasFeature ? "full" : "rules-only",
    reason: res.reason ?? (res.hasFeature ? null : "feature_not_licensed"),
    cachedAt: nowIso(),
  });
}
```

### 2. Nightly re-validation

```javascript
async function validateNightly({ workspaceId }) {
  const key = process.env.LICENCE_KEY;
  if (!key) return;

  try {
    const res = await licensing.validate({
      key,
      deviceFingerprint: workspaceId,
      feature: "enrichment",
    });

    await setCachedValidation({ ...res, cachedAt: nowIso() });

    if (res.valid && res.hasFeature) enableEnrichment();
    else disableEnrichment(res.reason ?? "feature_not_licensed");

    // Surface renewal prompts without waiting for expiry.
    if (res.expiryWarning || res.daysRemaining <= 7) {
      notifyAdmin("licence_expiring", { daysRemaining: res.daysRemaining });
    }
  } catch (err) {
    // Transport failure only — an invalid licence arrives as a 200, not here.
    const cached = await getCachedValidation();
    if (cached && isCacheFresh(cached)) return;              // < 24h: trust cache
    if (cached && withinGracePeriod(cached)) {               // 24–72h: grace
      return disableEnrichment("licence_service_unreachable");
    }
    disableEnrichment("licence_service_unreachable_grace_expired");
  }
}
```

### 3. Scoring path

```javascript
async function scoreAndEnrich(lead) {
  // Deterministic score always runs — no licence check, no external call.
  const score = await scoreLeadDeterministic(lead);

  if (!(await isEnrichmentEnabled())) {
    return { score, scoreOnly: true, reason: await enrichmentDisabledReason() };
  }
  return enrichLead(lead, score);
}
```

The licence gate never sits in front of scoring. A licence problem degrades the product; it does not stop
leads being scored.

---

## Licence key storage

App variable `LICENCE_KEY`, `isSecret: true` — hidden in UI and logs, injected as `process.env.LICENCE_KEY`.

The org-scoped management key is **not** stored in the app at all. `validate` and `activate` need only the
licence key, which is what makes this safe.

---

## Error states & fallback

| State | Behaviour | Duration |
|---|---|---|
| `valid: true` + `hasFeature: true` | Enrichment on | until expiry |
| `valid: true` + `hasFeature: false` | Rules-only + upgrade prompt | until feature added |
| `409` on activate | Rules-only; admin frees a slot or buys a seat | until resolved |
| `reason: expired` / `revoked` / `suspended` | Rules-only, reason shown | until resolved |
| `reason: quota_exceeded` | Enrichment off | until period resets |
| Transport failure, cache < 24h | Cached entitlement | 24h |
| Transport failure, cache 24–72h | Rules-only, grace period | 72h |
| Transport failure, cache > 72h | Rules-only + visible warning | until recovery |

**The window is 72h total, measured from the last _successful_ validation — not 24h *then* a further 72h.**
The first 24h is the full cache; hours 24–72 are rules-only with a warning. Boundaries belong to the
stricter band. Elsewhere this file has been read as implying 96h; 72h total is what is implemented.

A failed call must **never** write the cache. Refreshing `cachedAt` on failure makes both windows
unreachable and the grace period never expires.

**Greenlight never hard-blocks scoring on a licence state.** The earlier draft's "hard block after 72h" is
withdrawn — it contradicts the fail-open rule in `ARCHITECTURE.md` and would lose customer leads during a
Numaya-side outage.

---

## Audit

Every validation logged: timestamp · masked key · `valid` · `hasFeature` · `reason` · cached-vs-live ·
resulting mode. Written to the Greenlight audit log object, queryable by workspace admins.

---

## Remaining provisioning work

1. ~~Confirm REST base URL + auth header.~~ **Closed 2026-08-04** — see the REST section at the top.
2. Decide metering option (app-side vs `Usage`); record the decision.
3. Wire the checkout flow to `create_license` against the **production** policy ids, passing the checkout
   session id as `idempotencyKey`.
4. Optionally register a webhook subscription for push revocation.

---

## Testing checklist

A single Sandbox Trial key covers most of this without issuing anything new.

- [x] `validate` good key → `valid: true`, `reason: null`
- [x] `validate` rules-only licence with `feature: "enrichment"` → `valid: true`, `hasFeature: false`
- [x] `validate` before activation → `valid: true` (no `device_not_activated` for Trial/Subscription)
- [x] `activate` twice, same fingerprint → same activation id, no second slot
- [x] `activate` past `maxActivations` → `409 Max activations reached for this license.`
- [x] `suspend` → `validate` → `valid: false`, `reason: "suspended"`, `hasFeature` still `true`
- [x] `reactivate` → back to `Active`
- [ ] Trial expiry → `reason: expired` (needs a clock-skewed or short-expiry policy)
- [ ] `revoke` → `reason: revoked` (destructive — use a throwaway sandbox licence)
- [ ] Transport failure with fresh cache → cached entitlement used
- [ ] Transport failure past 72h → rules-only, never a hard block
- [ ] `LICENCE_KEY` absent from all logs and from the UI
- [ ] Cache survives app restart
- [ ] Scoring succeeds in every state above
