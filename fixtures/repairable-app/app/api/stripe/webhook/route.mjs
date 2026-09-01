// The tutorial handler, as thousands of apps actually ship it.
//
// It verifies the signature (most tutorials do get that part right) and then
// makes the mistake that leaks money: it listens for the one event that turns
// access ON and no event that turns it OFF. Cancel, refund, failed card, and
// downgrade all pass through silently, and the customer keeps everything.
//
// This is the fixture the Fix has to repair, and every failure it produces is
// a real failure of this code, not a simulated one.
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export async function POST(request) {
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    return new Response(`bad signature: ${error.message}`, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const account = event.data.object.client_reference_id;
    await db.from("profiles").update({ is_pro: true }).eq("id", account);
  }

  return Response.json({ received: true });
}
