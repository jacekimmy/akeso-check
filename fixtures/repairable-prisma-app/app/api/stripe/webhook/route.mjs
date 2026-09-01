// The tutorial handler on Prisma: verifies the signature, then only ever
// switches access ON. Cancel, refund and failed card pass through silently.
import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const db = new PrismaClient();

export async function POST(request) {
  const rawBody = await request.text();
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, request.headers.get("stripe-signature"), process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    return new Response(`bad signature: ${error.message}`, { status: 400 });
  }
  if (event.type === "checkout.session.completed") {
    const account = event.data.object.client_reference_id;
    // The tutorial writes the price id and calls that "paid".
    await db.$executeRawUnsafe(`UPDATE "users" SET "billing_entitled" = $1 WHERE "id" = $2 AND ("billing_entitled" IS NOT DISTINCT FROM $3 OR "billing_entitled" IS NULL)`, true, account, null);
  }
  return Response.json({ received: true });
}
