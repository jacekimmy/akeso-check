import { signPayload } from "./stripe-events.mjs";
import { gradeOf } from "./lifecycle.mjs";

/* The sandbox driver: the highest-fidelity lifecycle test.
 *
 * Where the local driver synthesises Stripe-shaped events, this one creates
 * REAL customers and subscriptions in the founder's own Stripe test sandbox
 * and lets Stripe author the events. Time is moved forward with a Stripe test
 * clock, so trial conversion and a real monthly renewal happen the way they
 * happen in production. We then fetch those events from Stripe's API and
 * deliver them to the running app, signed with the app's own webhook secret —
 * so no Stripe CLI login and no public tunnel is needed. The payloads are
 * Stripe's, byte for byte.
 *
 * Safety rails, in order of importance:
 * - refuses to run with anything but a test-mode key, checked here and not
 *   only at the call site
 * - everything it creates lives on one tagged test clock and is deleted
 *   afterwards (deleting the clock deletes its customers and subscriptions)
 * - it writes only to the founder's own test sandbox, never to the app
 */

const API = "https://api.stripe.com/v1";

function assertTestKey(key) {
  if (!/^(sk|rk)_test_/.test(key || "")) {
    throw new Error("The sandbox driver refuses to run without a test-mode key (sk_test_…). This is not configurable.");
  }
}

async function stripe(key, method, path, params = {}) {
  const body = new URLSearchParams();
  const add = (name, value) => {
    if (value === undefined || value === null) return;
    if (typeof value === "object") for (const [k, v] of Object.entries(value)) add(`${name}[${k}]`, v);
    else body.append(name, String(value));
  };
  for (const [name, value] of Object.entries(params)) add(name, value);

  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(method === "GET" ? {} : { "Content-Type": "application/x-www-form-urlencoded" }),
    },
    ...(method === "GET" ? {} : { body }),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`Stripe ${method} ${path} -> ${response.status}: ${json.error?.message || "unknown"}`);
  return json;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Find-or-create the test plan the driver subscribes to. Idempotent through a
   lookup key, so repeated runs reuse one price instead of littering the
   founder's sandbox. */
async function ensureTestPrice(key) {
  const existing = await stripe(key, "GET", "/prices?lookup_keys[]=akeso-check-monthly&limit=1");
  if (existing.data.length) return existing.data[0];
  const product = await stripe(key, "POST", "/products", {
    name: "Akeso Check test plan (safe to delete)",
    metadata: { akeso: "check" },
  });
  return stripe(key, "POST", "/prices", {
    product: product.id,
    unit_amount: 2900,
    currency: "usd",
    recurring: { interval: "month" },
    lookup_key: "akeso-check-monthly",
    metadata: { akeso: "check" },
  });
}

/* Stripe events relevant to our customers, oldest first, authored by Stripe. */
async function eventsFor(key, { customerIds, since }) {
  const page = await stripe(key, "GET", `/events?limit=100&created[gte]=${since - 5}`);
  return page.data
    .filter((event) => {
      const object = event.data?.object || {};
      return customerIds.has(object.customer) || customerIds.has(object.id);
    })
    .sort((a, b) => a.created - b.created);
}

async function deliverAll(events, { webhookUrl, webhookSecret, alreadyDelivered }) {
  const delivered = [];
  for (const event of events) {
    if (alreadyDelivered.has(event.id)) continue;
    alreadyDelivered.add(event.id);
    const rawBody = JSON.stringify(event);
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signPayload(rawBody, webhookSecret) },
      body: rawBody,
    });
    delivered.push({ id: event.id, type: event.type, status: response.status, ok: response.ok });
    await sleep(60);
  }
  return delivered;
}

async function probe(probeUrl, account) {
  /* A probe deployed on a public app carries a guard token in its URL, so the
     account parameter joins with & when a query already exists. */
  const joiner = probeUrl.includes("?") ? "&" : "?";
  const response = await fetch(`${probeUrl}${joiner}account=${encodeURIComponent(account)}`);
  const body = await response.json();
  return Boolean(body.billingEntitled);
}

/* Move the test clock forward and wait until Stripe has finished generating
   the consequences (renewal invoices, status flips). Advancing is
   asynchronous; the clock reports "ready" when it settles. */
async function advanceClock(key, clockId, frozenTime, log) {
  await stripe(key, "POST", `/test_helpers/test_clocks/${clockId}/advance`, { frozen_time: frozenTime });
  for (let i = 0; i < 60; i += 1) {
    await sleep(2000);
    const clock = await stripe(key, "GET", `/test_helpers/test_clocks/${clockId}`);
    if (clock.status === "ready") return;
    if (i % 5 === 4) log(`waiting for the test clock to settle (${clock.status})…`);
  }
  throw new Error("the test clock did not finish advancing in time");
}

const DAY = 86400;

/* Subscribe -> trial converts -> monthly renewal -> cancel-at-period-end ->
 * cancel-now, with the app's entitlement read after each phase. Two real
 * customers ride one test clock: one paying from day zero (grant, renewal,
 * cancellation), one on a 7-day trial (conversion). */
export async function runSandboxLifecycle({ stripeKey, webhookUrl, probeUrl, webhookSecret, log = () => {} }) {
  assertTestKey(stripeKey);
  const started = Math.floor(Date.now() / 1000);
  const alreadyDelivered = new Set();
  const customerIds = new Set();
  const phases = [];
  const accessEverGranted = {};
  let clockId = null;

  try {
    const price = await ensureTestPrice(stripeKey);
    log(`test plan ready: ${price.id}`);

    const clock = await stripe(stripeKey, "POST", "/test_helpers/test_clocks", {
      frozen_time: started,
      name: "Akeso Check (safe to delete)",
    });
    clockId = clock.id;

    const makeCustomer = async (name) => {
      const customer = await stripe(stripeKey, "POST", "/customers", {
        name,
        test_clock: clockId,
        metadata: { akeso: "check" },
      });
      customerIds.add(customer.id);
      const pm = await stripe(stripeKey, "POST", "/payment_methods/pm_card_visa/attach", { customer: customer.id });
      await stripe(stripeKey, "POST", `/customers/${customer.id}`, {
        "invoice_settings[default_payment_method]": pm.id,
      });
      return customer.id;
    };

    const payer = await makeCustomer("Akeso Check synthetic customer (paying)");
    const trialer = await makeCustomer("Akeso Check synthetic customer (trial)");

    const subscription = await stripe(stripeKey, "POST", "/subscriptions", {
      customer: payer,
      "items[0][price]": price.id,
      metadata: { akeso: "check" },
    });
    log(`subscribed: ${subscription.id} (${subscription.status})`);

    const trialSubscription = await stripe(stripeKey, "POST", "/subscriptions", {
      customer: trialer,
      "items[0][price]": price.id,
      trial_period_days: 7,
      metadata: { akeso: "check" },
    });
    log(`trial subscription: ${trialSubscription.id} (${trialSubscription.status})`);

    const runPhase = async (name, account, expected, { critical = false } = {}) => {
      /* Stripe writes events asynchronously; poll until deliveries go quiet
         rather than assuming one batch is everything (a clock advance emits
         several events seconds apart). */
      let delivered = [];
      let quiet = 0;
      for (let i = 0; i < 25 && quiet < 2; i += 1) {
        await sleep(1200);
        const fresh = await deliverAll(
          await eventsFor(stripeKey, { customerIds, since: started }),
          { webhookUrl, webhookSecret, alreadyDelivered },
        );
        delivered = [...delivered, ...fresh];
        quiet = fresh.length ? 0 : delivered.length ? quiet + 1 : 0;
      }
      const observed = await probe(probeUrl, account);
      if (observed) accessEverGranted[account] = true;

      /* Honesty rails, same doctrine as everywhere in this project:
         - no events arrived, or every delivery was rejected -> the app was
           never told, so nothing about it was tested. Ours, not theirs.
         - a removal phase on an account that never had access proves nothing
           (the vacuous-pass guard). */
      const neverExercised = delivered.length === 0
        ? "no Stripe events arrived for this phase in time; the app was never told"
        : delivered.every((d) => !d.ok)
          ? `every delivery was rejected (${[...new Set(delivered.map((d) => d.status))].join(", ")}); the lifecycle was never exercised`
          : null;
      const removalPhase = expected === false;
      const outcome = neverExercised
        ? "could_not_test"
        : removalPhase && !accessEverGranted[account]
          ? "not_provable"
          : observed === expected ? "pass" : "fail";

      phases.push({
        phase: name,
        expected,
        observed,
        outcome,
        critical,
        ...(outcome === "could_not_test" ? { reason: neverExercised } : {}),
        ...(outcome === "not_provable" ? { reason: "access was never granted, so its removal cannot be tested" } : {}),
        eventsDelivered: delivered.map((d) => d.type),
      });
      log(`${name}: expected ${expected}, app says ${observed} -> ${outcome}`);
    };

    const skipPhase = (name, expected, reason, { critical = false } = {}) => {
      phases.push({ phase: name, expected, observed: null, outcome: "could_not_test", critical, reason, eventsDelivered: [] });
      log(`${name}: could not test (${reason})`);
    };

    await runPhase("real subscription grants access", payer, true);

    /* Day 8: the trial ends and converts to a paying subscription. */
    let clockBroken = null;
    try {
      log("advancing the test clock 8 days (trial ends)…");
      await advanceClock(stripeKey, clockId, started + 8 * DAY, log);
    } catch (error) { clockBroken = error?.message || String(error); }
    if (clockBroken) skipPhase("trial ends and converts to a paying subscription", true, clockBroken);
    else await runPhase("trial ends and converts to a paying subscription", trialer, true);

    /* Day 32: the paying customer's first monthly renewal has happened. */
    if (!clockBroken) {
      try {
        log("advancing the test clock to day 32 (monthly renewal)…");
        await advanceClock(stripeKey, clockId, started + 32 * DAY, log);
      } catch (error) { clockBroken = error?.message || String(error); }
    }
    if (clockBroken) skipPhase("monthly renewal keeps access", true, clockBroken);
    else await runPhase("monthly renewal keeps access", payer, true);

    /* Cancellation needs no clock: these run even if advancing broke. */
    await stripe(stripeKey, "POST", `/subscriptions/${subscription.id}`, { cancel_at_period_end: true });
    await runPhase("cancel at period end keeps access until the period ends", payer, true);

    await stripe(stripeKey, "DELETE", `/subscriptions/${subscription.id}`);
    await runPhase("cancellation removes access", payer, false, { critical: true });

    const graded = gradeOf(phases.map((p) => ({ ...p, id: p.phase })));
    return {
      driver: "stripe-sandbox",
      phases,
      grade: graded,
      passed: phases.every((p) => p.outcome === "pass"),
      notProvable: phases.filter((p) => p.outcome === "not_provable").map((p) => p.phase),
      criticalFailure: phases.find((p) => p.critical && p.outcome === "fail") || null,
    };
  } finally {
    /* Leave the founder's sandbox the way we found it. Deleting the clock
       deletes every customer and subscription riding on it. */
    if (clockId) await stripe(stripeKey, "DELETE", `/test_helpers/test_clocks/${clockId}`).catch(() => {});
    for (const id of customerIds) await stripe(stripeKey, "DELETE", `/customers/${id}`).catch(() => {});
  }
}
