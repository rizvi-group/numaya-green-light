# Greenlight autonomous development loop

Paste the block below after `/loop` (no interval — dynamic mode, so the agent paces itself).

The loop is deliberately **verification-gated**: an item is not done because code was written, it is done
because a Playwright test drove the real Twenty UI and saw the feature work. That is the only rule that
stops a long unattended run from producing a large amount of plausible, untested code.

---

```
Continue building Numaya Greenlight to v1.0. Work from the repository root.

READ FIRST, EVERY ITERATION:
- HANDOFF.md — the live status, findings, and decisions already made. Trust it over your memory.
- The "what's remaining" list at the end of HANDOFF.md is your backlog. Work the top unblocked item.

THE RULE THAT MATTERS — no item is complete until it is visually verified:
1. Build the item.
2. yarn typecheck, yarn lint, yarn test:unit must all pass, and npx twenty dev:build must succeed.
   Run these from app/ on your normal development machine.
3. Sync to your Twenty dev server with `yarn twenty apply`. On Windows this must run inside WSL,
   never natively: `twenty apply` writes backslash path separators into the manifest and the server
   rejects them (upstream wontfix — see "Develop in WSL" in HANDOFF.md). If your WSL checkout is
   separate from your Windows one, commit on Windows first and fetch into WSL before applying,
   or the sync applies stale code and every conclusion after it is wrong.
4. Write or extend a Playwright test that drives the real Twenty UI at your dev server
   (http://localhost:2020 for the standard Twenty dev container) and asserts the feature actually
   works for a user. Take a screenshot. LOOK at the screenshot.
5. Only when that test passes do you mark the item done in HANDOFF.md and move on.

If a Playwright test cannot be written for an item, say why in HANDOFF.md rather than skipping the gate.

RESEARCH BEFORE GUESSING:
- Twenty's live API is authoritative over any documentation. Read it off the instance you are
  working against: <base-url>/open-api/core, <base-url>/open-api/metadata.
  Docs index: https://docs.twenty.com/llms.txt
- Search the Twenty repo before assuming a behaviour is a bug:
  gh search issues --repo twentyhq/twenty <single-keyword>   (multi-word queries return nothing)
- Use WebSearch for anything else. Prefer the live instance over documentation, and documentation
  over memory. If memory and the instance disagree, the instance wins.

STANDING CONSTRAINTS — violating these is worse than not shipping:
- Greenlight runs entirely inside the customer's Twenty instance. NO vendor-operated infrastructure
  may be load-bearing — no vendor database, queue, secret store, observability stack or search
  service. Vendor infrastructure is permitted for CI/CD only.
- Never point anything at a production Twenty workspace. All testing is the throwaway dev container.
- Never modify a product or policy in Numaya licensing that is not Greenlight's — the organisation
  serves other live products, and a policy edit reaches backwards into every licence issued from it.
- SDK is twenty-sdk 2.26.0. The enum exports as FieldType, NOT FieldMetadataType.
- Every universalIdentifier is UUID v4 and PERMANENT. Never edit an existing value.
- Keep the pure/impure split: decision logic pure (no network, no clock, no SDK, `now` injected),
  I/O behind ports. See src/scoring, src/gate, src/licensing, src/backfill.
- Fail-open is the product's core promise: a lead is never lost. Scoring must survive every
  failure of licensing, enrichment, config and providers.
- No secret may ever reach a log, an audit row or an error message.

COMMIT DISCIPLINE:
- Commit each verified item separately, on main, and push.
- Write the commit body as prose explaining WHY, not a list of what changed.
- Update HANDOFF.md in the same commit: mark the item done, record what the live verification showed,
  and add anything you learned that contradicts the specs.

REPORT each iteration, briefly: what you built, what the Playwright run actually showed (not what you
expect it to show), what you learned, and what is next. If something failed, say so with the output.

Stop the loop when the remaining list holds only items that genuinely need a human decision, and say
which ones and why.
```

---

## Notes on running it

- **Playwright is not set up yet.** The first iteration's job is to install it and get one real test
  green. `SIGN_IN_PREFILLED=true` is set on the dev container, so the sign-in form arrives pre-filled —
  check that before building a credential flow.
- **On Windows, run Playwright natively, not in WSL.** The Twenty container publishes `0.0.0.0:2020`
  on Windows Docker, so Windows Playwright reaches it directly and needs no browser dependencies
  installed inside WSL. Only `twenty apply` has to happen in WSL.
- **Wake-up pacing.** Dynamic `/loop` lets the agent choose. A three-minute ceiling is fine but rarely
  useful — a backfill drains at 30 records/minute, so watching it needs one wake per minute at most,
  while a build-and-verify cycle takes far longer than three minutes and finishes with a notification
  anyway. Short intervals mostly produce wake-ups with nothing to do.
- The loop will happily run for a long time. The verification gate is what keeps that safe.
