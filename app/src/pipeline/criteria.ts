/**
 * Stage exit criteria — the path to the next phase.
 *
 * Pure, `now` injected, never throws. Each criterion is a named predicate over
 * data Twenty already holds, and the card shows the arithmetic rather than a
 * verdict: **"3 of 4 met — missing: close date."** A readiness meter that hides
 * which criterion failed is a progress bar, and a progress bar is not an
 * instruction.
 *
 * ## Three states, not two
 *
 * `met` / `unmet` / `indeterminate`. The third is required and is never folded
 * into the second, because "this is missing" sends a salesperson to fix the
 * record and "we could not check this" sends an admin to fix the *app*, and a
 * board that cannot tell them apart wastes both. It is excluded from the
 * readiness denominator for the same reason `src/scoring/engine.ts` excludes an
 * `errored` rule from the score: a check we could not run must never be
 * counted against the record it could not be run on.
 *
 * The mechanical rule that produces it, uniformly, across every criterion here:
 * an input field that is `undefined` was **not read** and yields
 * `indeterminate`; a field that is `null` or empty **was read and is empty**
 * and yields `unmet`. See the note at the top of `types.ts`.
 *
 * ## Cost lives here, not in the ranker
 *
 * Every criterion declares what it costs a human to satisfy. That is a static
 * property of the criterion — booking a call needs someone else's diary and
 * typing a close date does not, and no fact about a particular deal changes
 * that ordering. The ranker sorts on the number; it never decides it. Keeping
 * the two apart is what stops "cheapest first" quietly becoming "whatever the
 * ranker's author found easy to reason about last".
 *
 * ## Why the criteria stop at the transitions they do
 *
 * There are no exit criteria for Captured, Enriching or Held. Those are states
 * the engine is responsible for leaving — score it, enrich it, release it —
 * and a checklist a salesperson cannot tick teaches people to ignore
 * checklists. Their cards get actions from the other tiers of the ranker
 * instead.
 */

import { DEFAULT_GATE_THRESHOLD } from 'src/scoring';

import {
  PIPELINE_LANE_LABELS,
  type Criterion,
  type CriterionResult,
  type CriterionSnapshot,
  type CriterionStatus,
  type PipelineConfig,
  type PipelineConfigInput,
  type PipelineLane,
  type StageReadiness,
  type TraceEntryView,
  type TransitionId,
} from 'src/pipeline/types';

/* -------------------------------------------------------------------------- */
/* Cost                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * What each kind of remedy costs a human, on an arbitrary but ordered scale
 * where lower is cheaper. Only the ordering is meaningful; the gaps are sized
 * so a new criterion can be slotted between two existing ones without
 * renumbering everything.
 *
 * The spec's own example is the acceptance test for this table: "set a close
 * date" must beat "book a second meeting", and it does by seventy points.
 */
export const CRITERION_COST = {
  /** The rep already knows the value. This is typing. */
  SET_A_FIELD: 10,
  /** Choosing an existing record or colleague from a list. */
  PICK_FROM_A_LIST: 15,
  /** Recalling and writing up something that already happened. */
  WRITE_IT_UP: 35,
  /** Research: a fact that exists somewhere and has to be found. */
  LOOK_IT_UP: 45,
  /** Diffuse work — several fields, no single obvious edit. */
  FIX_THE_RECORD: 55,
  /** Needs another person to agree to give you their time. */
  BOOK_A_MEETING: 80,
} as const;

/**
 * Cost turned into the card's `cheapness`, where **higher is cheaper**.
 *
 * The inversion exists so the number on a card reads the way a person expects
 * — a big number is good news — while the ranker keeps sorting on ascending
 * effort. Clamped, so a cost outside the table can never produce a negative
 * cheapness that would sort a badly-declared criterion to the front.
 */
export const cheapnessOf = (cost: number): number => {
  if (!Number.isFinite(cost)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(100 - cost)));
};

/* -------------------------------------------------------------------------- */
/* Expected dwell                                                              */
/* -------------------------------------------------------------------------- */

/**
 * How long a card is expected to sit in each lane before somebody should be
 * nudged, in days.
 *
 * Seeded defaults, editable like any other configuration — "defaults are the
 * feature", and a staleness rule that ships empty never fires. They are
 * deliberately generous at the far end: a fortnight between a discovery call
 * and a proposal is normal in most B2B sales, and a board that shouts on day
 * eight trains its users to ignore the shouting.
 *
 * `customer` is null, meaning the lane never goes stale. A won deal sitting in
 * Customer for two years is not a problem to nag about; it is the point.
 *
 * `enriching` is a single day because it measures a machine, not a person. A
 * card that has claimed to be enriching for more than a day is telling you
 * something is broken, which is exactly what a staleness action is for.
 */
export const DEFAULT_STAGE_DWELL_DAYS: Readonly<
  Record<PipelineLane, number | null>
> = {
  captured: 2,
  enriching: 1,
  held: 3,
  qualified: 7,
  new: 7,
  screening: 14,
  meeting: 14,
  proposal: 21,
  customer: null,
};

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * Repair whatever came out of the configuration record into something every
 * criterion can rely on. Never throws; anything unusable falls back to the
 * seeded default, one key at a time rather than all-or-nothing — a workspace
 * that has typed nonsense into one dwell time should not lose its gate
 * threshold as well.
 */
export const resolvePipelineConfig = (
  input: PipelineConfigInput,
): PipelineConfig => {
  const raw = isPlainObject(input) ? input : {};

  const threshold = finiteNumber(raw['gateThreshold']);
  const dwellRaw = isPlainObject(raw['stageDwellDays'])
    ? raw['stageDwellDays']
    : {};

  const stageDwellDays = { ...DEFAULT_STAGE_DWELL_DAYS } as Record<
    PipelineLane,
    number | null
  >;

  for (const lane of Object.keys(stageDwellDays) as PipelineLane[]) {
    const candidate = dwellRaw[lane];

    if (candidate === null) {
      stageDwellDays[lane] = null;
      continue;
    }

    const days = finiteNumber(candidate);

    if (days !== null && days > 0) {
      stageDwellDays[lane] = days;
    }
  }

  return {
    gateThreshold:
      threshold === null || threshold < 0 || threshold > 100
        ? DEFAULT_GATE_THRESHOLD
        : threshold,
    stageDwellDays,
  };
};

/* -------------------------------------------------------------------------- */
/* Reading the record                                                          */
/* -------------------------------------------------------------------------- */

/** `undefined` → not read. Anything else → read, and possibly empty. */
const wasRead = (value: unknown): boolean => value !== undefined;

const trimmed = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

/** UTC day stamp. Deterministic by construction — no locale, no zone guess. */
export const formatDay = (date: Date): string => date.toISOString().slice(0, 10);

const parseDate = (value: unknown): Date | null => {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/**
 * Pull the entries out of a `greenlightTrace` value, forgivingly.
 *
 * The trace is a RAW_JSON column written by the scoring logic function, and its
 * outer envelope is not pinned down anywhere — `src/gate/release-decision.ts`
 * accepts an array, `{ rules }`, `{ trace }` or `{ entries }` for exactly that
 * reason, and this accepts the same four so the two readers cannot disagree
 * about what a trace is.
 *
 * Entries that do not carry a `ruleId` are dropped rather than repaired. A
 * half-readable trace is a trace we should report as unreadable: guessing a
 * rule's outcome from a partial object is how a card ends up telling somebody
 * their decision-maker check failed when it never ran.
 */
export const readTrace = (trace: unknown): readonly TraceEntryView[] => {
  const candidates: unknown[] = Array.isArray(trace)
    ? trace
    : isPlainObject(trace)
      ? (['rules', 'trace', 'entries']
          .map((key) => trace[key])
          .find((value) => Array.isArray(value)) as unknown[] | undefined) ?? []
      : [];

  const entries: TraceEntryView[] = [];

  for (const candidate of candidates) {
    if (!isPlainObject(candidate)) {
      continue;
    }

    const ruleId = trimmed(candidate['ruleId']);

    if (ruleId === '') {
      continue;
    }

    entries.push({
      ruleId,
      ruleName: trimmed(candidate['ruleName']) || ruleId,
      outcome: trimmed(candidate['outcome']).toLowerCase() as
        TraceEntryView['outcome'],
      severity: trimmed(candidate['severity']).toLowerCase() as
        TraceEntryView['severity'],
      contributed: candidate['contributed'] === true,
      pointsEarned: finiteNumber(candidate['pointsEarned']) ?? 0,
      pointsPossible: finiteNumber(candidate['pointsPossible']) ?? 0,
      explanation: trimmed(candidate['explanation']),
      remedy: trimmed(candidate['remedy']) || null,
    });
  }

  return entries;
};

/** The one rule id the criteria read. Owned by `src/scoring/rules/`. */
export const DECISION_MAKER_RULE_ID = 'contact.decision-maker';

/* -------------------------------------------------------------------------- */
/* Building results                                                            */
/* -------------------------------------------------------------------------- */

interface CriterionDefinition {
  readonly id: string;
  readonly label: string;
  readonly appliesTo: TransitionId;
  readonly cost: number;
  readonly actionKind: Criterion['actionKind'];
  readonly sentence: string;
  decide(snapshot: CriterionSnapshot): {
    readonly status: CriterionStatus;
    readonly evidence: string;
    /** A sharper sentence when the record supplied the specifics. */
    readonly sentence?: string;
  };
}

/**
 * Turn a definition into a `Criterion`, copying the static properties onto
 * every result it produces.
 *
 * The copy is what lets the ranker and the readiness list work on results
 * alone, without holding the catalogue open beside them, and it is why nothing
 * downstream ever has to look a cost up by id.
 */
const define = (definition: CriterionDefinition): Criterion => ({
  id: definition.id,
  label: definition.label,
  appliesTo: definition.appliesTo,
  cost: definition.cost,
  actionKind: definition.actionKind,
  sentence: definition.sentence,
  evaluate: (snapshot: CriterionSnapshot): CriterionResult => {
    const decided = definition.decide(snapshot);

    return {
      criterionId: definition.id,
      label: definition.label,
      transition: definition.appliesTo,
      status: decided.status,
      evidence: decided.evidence,
      cost: definition.cost,
      actionKind: definition.actionKind,
      sentence: decided.sentence ?? definition.sentence,
    };
  },
});

const named = (snapshot: CriterionSnapshot): string =>
  trimmed(snapshot.lead.displayName) || 'this lead';

const company = (snapshot: CriterionSnapshot): string =>
  trimmed(snapshot.lead.companyName) || 'the company';

/* -------------------------------------------------------------------------- */
/* Qualified → New                                                             */
/* -------------------------------------------------------------------------- */

const scoreClearsGate = define({
  id: 'qualified.score-clears-gate',
  label: 'score clears the gate',
  appliesTo: 'qualified_to_new',
  cost: CRITERION_COST.FIX_THE_RECORD,
  actionKind: 'STRENGTHEN_THE_RECORD',
  sentence:
    'Fill in what this record is missing so it can clear your gate, or release it by hand if you already know it is worth working.',
  decide: ({ lead, config }) => {
    if (!wasRead(lead.score)) {
      return {
        status: 'indeterminate',
        evidence: 'the score was not read for this card',
      };
    }

    const score = finiteNumber(lead.score);

    if (score === null) {
      // Never scored is *not* "scored badly". The engine fails open and leaves
      // the field empty; holding that against the lead would invent a verdict
      // out of the engine's own silence.
      return {
        status: 'indeterminate',
        evidence: 'this lead has never been scored, so nothing can be said about the threshold',
      };
    }

    if (score >= config.gateThreshold) {
      return {
        status: 'met',
        evidence: `scored ${score}, at or above your gate threshold of ${config.gateThreshold}`,
      };
    }

    return {
      status: 'unmet',
      evidence: `scored ${score}, below your gate threshold of ${config.gateThreshold}`,
      sentence: `This lead scores ${score} against your gate threshold of ${config.gateThreshold}. Fill in what the record is missing, or release it by hand if you know better than the rules do.`,
    };
  },
});

const companyIdentified = define({
  id: 'qualified.company-identified',
  label: 'company identified',
  appliesTo: 'qualified_to_new',
  cost: CRITERION_COST.PICK_FROM_A_LIST,
  actionKind: 'LINK_THE_COMPANY',
  sentence:
    'Link this person to a company. Until you do, nothing Greenlight knows about the account can reach the card.',
  decide: (snapshot) => {
    const { lead } = snapshot;

    if (!wasRead(lead.companyName) && !wasRead(lead.companyId)) {
      return {
        status: 'indeterminate',
        evidence: 'the company link was not loaded for this card',
      };
    }

    const name = trimmed(lead.companyName);

    if (name !== '') {
      return { status: 'met', evidence: `linked to ${name}` };
    }

    if (trimmed(lead.companyId) !== '') {
      return {
        status: 'met',
        evidence: 'linked to a company, though its name did not come through',
      };
    }

    return {
      status: 'unmet',
      evidence: 'no company on the record',
      sentence: `Link ${named(snapshot)} to a company. Until you do, nothing Greenlight knows about the account can reach the card.`,
    };
  },
});

/**
 * "Contactable" here means *there is an address to write to*, and nothing
 * further. Whether it is a role inbox, whether the domain resolves and whether
 * it has gone stale are all questions the scoring rules already answer, and
 * answering them a second time here would let a card and a score disagree
 * about the same email address.
 */
const contactableEmail = define({
  id: 'qualified.contactable-email',
  label: 'contactable email',
  appliesTo: 'qualified_to_new',
  cost: CRITERION_COST.LOOK_IT_UP,
  actionKind: 'FIND_AN_EMAIL',
  sentence:
    'Find an email address for this contact. Without one there is no way to open the conversation.',
  decide: (snapshot) => {
    const { lead } = snapshot;

    if (!wasRead(lead.email)) {
      return {
        status: 'indeterminate',
        evidence: 'no email address was loaded for this card',
      };
    }

    const email = trimmed(lead.email);

    if (email === '') {
      return {
        status: 'unmet',
        evidence: 'no email address on the record',
        sentence: `Find an email address for ${named(snapshot)}. Without one there is no way to open the conversation.`,
      };
    }

    // Deliberately the weakest possible shape check: something, an @, something
    // with a dot in it. A stricter pattern here would start disagreeing with
    // the `contact.email-valid` scoring rule, and two components rejecting
    // different addresses is worse than one being generous.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return {
        status: 'unmet',
        evidence: `the address on the record (${email}) is not a usable email address`,
        sentence: `Correct the email address on ${named(snapshot)} — "${email}" cannot be written to.`,
      };
    }

    return { status: 'met', evidence: `email on record: ${email}` };
  },
});

/* -------------------------------------------------------------------------- */
/* New → Screening                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Read off the scoring trace rather than re-derived.
 *
 * The engine already decides what a decision-maker is, using the workspace's
 * own configured title lists and whatever vocabulary its licence delivered.
 * Re-implementing the question here would produce a card that contradicts the
 * score on the same record, which is the single most expensive kind of bug this
 * product can ship: it makes the salesperson arbitrate between two parts of the
 * same app.
 *
 * `partial` counts as met because that is precisely how the rule reports an
 * influencer, and the spec asks for "a decision-maker **or influencer**".
 */
const decisionMakerOnRecord = define({
  id: 'screening.decision-maker-on-record',
  label: 'decision-maker on the record',
  appliesTo: 'new_to_screening',
  cost: CRITERION_COST.LOOK_IT_UP,
  actionKind: 'FIND_THE_BUYER',
  sentence:
    'Find who actually signs at this account. The person on the record does not look like someone who can say yes.',
  decide: (snapshot) => {
    const { lead } = snapshot;

    if (!wasRead(lead.trace)) {
      return {
        status: 'indeterminate',
        evidence: 'the scoring trace was not loaded for this card',
      };
    }

    const entry = readTrace(lead.trace).find(
      (candidate) => candidate.ruleId === DECISION_MAKER_RULE_ID,
    );

    if (entry === undefined) {
      return {
        status: 'indeterminate',
        evidence:
          "Greenlight's decision-maker check is not on this lead's trace, so seniority could not be checked",
      };
    }

    if (entry.outcome === 'pass' || entry.outcome === 'partial') {
      return {
        status: 'met',
        evidence:
          entry.explanation ||
          `the decision-maker check passed${trimmed(lead.jobTitle) === '' ? '' : ` on the title "${trimmed(lead.jobTitle)}"`}`,
      };
    }

    if (entry.outcome === 'fail') {
      return {
        status: 'unmet',
        evidence: entry.explanation || 'the decision-maker check failed on this lead',
        sentence: `Find who actually signs at ${company(snapshot)}. ${named(snapshot)} does not look like someone who can say yes.`,
      };
    }

    // skipped / not_applicable / errored — the check did not run, and a check
    // that did not run says nothing about the lead.
    return {
      status: 'indeterminate',
      evidence: `the decision-maker check did not run on this lead (${entry.outcome || 'no outcome recorded'})`,
    };
  },
});

/**
 * The select value that means "we read the field, and nobody has the deal".
 *
 * An explicit UNASSIGNED option exists precisely so a workspace can say "looked,
 * unclaimed" rather than leaving silence — so it must land as `unmet`, the same
 * as an empty value, and not fall through to any fallback.
 */
const AE_UNASSIGNED = 'UNASSIGNED';

/**
 * Ownership is read from the workspace's own AE select, with `ownerId` behind
 * it for workspaces that have one.
 *
 * The AE field holds agent names (`ENTERPRISE_AE_1`, `MID_MARKET_SALES_LEAD`,
 * …), which are not workspace members, so Twenty's `owner` — a member relation
 * — cannot carry them. Where the field exists, it is the answer: a set value
 * other than `UNASSIGNED` is met, and `UNASSIGNED` or an empty value is unmet,
 * full stop, because the workspace has already answered the question and a
 * member id cannot overrule it.
 *
 * Where the field does not exist (`ae` was never read), the criterion falls
 * back to the member-style `ownerId` it originally read, so a workspace that
 * assigns deals through Twenty's owner column keeps exactly the behaviour it
 * had. Neither field present is `indeterminate`, as before.
 */
const ownerAssigned = define({
  id: 'screening.owner-assigned',
  label: 'owner assigned',
  appliesTo: 'new_to_screening',
  cost: CRITERION_COST.PICK_FROM_A_LIST,
  actionKind: 'ASSIGN_AN_OWNER',
  sentence:
    'Put a name against this one. An unowned deal is nobody\'s Monday morning.',
  decide: ({ lead, opportunity }) => {
    const ae = opportunity?.ae;

    if (wasRead(ae)) {
      const assigned = trimmed(ae);

      if (assigned !== '' && assigned.toUpperCase() !== AE_UNASSIGNED) {
        return {
          status: 'met',
          evidence: `the deal is assigned to ${assigned}`,
        };
      }

      return {
        status: 'unmet',
        evidence:
          assigned.toUpperCase() === AE_UNASSIGNED
            ? 'the deal is explicitly unassigned'
            : 'nobody owns this deal',
      };
    }

    const dealOwner = opportunity?.ownerId;
    const leadOwner = lead.ownerId;

    if (!wasRead(dealOwner) && !wasRead(leadOwner)) {
      return {
        status: 'indeterminate',
        evidence: 'no owner field was loaded for this card',
      };
    }

    if (trimmed(dealOwner) !== '') {
      return { status: 'met', evidence: 'the deal has an owner' };
    }

    if (trimmed(leadOwner) !== '') {
      return {
        status: 'met',
        evidence: 'the person has an owner, inherited by the deal',
      };
    }

    return { status: 'unmet', evidence: 'nobody owns this deal' };
  },
});

/* -------------------------------------------------------------------------- */
/* Screening → Meeting                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The one criterion that distinguishes *booked* from *held*.
 *
 * A call in the diary for next Tuesday is not a discovery call that happened,
 * and a board that treated it as one would let a deal reach Meeting on the
 * strength of an invitation nobody has accepted. Both states are `unmet`, but
 * their evidence differs, and the difference is the whole reason the evidence
 * string is free text rather than a code.
 */
const discoveryCallLogged = define({
  id: 'meeting.discovery-call-logged',
  label: 'discovery call',
  appliesTo: 'screening_to_meeting',
  cost: CRITERION_COST.BOOK_A_MEETING,
  actionKind: 'BOOK_A_MEETING',
  sentence:
    'Get the discovery call in the diary. Nothing on this record says anyone has spoken to them yet.',
  decide: (snapshot) => {
    const { opportunity, now } = snapshot;

    if (!Number.isFinite(now.getTime())) {
      // The caller had no usable clock. `src/scoring/engine.ts` records this as
      // a `now_malformed` degradation and skips every time-based rule; the
      // equivalent here is to decline the check rather than guess which side of
      // "now" a logged call falls on.
      return {
        status: 'indeterminate',
        evidence: 'this run had no usable date, so nothing time-based could be checked',
      };
    }

    // Tasks *and* notes, which is what PIPELINE_SPEC.md says and what this
    // criterion read only half of until an end-to-end test asked it directly.
    //
    // The half was not an arbitrary omission, it was the load-bearing half of an
    // argument made elsewhere. `src/default-role.ts` refuses to read
    // `calendarEvent` — answering "has a discovery call happened" from the
    // workspace calendar means reading every meeting in the business to produce
    // one boolean about one deal — and the whole justification for that refusal
    // is that **Task and Note between them** answer the same question from
    // records a human deliberately attached to the deal. Reading tasks alone
    // took the privacy win and then quietly gave up a third of the coverage it
    // was traded for: a rep who writes up a call as a note rather than ticking a
    // task was told nobody had spoken to the account.
    if (
      opportunity === null ||
      (!wasRead(opportunity.lastDiscoveryCallAt) && !wasRead(opportunity.lastNoteAt))
    ) {
      return {
        status: 'indeterminate',
        evidence: 'no tasks or notes were loaded for this deal',
      };
    }

    // Read separately rather than folded into one "latest activity", because
    // they are not interchangeable in the one place that matters. A task carries
    // `dueAt` and can therefore be in the *future* — a call in the diary for next
    // Tuesday is not a call that happened, and that distinction is this
    // criterion's entire reason for existing. A note is written after the fact
    // and has no future form. Collapsing them would let a booked-but-unheld call
    // reach Meeting the moment somebody also left a note.
    const call = wasRead(opportunity.lastDiscoveryCallAt)
      ? parseDate(opportunity.lastDiscoveryCallAt)
      : null;
    const note = wasRead(opportunity.lastNoteAt)
      ? parseDate(opportunity.lastNoteAt)
      : null;

    const held = [call, note].filter(
      (when): when is Date => when !== null && when.getTime() <= now.getTime(),
    );

    if (held.length > 0) {
      const latest = held.reduce((left, right) =>
        left.getTime() >= right.getTime() ? left : right,
      );

      return {
        status: 'met',
        // Named by kind, not by "activity". An admin auditing why a deal was
        // allowed to advance needs to know whether somebody logged a call or
        // merely left a note, and those are different levels of evidence for the
        // same claim.
        evidence:
          call !== null && latest.getTime() === call.getTime()
            ? `discovery call logged ${formatDay(latest)}`
            : `a note was written up ${formatDay(latest)}`,
      };
    }

    if (call !== null) {
      // Every date we have is in the future, so the only one that can be is the
      // task: notes are never future-dated.
      return {
        status: 'unmet',
        evidence: `discovery call booked for ${formatDay(call)}, which has not happened yet`,
        sentence: `The discovery call with ${company(snapshot)} is booked for ${formatDay(call)} and has not happened yet. Hold the card here until it has.`,
      };
    }

    const unreadable = [opportunity.lastDiscoveryCallAt, opportunity.lastNoteAt]
      .filter((raw) => wasRead(raw) && trimmed(raw) !== '')
      .filter((raw) => parseDate(raw) === null);

    if (unreadable.length > 0) {
      return {
        status: 'indeterminate',
        evidence: `the logged activity date (${trimmed(unreadable[0])}) could not be read`,
      };
    }

    return {
      status: 'unmet',
      evidence: 'no discovery call or write-up is logged against this deal',
      sentence: `Get the discovery call with ${company(snapshot)} in the diary. Nothing on this record says anyone has spoken to them yet.`,
    };
  },
});

/* -------------------------------------------------------------------------- */
/* Meeting → Proposal                                                          */
/* -------------------------------------------------------------------------- */

const amountSet = define({
  id: 'proposal.amount-set',
  label: 'amount',
  appliesTo: 'meeting_to_proposal',
  cost: CRITERION_COST.SET_A_FIELD,
  actionKind: 'SET_THE_AMOUNT',
  sentence:
    'Put a number on this deal. An amount of nothing counts for nothing in every pipeline total you will be asked about.',
  decide: ({ opportunity }) => {
    if (opportunity === null || !wasRead(opportunity.amount)) {
      return {
        status: 'indeterminate',
        evidence: 'the amount was not loaded for this deal',
      };
    }

    const amount = finiteNumber(opportunity.amount);

    if (amount === null) {
      return { status: 'unmet', evidence: 'the amount is empty' };
    }

    if (amount <= 0) {
      return { status: 'unmet', evidence: `the amount is set to ${amount}` };
    }

    return { status: 'met', evidence: `amount set to ${amount}` };
  },
});

const closeDateSet = define({
  id: 'proposal.close-date-set',
  label: 'close date',
  appliesTo: 'meeting_to_proposal',
  cost: CRITERION_COST.SET_A_FIELD,
  actionKind: 'SET_THE_CLOSE_DATE',
  sentence:
    'Set a close date. Until there is one this deal has no deadline, and deals without deadlines drift.',
  decide: ({ opportunity }) => {
    if (opportunity === null || !wasRead(opportunity.closeDate)) {
      return {
        status: 'indeterminate',
        evidence: 'the close date was not loaded for this deal',
      };
    }

    if (trimmed(opportunity.closeDate) === '') {
      return { status: 'unmet', evidence: 'close date is empty' };
    }

    const when = parseDate(opportunity.closeDate);

    if (when === null) {
      return {
        status: 'indeterminate',
        evidence: `the close date on the record (${trimmed(opportunity.closeDate)}) could not be read`,
      };
    }

    // A close date in the past is still a close date. Whether it has slipped is
    // the staleness tier's question, and answering it twice would put two
    // contradictory sentences on one card.
    return { status: 'met', evidence: `close date set to ${formatDay(when)}` };
  },
});

const noteSinceMeeting = define({
  id: 'proposal.note-since-meeting',
  label: 'note since the meeting',
  appliesTo: 'meeting_to_proposal',
  cost: CRITERION_COST.WRITE_IT_UP,
  actionKind: 'LOG_THE_NOTE',
  sentence:
    'Write up the meeting. Until you do, what was agreed lives only in your head, and a proposal built on that is a guess.',
  decide: ({ opportunity }) => {
    if (
      opportunity === null ||
      !wasRead(opportunity.lastNoteAt) ||
      !wasRead(opportunity.lastDiscoveryCallAt)
    ) {
      return {
        status: 'indeterminate',
        evidence: 'notes and meetings were not loaded for this deal',
      };
    }

    const meeting = parseDate(opportunity.lastDiscoveryCallAt);

    if (meeting === null) {
      // "Since the meeting" needs a meeting. Without one this is unanswerable
      // rather than failed — the deal may have reached Meeting by hand.
      return {
        status: 'indeterminate',
        evidence: 'there is no meeting date to measure a note against',
      };
    }

    const note = parseDate(opportunity.lastNoteAt);

    if (note === null) {
      return {
        status: 'unmet',
        evidence: `no note has been logged on this deal since the meeting on ${formatDay(meeting)}`,
      };
    }

    if (note.getTime() > meeting.getTime()) {
      return {
        status: 'met',
        evidence: `note logged ${formatDay(note)}, after the meeting on ${formatDay(meeting)}`,
      };
    }

    return {
      status: 'unmet',
      evidence: `the most recent note (${formatDay(note)}) predates the meeting on ${formatDay(meeting)}`,
    };
  },
});

/* -------------------------------------------------------------------------- */
/* The catalogue                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Criteria by transition, in declaration order — which is also the order the
 * readiness list falls back to when two criteria cost the same.
 *
 * `proposal_to_customer` is **empty on purpose and must stay that way**. A
 * human closes a deal; an app does not. Inventing a "signed contract attached"
 * predicate here would be the first step towards Greenlight deciding a deal is
 * won, which the spec rules out in as many words.
 */
export const STAGE_CRITERIA: Readonly<
  Record<TransitionId, readonly Criterion[]>
> = {
  qualified_to_new: [scoreClearsGate, companyIdentified, contactableEmail],
  new_to_screening: [decisionMakerOnRecord, ownerAssigned],
  screening_to_meeting: [discoveryCallLogged],
  meeting_to_proposal: [amountSet, closeDateSet, noteSinceMeeting],
  proposal_to_customer: [],
};

export const ALL_CRITERIA: readonly Criterion[] = [
  ...STAGE_CRITERIA.qualified_to_new,
  ...STAGE_CRITERIA.new_to_screening,
  ...STAGE_CRITERIA.screening_to_meeting,
  ...STAGE_CRITERIA.meeting_to_proposal,
  ...STAGE_CRITERIA.proposal_to_customer,
];

/**
 * The transition a card in this lane is working towards, or null when there
 * isn't one. Captured, Enriching and Held have no checklist (see the header);
 * Customer is the end of the board.
 */
export const transitionForLane = (
  lane: PipelineLane,
): TransitionId | null => {
  switch (lane) {
    case 'qualified':
      return 'qualified_to_new';
    case 'new':
      return 'new_to_screening';
    case 'screening':
      return 'screening_to_meeting';
    case 'meeting':
      return 'meeting_to_proposal';
    case 'proposal':
      return 'proposal_to_customer';
    default:
      return null;
  }
};

export const criteriaFor = (
  transition: TransitionId | null,
): readonly Criterion[] =>
  transition === null ? [] : STAGE_CRITERIA[transition];

/**
 * Run a transition's criteria. Never throws.
 *
 * A criterion that throws is recorded as `indeterminate` and excluded from the
 * denominator, exactly as `src/scoring/engine.ts` records a rule that throws as
 * `errored` and excludes it from the score. A broken predicate must never be
 * able to make a record look worse than it is — that is how a bug in our code
 * turns into a salesperson chasing a customer for a field they already filled
 * in.
 */
export const evaluateTransition = (
  transition: TransitionId | null,
  snapshot: CriterionSnapshot,
): readonly CriterionResult[] =>
  criteriaFor(transition).map((criterion) => {
    try {
      return criterion.evaluate(snapshot);
    } catch (error) {
      return {
        criterionId: criterion.id,
        label: criterion.label,
        transition: criterion.appliesTo,
        status: 'indeterminate' as const,
        evidence: `this check could not run (${error instanceof Error ? error.message : 'unknown error'})`,
        cost: criterion.cost,
        actionKind: criterion.actionKind,
        sentence: criterion.sentence,
      };
    }
  });

/* -------------------------------------------------------------------------- */
/* Readiness                                                                   */
/* -------------------------------------------------------------------------- */

const byCostThenOrder = (
  results: readonly CriterionResult[],
): readonly CriterionResult[] =>
  results
    .map((result, index) => ({ result, index }))
    .sort((a, b) => {
      const byCost = a.result.cost - b.result.cost;

      return byCost === 0 ? a.index - b.index : byCost;
    })
    .map((entry) => entry.result);

const listOf = (results: readonly CriterionResult[]): string =>
  results.map((result) => result.label).join(', ');

const summarise = (
  transition: TransitionId | null,
  met: number,
  total: number,
  unmet: readonly CriterionResult[],
  indeterminate: readonly CriterionResult[],
): string => {
  const unchecked =
    indeterminate.length === 0
      ? ''
      : ` ${indeterminate.length} could not be checked: ${listOf(indeterminate)}.`;

  if (transition === 'proposal_to_customer') {
    return 'Nothing to tick here — a person closes a deal, and Greenlight does not get a vote.';
  }

  if (total === 0) {
    return indeterminate.length === 0
      ? 'There is nothing to check at this stage.'
      : `Greenlight could not check any of the ${indeterminate.length} criteria for this stage: ${listOf(indeterminate)}.`;
  }

  if (unmet.length === 0) {
    return `${met} of ${total} met — this stage is ready.${unchecked}`;
  }

  return `${met} of ${total} met — missing: ${listOf(unmet)}.${unchecked}`;
};

/**
 * The arithmetic, with the unmet criteria in the order they should be worked:
 * cheapest first, declaration order breaking ties.
 *
 * `percent` is null rather than 0 or 100 whenever the denominator is empty. A
 * transition with no criteria and a transition whose every criterion was
 * unreadable are both "we cannot say", and rendering either as a full or an
 * empty bar would be a claim the data does not support. `greenlightReadiness`
 * is left unwritten in that case rather than stamped with a number.
 */
export const readiness = (
  results: readonly CriterionResult[],
  transition: TransitionId | null = null,
): StageReadiness => {
  const safe = Array.isArray(results) ? results : [];

  const met = safe.filter((result) => result.status === 'met');
  const unmet = byCostThenOrder(
    safe.filter((result) => result.status === 'unmet'),
  );
  const indeterminate = safe.filter(
    (result) => result.status === 'indeterminate',
  );

  const total = met.length + unmet.length;
  const resolved =
    transition ?? (safe.length === 0 ? null : safe[0]?.transition ?? null);

  return {
    transition: resolved,
    met: met.length,
    total,
    percent: total === 0 ? null : Math.round((met.length / total) * 100),
    unmet,
    indeterminate,
    results: safe,
    summary: summarise(resolved, met.length, total, unmet, indeterminate),
  };
};

/** Lane heading, re-exported so the card builder has one import fewer. */
export const laneLabel = (lane: PipelineLane): string =>
  PIPELINE_LANE_LABELS[lane];
