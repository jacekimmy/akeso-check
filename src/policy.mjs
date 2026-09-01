/* What each Stripe subscription status means for access.
 *
 * This is the single most dangerous table in the product, because a wrong
 * answer here either locks out a paying customer or reports a false leak. Two
 * of the rows are genuinely the merchant's decision, not ours, and pretending
 * otherwise is how a monitor starts crying wolf.
 *
 * Sourced from Stripe's documented subscription lifecycle:
 *   - `unpaid` is the one unambiguous revoke.
 *   - `past_due` depends on the merchant's own dunning settings.
 *   - `active` covers a subscription that is set to cancel at period end —
 *     the customer paid for that period and keeps access until it ends. A
 *     naive "canceled in Stripe, entitled in app" comparison fires a false
 *     alarm on every pending cancellation, which is most cancellations.
 */

export const STATUS_MEANING = {
  trialing: { entitled: true, certain: true, note: "in a trial the merchant granted" },
  active: { entitled: true, certain: true, note: "paying, including subscriptions set to cancel at period end" },
  past_due: { entitled: true, certain: false, note: "a payment failed and Stripe is retrying; the grace period is your policy" },
  unpaid: { entitled: false, certain: true, note: "retries are exhausted" },
  canceled: { entitled: false, certain: true, note: "over" },
  incomplete_expired: { entitled: false, certain: true, note: "the first payment never completed" },
  incomplete: { entitled: false, certain: false, note: "the first payment is still in a 23-hour window" },
  paused: { entitled: false, certain: false, note: "collection is paused; whether access continues is your policy" },
};

export const DEFAULT_POLICY = {
  /* The two the merchant really does decide. Defaults chosen to be the
     forgiving option, because the cost of wrongly keeping access is a few
     dollars and the cost of wrongly removing it is a furious customer. */
  entitledWhilePastDue: true,
  entitledWhilePaused: false,
  /* Statuses we will not draw a conclusion from at all. An account sitting in
     one of these is reported, never actioned and never counted as leakage. */
  neverConclude: ["incomplete"],
  ruleVersion: "1",
};

/* Does this status mean the customer should have access under this policy?
   Returns null for "do not conclude", which callers must handle as its own
   case rather than as a false. */
export function entitledUnder(status, policy = DEFAULT_POLICY) {
  /* Whatever arrives here came from an API response, so it can be any shape at
     all. Two ways that used to hurt: a value whose toString throws took the
     whole sweep down, and a key like "constructor" or "toString" resolved
     against the prototype chain and returned a function that read as a
     meaning. Both now fall through to "no conclusion". */
  if (typeof status !== "string") return null;
  if (!Object.hasOwn(STATUS_MEANING, status)) return null;
  if ((policy.neverConclude || []).includes(status)) return null;
  if (status === "past_due") return policy.entitledWhilePastDue;
  if (status === "paused") return policy.entitledWhilePaused;
  return STATUS_MEANING[status].entitled;
}

/* The plain-English description of the policy in force, printed before a sweep
   acts on anything. A founder who cannot see the rule cannot correct it. */
export function describePolicy(policy = DEFAULT_POLICY) {
  return [
    `Paying (keeps access): active, trialing${policy.entitledWhilePastDue ? ", past_due" : ""}.`,
    `Not paying (access should end): unpaid, canceled, incomplete_expired${policy.entitledWhilePaused ? "" : ", paused"}.`,
    `No conclusion drawn: ${(policy.neverConclude || []).join(", ") || "none"}.`,
    `A subscription set to cancel at period end still counts as paying until the period actually ends.`,
  ];
}
