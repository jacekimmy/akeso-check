// The tutorial handler, as Lovable and Bolt export it: a Deno edge function
// that verifies Stripe's signature and then only ever switches access ON.
import Stripe from "https://esm.sh/stripe@14?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", { apiVersion: "2023-10-16", httpClient: Stripe.createFetchHttpClient() });
const cryptoProvider = Stripe.createSubtleCryptoProvider();
const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

Deno.serve(async (req) => {
  const signature = req.headers.get("stripe-signature");
  const body = await req.text();
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature!, Deno.env.get("STRIPE_WEBHOOK_SECRET")!, undefined, cryptoProvider);
  } catch (err) {
    return new Response(`bad signature: ${(err as Error).message}`, { status: 400 });
  }
  if (event.type === "checkout.session.completed") {
    const account = (event.data.object as { client_reference_id?: string }).client_reference_id;
    if (account) await supabase.from("profiles").update({ is_pro: true }).eq("id", account);
  }
  return new Response(JSON.stringify({ received: true }), { headers: { "content-type": "application/json" } });
});
