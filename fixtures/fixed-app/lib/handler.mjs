// What the Fix Plan produces: the same app, done right.
//   - verifies the Stripe signature against the raw body
//   - handles the full lifecycle event set
//   - idempotent by event id; ignores events older than the last applied
//   - entitlement derived from subscription status, not from event arrival
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "profiles.json");
const WHSEC = (process.env.STRIPE_WEBHOOK_SECRET || "whsec_fixturefixturefixture5678").replace(/^whsec_/, "");

async function read() {
  try { return JSON.parse(await readFile(DB, "utf8")); } catch { return { accounts: {}, seenEvents: [] }; }
}
async function write(state) { await writeFile(DB, JSON.stringify(state, null, 2)); }

function verifySignature(rawBody, header) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (!parts.t || !parts.v1) return false;
  const expected = createHmac("sha256", WHSEC).update(`${parts.t}.${rawBody}`).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(parts.v1, "hex"));
  } catch { return false; }
}

// Which subscription statuses mean "billing-entitled" under this app's policy:
// active and trialing yes; past_due still yes (grace); unpaid/canceled no.
const ENTITLED_STATUSES = new Set(["active", "trialing", "past_due"]);

export async function handleWebhook(rawBody, signatureHeader) {
  if (!verifySignature(rawBody, signatureHeader)) {
    return { status: 400, body: { error: "invalid signature" } };
  }
  const event = JSON.parse(rawBody);
  const state = await read();

  // Idempotency: the same event id applies once, ever.
  if (state.seenEvents.includes(event.id)) return { status: 200, body: { received: true, duplicate: true } };
  state.seenEvents.push(event.id);

  const object = event.data.object;
  const account = object.client_reference_id || object.metadata?.account || object.customer;
  if (account) {
    const current = state.accounts[account] || { lastEventCreated: 0 };
    // Out-of-order guard: an older event never overrides a newer decision.
    if (event.created > current.lastEventCreated) {
      switch (event.type) {
        case "checkout.session.completed":
        case "customer.subscription.created":
          current.billingEntitled = true; break;
        case "invoice.paid":
          current.billingEntitled = true; break;
        case "customer.subscription.updated":
          current.billingEntitled = ENTITLED_STATUSES.has(object.status); break;
        case "invoice.payment_failed":
          // grace: entitlement follows the subscription status events, not this
          break;
        case "customer.subscription.deleted":
          current.billingEntitled = false; break;
        case "charge.refunded":
          current.billingEntitled = false; break; // this app's stated refund policy
        default: break;
      }
      current.lastEventCreated = event.created;
      state.accounts[account] = current;
    }
  }
  await write(state);
  return { status: 200, body: { received: true } };
}

export async function isPro(accountId) {
  const state = await read();
  return Boolean(state.accounts[accountId]?.billingEntitled);
}
