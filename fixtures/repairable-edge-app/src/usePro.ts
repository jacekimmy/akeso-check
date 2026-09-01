// The Vite front end's gate: reads the profile row's is_pro flag.
import { createClient } from "@supabase/supabase-js";
const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);
export async function isPro(userId: string) {
  const { data } = await supabase.from("profiles").select("is_pro").eq("id", userId).single();
  return Boolean(data?.is_pro);
}
