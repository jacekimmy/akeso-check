import { createHmac, randomUUID } from "node:crypto";

/* Builds and signs the lifecycle events the Check delivers to the app.
 *
 * These are real Stripe-shaped events with real Stripe signatures — the HMAC
 * scheme Stripe documents, computed with the app's own webhook secret, which
 * the Check reads locally and never transmits. The app under test cannot tell
 * these from Stripe's own deliveries unless it re-fetches objects from the
 * Stripe API. Apps that do re-fetch need the sandbox driver (their own test
 * key + the Stripe CLI); that limit is stated in the report, never papered over.
 */

export function signPayload(rawBody, webhookSecret, timestamp = Math.floor(Date.now() / 1000)) {
  const secret = webhookSecret.replace(/^whsec_/, "");
  const signature = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

let counter = 0;
function eventId() {
  counter += 1;
  return `evt_akeso_${Date.now()}_${counter}_${randomUUID().slice(0, 8)}`;
}

/* One event, Stripe-shaped. `created` is controllable because out-of-order
   delivery is one of the scenarios. */
export function makeEvent({ type, account, created, id, object = {} }) {
  return {
    id: id || eventId(),
    object: "event",
    api_version: "2026-08-27.basil",
    created: created ?? Math.floor(Date.now() / 1000),
    type,
    livemode: false,
    data: {
      object: {
        id: object.id || `${type.startsWith("charge") ? "ch" : type.startsWith("invoice") ? "in" : type.startsWith("checkout") ? "cs" : "sub"}_akeso_${account}`,
        customer: `cus_akeso_${account}`,
        client_reference_id: account,
        metadata: { account },
        ...object,
      },
    },
  };
}

/* The ten lifecycle scenarios from the master doc, each on its own account so
   one scenario's state cannot bleed into another. `expect` is the billing
   entitlement the app must report after the last event; null means reported,
   not graded (refunds follow the app's own policy). `critical` marks the
   failures that force an F: canceled customers keeping access. */
export function scenarios() {
  const t = Math.floor(Date.now() / 1000);
  return [
    {
      id: "checkout-grants",
      name: "New payment unlocks access",
      account: "s1",
      events: [
        makeEvent({ type: "checkout.session.completed", account: "s1", created: t }),
      ],
      expect: true,
    },
    {
      id: "trial-converts",
      name: "Trial ends, subscription becomes active",
      account: "s2",
      events: [
        makeEvent({ type: "customer.subscription.created", account: "s2", created: t, object: { status: "trialing" } }),
        makeEvent({ type: "customer.subscription.updated", account: "s2", created: t + 10, object: { status: "active" } }),
      ],
      expect: true,
    },
    {
      id: "renewal-succeeds",
      name: "Monthly renewal payment keeps access",
      account: "s3",
      events: [
        makeEvent({ type: "checkout.session.completed", account: "s3", created: t }),
        makeEvent({ type: "invoice.paid", account: "s3", created: t + 10 }),
      ],
      expect: true,
    },
    {
      id: "payment-fails",
      name: "Card fails, retries exhaust: access ends",
      account: "s4",
      events: [
        makeEvent({ type: "checkout.session.completed", account: "s4", created: t }),
        makeEvent({ type: "invoice.payment_failed", account: "s4", created: t + 10 }),
        makeEvent({ type: "customer.subscription.updated", account: "s4", created: t + 20, object: { status: "past_due" } }),
        makeEvent({ type: "customer.subscription.updated", account: "s4", created: t + 30, object: { status: "unpaid" } }),
      ],
      expect: false,
    },
    {
      id: "cancel-at-period-end",
      name: "Customer cancels; period ends: access ends",
      account: "s5",
      events: [
        makeEvent({ type: "checkout.session.completed", account: "s5", created: t }),
        makeEvent({ type: "customer.subscription.updated", account: "s5", created: t + 10, object: { status: "active", cancel_at_period_end: true } }),
        makeEvent({ type: "customer.subscription.deleted", account: "s5", created: t + 20, object: { status: "canceled" } }),
      ],
      expect: false,
      critical: true,
    },
    {
      id: "immediate-cancel",
      name: "Immediate cancellation removes access",
      account: "s6",
      events: [
        makeEvent({ type: "checkout.session.completed", account: "s6", created: t }),
        makeEvent({ type: "customer.subscription.deleted", account: "s6", created: t + 10, object: { status: "canceled" } }),
      ],
      expect: false,
      critical: true,
    },
    {
      id: "reactivation",
      name: "Customer un-cancels before the period ends",
      account: "s7",
      events: [
        makeEvent({ type: "checkout.session.completed", account: "s7", created: t }),
        makeEvent({ type: "customer.subscription.updated", account: "s7", created: t + 10, object: { status: "active", cancel_at_period_end: true } }),
        makeEvent({ type: "customer.subscription.updated", account: "s7", created: t + 20, object: { status: "active", cancel_at_period_end: false } }),
      ],
      expect: true,
    },
    {
      id: "refund",
      name: "Latest charge refunded (follows the app's own policy)",
      account: "s8",
      events: [
        makeEvent({ type: "checkout.session.completed", account: "s8", created: t }),
        makeEvent({ type: "charge.refunded", account: "s8", created: t + 10 }),
      ],
      expect: null,
    },
    (() => {
      const dup = makeEvent({ type: "customer.subscription.deleted", account: "s9", created: t + 10, object: { status: "canceled" } });
      return {
        id: "duplicate-delivery",
        name: "The same event delivered twice",
        account: "s9",
        events: [
          makeEvent({ type: "checkout.session.completed", account: "s9", created: t }),
          dup,
          { ...dup }, /* identical id: must not error or flip state back */
        ],
        expect: false,
      };
    })(),
    {
      id: "out-of-order",
      name: "An old 'still active' event arrives after cancellation",
      account: "s10",
      events: [
        makeEvent({ type: "checkout.session.completed", account: "s10", created: t }),
        makeEvent({ type: "customer.subscription.deleted", account: "s10", created: t + 20, object: { status: "canceled" } }),
        makeEvent({ type: "customer.subscription.updated", account: "s10", created: t + 10, object: { status: "active" } }),
      ],
      expect: false,
    },
  ];
}
