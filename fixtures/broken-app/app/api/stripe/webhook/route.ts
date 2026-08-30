// The classic vibe-coded handler: grants on payment, never revokes.
// checkout.session.completed is handled; every cancellation and failure
// event is silently ignored, so canceled customers keep access forever.
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(request: Request) {
  const body = await request.json(); // parsed body: signature can never verify
  const event = body; // no constructEvent — anyone can forge this

  if (event.type === "checkout.session.completed") {
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
    await supabase.from("profiles").update({ is_pro: true }).eq("id", event.data.object.client_reference_id);
  }
  return Response.json({ received: true });
}
