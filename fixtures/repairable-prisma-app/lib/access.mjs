// The app's own access check, the way the tutorial wrote it: paid if there is
// a price id. The Check's probe asks this.
import { PrismaClient } from "@prisma/client";
const db = new PrismaClient();
export async function isPro(accountId) {
  const rows = await db.$queryRawUnsafe(`SELECT "id", "billing_entitled", "stripe_price_id" FROM "users" WHERE "id" = $1 LIMIT 1`, accountId);
  const row = rows[0];
  if (!row) return false;
  // After the repair, Akeso's column is the truth once written; before that,
  // the tutorial's own marker.
  return row.billing_entitled === null || row.billing_entitled === undefined ? Boolean(row.stripe_price_id) : Boolean(row.billing_entitled);
}
