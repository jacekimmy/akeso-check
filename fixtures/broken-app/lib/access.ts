// Where this app decides who has paid access.
import { createClient } from "@supabase/supabase-js";

export async function isPro(userId: string) {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
  const { data } = await supabase.from("profiles").select("is_pro").eq("id", userId).single();
  return Boolean(data?.is_pro);
}
