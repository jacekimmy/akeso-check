// The app's own access check — what its gates call, and what the Check's probe
// asks. Deliberately named the way real apps name it, so probe installation is
// exercised against a realistic target.
import { createClient } from "@supabase/supabase-js";

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export async function isPro(accountId) {
  const { data, error } = await db.from("profiles").select("*").eq("id", accountId).maybeSingle();
  // A read error must never read as "not entitled" — that locks out paying
  // customers. The fixture gets this right so the Check is testing billing
  // logic, not this bug.
  if (error) throw new Error(`entitlement read failed: ${error.message}`);
  return Boolean(data?.is_pro);
}
