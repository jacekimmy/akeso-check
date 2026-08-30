import { signPayload } from "./stripe-events.mjs";

/* The sandbox driver: the highest-fidelity lifecycle test.
 *
 * Where the local driver synthesises Stripe-shaped events, this one creates a
 * REAL customer and subscription in the founder's own Stripe test sandbox and
 * lets Stripe author the events. We then fetch those events from Stripe's API
 * and deliver them to the locally running app, signed with the app's own
 * webhook secret — so no Stripe CLI login and no public tunnel is needed.
 * The payloads are Stripe's, byte for byte.
 *
 * Safety rails, in order of importance:
 * - refuses to run with anything but a test-mode key, checked here and not
 *   only at the call site
 * - everything it creates is tagged and deleted afterwards
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

/* Stripe events relevant to our customer, oldest first, authored by Stripe. */
async function eventsFor(key, { customerId, since }) {
  const page = await stripe(key, "GET", `/events?limit=100&created[gte]=${since - 5}`);
  return page.data
    .filter((event) => {
      const object = event.data?.object || {};
      return object.customer === customerId || object.id === customerId;
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
    delivered.push({ id: event.id, type: event.type, status: response.status });
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return delivered;
}

async function probe(probeUrl, account) {
  const response = await fetch(`${probeUrl}?account=${encodeURIComponent(account)}`);
  const body = await response.json();
  return Boolean(body.billingEntitled);
}

/* Subscribe -> cancel-at-period-end -> cancel-now, with the app's entitlement
   read after each phase. Trial and renewal phases need test clocks and land in
   the next iteration; the report never claims them meanwhile. */
export async function runSandboxLifecycle({ stripeKey, webhookUrl, probeUrl, webhookSecret, log = () => {} }) {
  assertTestKey(stripeKey);
  const started = Math.floor(Date.now() / 1000);
  const alreadyDelivered = new Set();
  const phases = [];
  let customerId = null;

  try {
    const price = await ensureTestPrice(stripeKey);
    log(`test plan ready: ${price.id}`);

    const customer = await stripe(stripeKey, "POST", "/customers", {
      name: "Akeso Check synthetic customer",
      metadata: { akeso: "check" },
    });
    customerId = customer.id;
    await stripe(stripeKey, "POST", `/customers/${customerId}`, {
      "invoice_settings[default_payment_method]": (await stripe(stripeKey, "POST", "/payment_methods/pm_card_visa/attach", { customer: customerId })).id,
    });

    const subscription = await stripe(stripeKey, "POST", "/subscriptions", {
      customer: customerId,
      "items[0][price]": price.id,
      metadata: { akeso: "check" },
    });
    log(`subscribed: ${subscription.id} (${subscription.status})`);

    let accessEverGranted = false;

    const runPhase = async (name, expected) => {
      /* Stripe writes events asynchronously; poll briefly rather than assuming. */
      let delivered = [];
      for (let i = 0; i < 10; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        delivered = [...delivered, ...await deliverAll(
          await eventsFor(stripeKey, { customerId, since: started }),
          { webhookUrl, webhookSecret, alreadyDelivered },
        )];
        if (delivered.length) break;
      }
      const observed = await probe(probeUrl, customerId);
      if (observed) accessEverGranted = true;

      /* The vacuous-pass guard: "cancellation removes access" proves nothing
         if access was never granted in the first place. A removal phase on an
         app that never granted is reported as unprovable, not as a pass — the
         same positive-control discipline as everywhere else in this project. */
      const removalPhase = expected === false;
      const outcome = removalPhase && !accessEverGranted
        ? "not_provable"
        : observed === expected ? "pass" : "fail";

      phases.push({
        phase: name,
        expected,
        observed,
        outcome,
        ...(outcome === "not_provable" ? { reason: "access was never granted, so its removal cannot be tested" } : {}),
        eventsDelivered: delivered.map((d) => d.type),
      });
      log(`${name}: expected ${expected}, app says ${observed} -> ${outcome}`);
    };

    await runPhase("real subscription grants access", true);

    await stripe(stripeKey, "POST", `/subscriptions/${subscription.id}`, { cancel_at_period_end: true });
    await runPhase("cancel at period end keeps access until the period ends", true);

    await stripe(stripeKey, "DELETE", `/subscriptions/${subscription.id}`);
    await runPhase("cancellation removes access", false);

    return {
      driver: "stripe-sandbox",
      phases,
      passed: phases.every((p) => p.outcome === "pass"),
      notProvable: phases.filter((p) => p.outcome === "not_provable").map((p) => p.phase),
      criticalFailure: phases.find((p) => p.phase.includes("removes access") && p.outcome === "fail") || null,
    };
  } finally {
    /* Leave the founder's sandbox the way we found it. */
    if (customerId) await stripe(stripeKey, "DELETE", `/customers/${customerId}`).catch(() => {});
  }
}
