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

/* Which Stripe subscription statuses mean "this customer is paying and should
   have access" under the default policy. past_due sits in the grace period:
   still entitled, flagged separately so the founder sees it. */
const PAYING = new Set(["active", "trialing", "past_due"]);

/* stripeSide: [{ account, status, priceMonthly, subscriptionId }]
   appSide:    [{ account, billingEntitled }]
   Returns every disagreement, priced. */
export function compareEntitlements(stripeSide, appSide) {
  const app = new Map(appSide.map((row) => [String(row.account), Boolean(row.billingEntitled)]));
  const seenInStripe = new Set();

  const payingButLockedOut = [];
  const canceledButEntitled = [];

  for (const sub of stripeSide) {
    const account = String(sub.account);
    seenInStripe.add(account);
    const paying = PAYING.has(sub.status);
    const entitled = app.get(account);

    if (entitled === undefined) continue; /* unmatched accounts are reported separately, never guessed at */

    if (paying && !entitled) {
      payingButLockedOut.push({ account, status: sub.status, priceMonthly: sub.priceMonthly ?? null, subscriptionId: sub.subscriptionId });
    } else if (!paying && entitled) {
      canceledButEntitled.push({ account, status: sub.status, priceMonthly: sub.priceMonthly ?? null, subscriptionId: sub.subscriptionId });
    }
  }

  /* Entitled in the app with no Stripe subscription at all. Could be a leak,
     could be complimentary access — the Check reports, it does not accuse. */
  const entitledWithNoSubscription = [...app.entries()]
    .filter(([account, entitled]) => entitled && !seenInStripe.has(account))
    .map(([account]) => ({ account }));

  const monthlyExposure = canceledButEntitled
    .reduce((sum, row) => sum + (row.priceMonthly || 0), 0);

  return {
    payingButLockedOut,      /* the customer-hurting direction: paid, locked out */
    canceledButEntitled,     /* the money-leaking direction */
    entitledWithNoSubscription,
    monthlyExposure,         /* list-price dollars leaking per month, only from rows with a known price */
    counts: {
      stripeSubscriptions: stripeSide.length,
      appAccounts: appSide.length,
      matched: [...seenInStripe].filter((account) => app.has(account)).length,
    },
    clean: payingButLockedOut.length === 0 && canceledButEntitled.length === 0,
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
