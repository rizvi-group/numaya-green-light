# Greenlight Pipeline — specification

Status: design locked 2026-08-06. Supersedes nothing; adds the working surface the
existing engine has always lacked.

## The defect this fixes

Everything Greenlight does today is correct and disconnected. A salesperson has to
visit the gate queue to find held leads, the ICP page to understand why scores look
the way they do, a record page to read a trace, and the command menu to enrich. Four
places, and the connective tissue — *what do I do about this lead, right now* — is
left in the salesperson's head. The app scores; the human still has to think.

The product is not a score. The product is **the next move**.

## Shape

**Twenty CRM is the database.** Greenlight is the application on top of it. No data
lives anywhere else, no object is duplicated, and a workspace that uninstalls
Greenlight keeps every Company, Person and Opportunity intact with only the
Greenlight-prefixed fields removed.

### One board, nine lanes

```
  ── Greenlight owns (derived from Person state) ──┊── Twenty owns (opportunity.stage) ──
   Captured   Enriching   Held   Qualified         ┊  New   Screening   Meeting   Proposal   Customer
```

| Lane | Source of truth | Membership |
|---|---|---|
| Captured | Person | `greenlightDecision = UNSCORED` |
| Enriching | Person | `greenlightEnrichmentStatus` in flight, or enrichable gaps exist |
| Held | Person | `greenlightDecision` in (`GATE`, `BLOCKED`) |
| Qualified | Person | `greenlightDecision = PASS` and no linked Opportunity |
| New … Customer | Opportunity | `opportunity.stage` |

Lanes 1–4 are **derived**, never stored — there is no "pipeline stage" column on
Person to drift out of sync with the decision that produced it. Lanes 5–9 are
Twenty's own field, written by Twenty's own UI as readily as by ours.

The handoff line is real: dragging a Qualified card across it creates the
Opportunity (company + point of contact pre-linked from the Person), and that is
the only way the board writes a new Opportunity.

## Every card carries one next action

Not a status. A sentence a salesperson can act on, and the button that does it.

```
┌─────────────────────────────────────────┐
│ Priya Raman · Northwind Logistics    82 │
│ ─────────────────────────────────────── │
│ Held: role inbox, no decision-maker     │
│ on the record.                          │
│                                         │
│ [ Find the buyer ]  [ Release anyway ]  │
└─────────────────────────────────────────┘
```

### How the action is chosen

`nextAction(lead, opportunity, config, now): RankedAction[]` — **pure**. No network,
no clock, `now` injected, same inputs give the same answer. It ranks over:

1. **Blockers** — compliance suppression, opt-out. Always first, always terminal:
   the only action is "remove the block" and it is not a sales action.
2. **Missing exit criteria** for the current stage (below). The lowest-cost missing
   criterion wins — "set a close date" beats "book a second meeting".
3. **Enrichable gaps** — a field the engine needed, could not resolve, and a
   provider could plausibly find.
4. **Staleness** — days in stage against the stage's expected dwell time.
5. **Score band** — the weakest passing rule, phrased as what would fix it.

The deterministic ranking is the product. The AI layer sits *on top* of it and does
two things only: writes the sentence in the workspace's own language, and — when a
search provider is configured — proposes the research (who the buyer is, what
changed at the company). It never reorders the ranking and never asserts a fact
without a source URL, exactly as enrichment already works.

That split matters commercially as much as technically: with no LLM and no search
provider configured, every card still shows a correct, useful next action. AI makes
it better; its absence does not make the board empty.

## Stage exit criteria — the "path to next phase"

Stored in the Greenlight configuration record, seeded with defaults, editable like
any other config. Each criterion is a named predicate over data Twenty already holds.

| Transition | Criteria |
|---|---|
| Qualified → New | score ≥ gate threshold; company identified; a contactable email |
| New → Screening | a decision-maker or influencer is on the record; owner assigned |
| Screening → Meeting | a discovery call logged (a Twenty Task or Note attached to the deal) |
| Meeting → Proposal | `amount` set; `closeDate` set; a Note logged since the meeting |
| Proposal → Customer | manual — a human closes a deal, an app does not |

The card shows the arithmetic, not a verdict: **"3 of 4 met — missing: close date."**
Same principle as the ICP page. A readiness meter that hides which criterion failed
is a progress bar, and a progress bar is not an instruction.

Advancing is never blocked. A salesperson who knows something the CRM does not can
always drag the card; the app records that the criteria were unmet and who advanced
it anyway. Fail-open, like the gate.

## Capture: three fields, one submit

A drawer, not a page. Company name or website, person name, email. On submit, one
server-side chain:

1. Dedupe against existing Company and Person (domain, then name).
2. Create or link Company; create Person linked to it.
3. Enrich, if a provider is configured and gaps exist.
4. Score, gate, write the trace.
5. Return the placed card.

The salesperson types three fields and gets a scored, explained, placed lead. Every
step is one that exists and is tested today — the drawer is orchestration, not new
capability.

## What gets built

### Fields

On **Opportunity** (all `greenlight`-prefixed, all removed on uninstall):

| Field | Type | Purpose |
|---|---|---|
| `greenlightReadiness` | NUMBER | percent of current stage's exit criteria met |
| `greenlightNextAction` | TEXT | the sentence on the card |
| `greenlightNextActionKind` | SELECT | machine-readable action id, for filtering and for the button |
| `greenlightCriteria` | RAW_JSON | per-criterion met/unmet with evidence |
| `greenlightAdvisedAt` | DATE_TIME | when the advice was last recomputed |

On **Person**: `greenlightNextAction`, `greenlightNextActionKind`, `greenlightAdvisedAt`.
Score, decision, trace, enrichment and suppression fields already exist and are reused.

### Modules

| Path | Kind | Contents |
|---|---|---|
| `src/pipeline/lanes.ts` | pure | lane derivation from Person + Opportunity |
| `src/pipeline/criteria.ts` | pure | criterion predicates, defaults, readiness arithmetic |
| `src/pipeline/next-action.ts` | pure | the ranking |
| `src/pipeline/types.ts` | pure | `PipelineCard`, `RankedAction`, `Criterion` |
| `src/agents/greenlight-next-action.agent.ts` | agent | phrasing + research proposal |
| `src/logic-functions/pipeline-board.logic-function.ts` | I/O | one call returns the whole board |
| `src/logic-functions/pipeline-capture.logic-function.ts` | I/O | the three-field chain |
| `src/logic-functions/pipeline-advance.logic-function.ts` | I/O | move a card, create the Opportunity on handoff, audit |
| `src/logic-functions/pipeline-advise.logic-function.ts` | I/O | recompute advice for a card or the board |
| `src/front-components/greenlight-pipeline.tsx` | UI | the board, the capture drawer, the card detail |
| `src/page-layouts/greenlight-pipeline.page-layout.ts` | metadata | standalone page |
| `src/navigation-menu-items/…` | metadata | **first** sidebar entry, above the gate queue |

### Performance

The board is one logic-function call, not one per card. A workspace with 1,205
people cannot issue 1,205 REST reads to paint a screen — Twenty's limit is 100
requests per minute. The board query pages Person and Opportunity in batches of 60
(the existing backfill's proven batch size), computes every lane and every action in
one pure pass server-side, and returns a single payload. Advice is cached on the
record via `greenlightAdvisedAt` and recomputed on write or on explicit refresh,
never on render.

## Privilege, and one criterion that was weakened to protect it

The board needs the app's role widened: `opportunity` read+write, `company` write
(capture creates one — a reversal of an explicit "read-only, permanently"
commitment, recorded as such in `src/default-role.ts`), and read on
`task`/`taskTarget`/`note`/`noteTarget` for the activity criteria.

**`calendarEvent` was refused.** "Has a discovery call happened" is most accurately
answered from the workspace calendar, and answering it that way means reading every
meeting in the business — attendees, titles, times, the overwhelming majority of them
nothing to do with sales — to produce one boolean about one deal. The criterion is
therefore "an activity was logged against this opportunity", which Task and Note
answer from records a human deliberately attached to it.

The cost is real and belongs on the record: a team that lives in the calendar and
never logs a task will see that criterion sit unmet. That is the correct failure. An
app that widens its reach into a customer's diary to improve one of its own numbers
is making the wrong trade on their behalf.

Write on `task` and `note` stays off for a second reason: an app that could create
the activity could satisfy its own exit criterion, and a readiness number the app can
manufacture is worth nothing.

## What this does not do

- **No email.** Twenty does no email management and neither do we; "send the
  follow-up" is never an action Greenlight offers. It says what to send and to whom.
- **No forecasting.** No probability, no weighted pipeline value. Those are claims
  about the future that a rules engine cannot honestly make.
- **No auto-advance.** Nothing moves a card but a human. The app can say a stage's
  criteria are met; asserting a deal has progressed is a person's call.
