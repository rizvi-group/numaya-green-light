import type { RuleVerdict, ScoringRule } from 'src/scoring/types';

/**
 * The one check in the product that is not about lead quality.
 *
 * ## What changed, and why it had to
 *
 * This rule used to read a single logical key, `optedOut`, resolved purely
 * through the customer's Layer 3 field mapping. Twenty ships no email management
 * — no unsubscribe handling, no bounce tracking, no do-not-contact list — so on
 * a stock workspace that mapping resolves to nothing at all,
 * `read.booleanAny('optedOut')` returned `null`, and the rule returned `pass`
 * with full credit. The single compliance check in Greenlight could not fire on
 * a default install, and it inflated every score by 15 points while failing to.
 *
 * Greenlight now ships the register itself (`greenlightSuppressed` and friends on
 * Person), and this rule reads it. Two consequences, both deliberate:
 *
 * ## 1. Union, not override
 *
 * Greenlight's field is read *first*, the customer's mapping second, and **any**
 * source saying "suppressed" fails the rule. A workspace that already had an
 * opt-out column keeps it working exactly as before, and gains a second register
 * rather than having its own replaced. There is no precedence question, because
 * for a compliance stop there is no argument in which "the other column says it
 * is fine" is a reason to send the email.
 *
 * A recorded suppression *reason* counts as suppression on its own, even with
 * the boolean cleared. Untick-the-box-but-leave-`SPAM_COMPLAINT`-behind is the
 * realistic hand edit, and reading it as "contactable" would silently re-enable
 * outreach to somebody whose own record still states, in writing, why we
 * stopped. The remedy names both fields so the fix is obvious.
 *
 * ## 2. "Nobody knows" is no longer the same answer as "confirmed clear"
 *
 * The old rule collapsed two very different states onto `pass` with full marks:
 * *this person has not opted out*, and *nothing anywhere in this workspace
 * records whether they have*. The second is not evidence of compliance; it is
 * the absence of a compliance system, and paying 15 points for it is how a
 * decorative check comes to look like a working one.
 *
 * They are now distinguished:
 *
 *   - **Confirmed clear** — Greenlight's register says no entry, or the
 *     customer's own opt-out column says false. `pass`, full credit. `false` on
 *     a Greenlight-owned column is a real assertion about a real register, not
 *     an absence.
 *   - **Genuinely unknown** — neither register is present on the record at all.
 *     `not_applicable`: the engine excludes it from *both* sides of the score, so
 *     the lead is neither credited for evidence it does not have nor punished for
 *     a check nobody could run. The remaining rules are renormalised over the
 *     weight that could actually be evaluated, and the trace says why.
 *
 * `not_applicable` rather than `fail` matters: only a blocking `fail` produces
 * the `blocked` decision, so an unknown never holds a lead. ARCHITECTURE.md's
 * golden rule is that a lead is never lost, and "we could not check" is not a
 * reason to stop somebody working a lead — it is a reason to stop pretending we
 * checked.
 *
 * In practice the unknown branch is what a workspace sees before the suppression
 * fields have synced, or when the engine is driven as a library over a record
 * shape that has neither register. On a synced workspace the field is present on
 * every Person, which is precisely the point: the fix for "this rule cannot fail"
 * is shipping somewhere for the answer to live, not re-weighting the rule.
 */

/** `HARD_BOUNCE` -> `hard bounce`, without importing the gate layer's vocabulary. */
const humaniseReason = (code: string): string =>
  code.trim().toLowerCase().replace(/[_-]+/g, ' ');

const failVerdict = (
  greenlightSays: boolean,
  customerSays: boolean,
  reason: string | null,
): RuleVerdict => {
  const because =
    reason === null ? '' : ` The recorded reason is "${humaniseReason(reason)}".`;

  const explanation = greenlightSays
    ? customerSays
      ? `This person is on Greenlight's do-not-contact list and is also flagged as opted out in your own CRM field.${because} Contacting them is a compliance breach.`
      : `This person is on Greenlight's do-not-contact list.${because} Contacting them is a compliance breach.`
    : 'Your own opt-out field says this person has opted out of contact. Reaching out anyway is a compliance breach.';

  return {
    outcome: 'fail',
    explanation,
    remedy: greenlightSays
      ? 'Do not contact this lead. If the block was recorded in error, use "Allow contact again (Greenlight)" — it clears both the flag and the reason, records who lifted it and why, and re-scores the lead.'
      : 'Do not contact this lead. If the opt-out was recorded in error, correct your own opt-out field on the record and say why; the lead re-scores and clears itself.',
    detail: {
      suppressed: true,
      suppressedByGreenlight: greenlightSays,
      suppressedByCustomerField: customerSays,
      suppressionReason: reason,
      // Kept under the original key so anything already reading the trace for
      // this rule — dashboards, exports, the release path's fallback — is not
      // broken by the new field set.
      optOutRecorded: true,
    },
  };
};

export const complianceOptOutRule: ScoringRule = {
  id: 'compliance.opt-out',
  name: 'Not opted out',
  category: 'compliance',
  question: 'Has this person asked not to be contacted?',
  why: 'Contacting someone who has opted out is a compliance breach and the fastest way to lose a domain reputation. This is the one check that is not about lead quality at all — it is about not doing something you are not allowed to do. Greenlight keeps its own do-not-contact register because Twenty has none, and reads any opt-out field the workspace already had alongside it.',
  defaultEnabled: true,
  defaultSeverity: 'blocking',
  defaultWeight: 15,
  reads: ['suppressed', 'suppressionReason', 'optedOut'],

  evaluate: ({ read }) => {
    // Greenlight's own register first.
    const suppressedFlag = read.booleanAny('suppressed');
    const suppressionReason = read.text('suppressionReason');
    // Then the customer's, wherever their mapping points.
    const optedOut = read.booleanAny('optedOut');

    const greenlightSays = suppressedFlag === true || suppressionReason !== null;
    const customerSays = optedOut === true;

    if (greenlightSays || customerSays) {
      return failVerdict(greenlightSays, customerSays, suppressionReason);
    }

    // Neither register is present on this record. Not a pass — an unanswered
    // question, excluded from the score rather than paid out at full marks.
    if (suppressedFlag === null && optedOut === null) {
      return {
        outcome: 'not_applicable',
        explanation:
          'Nothing on this record says whether this person has asked not to be contacted, so the compliance check could not be answered and was left out of the score rather than passed by default.',
        remedy:
          'Greenlight ships a "Do not contact" field for exactly this. If it is missing here, the app’s fields have not reached this record yet — or point Greenlight at your own opt-out column under Opt-out fields in Greenlight settings.',
        detail: {
          suppressed: false,
          suppressedByGreenlight: false,
          suppressedByCustomerField: false,
          suppressionReason: null,
          optOutRecorded: false,
          suppressionDataAvailable: false,
        },
      };
    }

    return {
      outcome: 'pass',
      explanation:
        suppressedFlag === false
          ? 'Greenlight’s do-not-contact list has no entry for this person, so outreach is permitted.'
          : 'Your opt-out field is clear on this person, so outreach is permitted.',
      detail: {
        suppressed: false,
        suppressedByGreenlight: false,
        suppressedByCustomerField: false,
        suppressionReason: null,
        optOutRecorded: false,
        suppressionDataAvailable: true,
      },
    };
  },
};
