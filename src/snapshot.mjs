import { DEFAULT_POLICY, STATUS_MEANING, entitledUnder } from "./policy.mjs";

/* The live snapshot: compare who Stripe says is paying against who the app
 * says is entitled, and price the disagreement.
 *
 * This produces the sales line — "3 canceled users still have Pro, $87 a
 * month" — from the founder's own data, on the founder's own machine. Akeso
 * never holds a key: the Stripe key and database connection come from the
 * project's env, are used read-only, and are never stored or transmitted.
 *
 * The comparison core is pure and fully tested. The two fetchers at the bottom
 * talk to the real world and can only be proven against a real account — that
 * limit is stated here and in the report, not discovered later.
 */

/* A price is a number or it is nothing.
 *
 * A price that arrived as the string "29" once turned the exposure total into
 * "0290" through string concatenation: a number nobody could have produced by
 * measuring anything, presented as dollars. Anything not a finite number
 * becomes null, and null prices are simply left out of the total. */
const priceOf = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/* Account identifiers come from a third-party API and can be any shape. A
   value whose toString throws must not be able to end a sweep. */
function accountKey(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return null;
}

/* stripeSide: [{ account, status, priceMonthly, subscriptionId }]
   appSide:    [{ account, billingEntitled }]
   Returns every disagreement, priced. The status-to-access rules live in
   policy.mjs because two of them are genuinely the merchant's decision. */
export function compareEntitlements(stripeSide, appSide, policy = DEFAULT_POLICY) {
  const app = new Map();
  for (const row of appSide || []) {
    const key = accountKey(row?.account);
    if (key !== null) app.set(key, Boolean(row.billingEntitled));
  }
  const seenInStripe = new Set();

  const payingButLockedOut = [];
  const canceledButEntitled = [];
  const noConclusion = [];

  /* One account can hold several subscriptions. Any one of them that entitles
     the customer entitles the account, so the rows are folded per account
     before anything is compared — otherwise a customer with an old canceled
     plan and a current active one reads as a leak. */
  const byAccount = new Map();
  for (const sub of stripeSide || []) {
    const account = accountKey(sub?.account);
    /* A subscription Akeso cannot tie to an account is not evidence about any
       account. Skipped, never folded into a neighbouring one. */
    if (account === null) continue;
    seenInStripe.add(account);
    const verdict = entitledUnder(sub.status, policy);
    const existing = byAccount.get(account);
    if (!existing) { byAccount.set(account, { ...sub, account, entitled: verdict }); continue; }
    /* true beats null beats false: an entitling subscription always wins, and
       an unconcludable one still blocks a confident "not paying". */
    if (verdict === true || (verdict === null && existing.entitled === false)) {
      byAccount.set(account, { ...sub, account, entitled: verdict });
    }
  }

  for (const sub of byAccount.values()) {
    const entitled = app.get(sub.account);
    if (entitled === undefined) continue; /* unmatched accounts are reported separately, never guessed at */

    const row = { account: sub.account, status: sub.status, priceMonthly: priceOf(sub.priceMonthly), subscriptionId: sub.subscriptionId };

    /* A status we will not draw a conclusion from produces no finding in
       either direction — reported so the founder can see it, never counted. */
    if (sub.entitled === null) { noConclusion.push({ ...row, why: STATUS_MEANING[sub.status]?.note || "unrecognised Stripe status" }); continue; }

    if (sub.entitled && !entitled) payingButLockedOut.push(row);
    else if (!sub.entitled && entitled) canceledButEntitled.push({ ...row, certain: STATUS_MEANING[sub.status]?.certain !== false });
  }

  /* Entitled in the app with no Stripe subscription at all. Could be a leak,
     could be complimentary access — the Check reports, it does not accuse. */
  const entitledWithNoSubscription = [...app.entries()]
    .filter(([account, entitled]) => entitled && !seenInStripe.has(account))
    .map(([account]) => ({ account }));

  /* Only rows with a real, known price contribute. An unknown price adds
     nothing rather than adding a guess. */
  const monthlyExposure = canceledButEntitled
    .reduce((sum, row) => sum + (priceOf(row.priceMonthly) ?? 0), 0);

  return {
    payingButLockedOut,      /* the customer-hurting direction: paid, locked out */
    canceledButEntitled,     /* the money-leaking direction */
    entitledWithNoSubscription,
    noConclusion,            /* statuses the policy refuses to judge */
    monthlyExposure,         /* list-price dollars leaking per month, only from rows with a known price */
    policyVersion: policy.ruleVersion,
    counts: {
      stripeSubscriptions: (stripeSide || []).length,
      appAccounts: (appSide || []).length,
      matched: [...seenInStripe].filter((account) => app.has(account)).length,
    },
    /* "Clean" means every account Akeso could compare agreed. When NOTHING
       could be compared there is no clean bill of health to give: the account
       ids in Stripe and in the app did not line up, and saying "everything
       matches" from zero evidence is the same vacuous pass this project
       refuses everywhere else. */
    clean: payingButLockedOut.length === 0 && canceledButEntitled.length === 0,
    comparable: [...seenInStripe].filter((account) => app.has(account)).length > 0,
  };
}

/* ---- Real-world fetchers. Only proven against a real Stripe account. ---- */

/* Read-only: lists subscriptions with their price. Works with a restricted or
   test key; refuses nothing here because GETs cannot change anything. */
export async function fetchStripeSubscriptions(stripeKey, { accountField = "client_reference_id" } = {}) {
  const rows = [];
  let startingAfter = null;
  for (let page = 0; page < 20; page += 1) {
    const params = new URLSearchParams({ status: "all", limit: "100", "expand[]": "data.items.data.price" });
    if (startingAfter) params.set("starting_after", startingAfter);
    const response = await fetch(`https://api.stripe.com/v1/subscriptions?${params}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    if (!response.ok) throw new Error(`Stripe answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const body = await response.json();
    for (const sub of body.data) {
      const price = sub.items?.data?.[0]?.price;
      rows.push({
        subscriptionId: sub.id,
        account: sub.metadata?.[accountField] || sub.metadata?.account || sub.customer,
        status: sub.status,
        priceMonthly: price?.recurring?.interval === "month" && typeof price.unit_amount === "number"
          ? price.unit_amount / 100
          : null,
      });
    }
    if (!body.has_more) break;
    startingAfter = body.data.at(-1)?.id;
  }
  return rows;
}
