# Numaya Greenlight

A lead quality gate for [Twenty CRM](https://twenty.com). It scores every lead against rules you configure,
holds the weak ones in a reviewable queue instead of letting them reach a rep, and explains every decision
in language a salesperson can act on.

**The gate is advisory and always human-overridable.** A lead is never lost, never deleted and never
hidden — the worst that happens is it waits for a human. That is a deliberate design constraint, and every
failure path in the app is built around it.

## What it does

- **Deterministic scoring.** Eleven rules across compliance, ICP fit, company identification, contact
  quality and data freshness. Each is independently enable/disable-able with its own severity and weight.
- **A gate queue** of held leads, with an override that records who released it and why.
- **A do-not-contact register.** Twenty does no email management, so Greenlight owns the opt-out list
  itself — who, why, since when — with an audited path to add and remove.
- **Plain-English traces.** Every lead carries a rule-by-rule explanation: what was asked, what was found in
  which field, and what would fix it.
- **Optional enrichment** using your workspace's own AI and your own search provider, writing every value
  with its source URL, retrieval date and confidence. Nothing unsourced is ever written.

## Install

From the Twenty marketplace, or:

```bash
yarn twenty app:install @numaya/greenlight
```

On install it seeds a configuration record with permissive defaults and begins scoring your existing
contacts in the background.

## Configure

It works out of the box. These are all optional:

| Variable | Default | What it does |
|---|---|---|
| `LICENCE_KEY` | — | Your Numaya licence. Without one, Greenlight runs in rules-only mode. |
| `USE_TWENTY_AI` | `true` | Use your workspace's own AI for enrichment. |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | — | An OpenAI-compatible endpoint, used only if Twenty AI is unavailable. |
| `SEARCH_PROVIDER` | `none` | `brave`, `serper`, or `none`. Enrichment needs a real search provider. |
| `SEARCH_API_KEY` | — | Key for the selected search provider. |
| `MONTHLY_ENRICHMENT_CAP` | `1000` | Enrichment runs per month. Reaching it stops enrichment, never scoring. |
| `LICENCE_ENVIRONMENT` | `production` | Leave alone unless Numaya support says otherwise. |

Rules, weights, band thresholds, your ICP and field mapping live in the **Greenlight Configuration** record
in your workspace, editable like any other record.

**Start with the ICP page** in the sidebar. Until you define an industry, region and size profile, three of
the eleven rules have nothing to evaluate and roughly a third of the scoring model is inactive. That page
tells you exactly how much, and offers a profile derived from your own companies.

## What leaves your workspace

Greenlight runs entirely inside your Twenty instance. Data leaves only where you configure it to:

- **Your LLM and search providers**, using your own keys, only during enrichment.
- **Numaya's licensing service**, which receives your licence key and workspace id — never lead or contact
  data — to check entitlement.

Scoring itself makes no external call at all.

## When things break

Greenlight fails open by design. If the licence service is unreachable, a provider times out, the
configuration record is missing or malformed, or a rule throws, leads are still scored — and anything that
could not be evaluated is excluded from the result rather than counted against the lead. A lead that cannot
be scored at all passes through flagged, never silently dropped.

## Support

<support@numaya.ai> · [Changelog](CHANGELOG.md)

---

# Licence — Elastic License 2.0

Source-available. You may read, run, modify and self-host Greenlight. You may not offer it to third parties
as a hosted service, or circumvent the licence key.

The full terms are reproduced here because the Twenty SDK's packer ships a fixed file list — `dist`,
`README.md`, `package.json` and the manifest — with no way to add a `LICENSE` file. ELv2 requires that
anyone who receives the software also receives these terms, so the README is the only place they can travel.
Canonical text: <https://www.elastic.co/licensing/elastic-license>.

**Licensor: Numaya**

**Acceptance.** By using the software, you agree to all of the terms and conditions below.

**Copyright License.** The licensor grants you a non-exclusive, royalty-free, worldwide, non-sublicensable,
non-transferable license to use, copy, distribute, make available, and prepare derivative works of the
software, in each case subject to the limitations and conditions below.

**Limitations.** You may not provide the software to third parties as a hosted or managed service, where the
service provides users with access to any substantial set of the features or functionality of the software.

You may not move, change, disable, or circumvent the license key functionality in the software, and you may
not remove or obscure any functionality in the software that is protected by the license key.

You may not alter, remove, or obscure any licensing, copyright, or other notices of the licensor in the
software. Any use of the licensor's trademarks is subject to applicable law.

**Patents.** The licensor grants you a license, under any patent claims the licensor can license, or becomes
able to license, to make, have made, use, sell, offer for sale, import and have imported the software, in
each case subject to the limitations and conditions in this license. This license does not cover any patent
claims that you cause to be infringed by modifications or additions to the software. If you or your company
make any written claim that the software infringes or contributes to infringement of any patent, your patent
license for the software granted under these terms ends immediately. If your company makes such a claim,
your patent license ends immediately for work on behalf of your company.

**Notices.** You must ensure that anyone who gets a copy of any part of the software from you also gets a
copy of these terms. If you modify the software, you must include in any modified copies of the software
prominent notices stating that you have modified the software.

**No Other Rights.** These terms do not imply any licenses other than those expressly granted in these terms.

**Termination.** If you use the software in violation of these terms, such use is not licensed, and your
licenses will automatically terminate. If the licensor provides you with a notice of your violation, and you
cease all violation of this license no later than 30 days after you receive that notice, your licenses will
be reinstated retroactively. However, if you violate these terms after such reinstatement, any additional
violation of these terms will cause your licenses to terminate automatically and permanently.

**No Liability.** *As far as the law allows, the software comes as is, without any warranty or condition, and
the licensor will not be liable to you for any damages arising out of these terms or the use or nature of the
software, under any kind of legal claim.*

**Definitions.** The **licensor** is the entity offering these terms, and the **software** is the software the
licensor makes available under these terms, including any portion of it. **you** refers to the individual or
entity agreeing to these terms. **your company** is any legal entity, sole proprietorship, or other kind of
organization that you work for, plus all organizations that have control over, are under the control of, or
are under common control with that organization. **control** means ownership of substantially all the assets
of an entity, or the power to direct its management and policies by vote, contract, or otherwise. Control can
be direct or indirect. **your licenses** are all the licenses granted to you for the software under these
terms. **use** means anything you do with the software requiring one of your licenses. **trademark** means
trademarks, service marks, and similar rights.
