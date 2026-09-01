import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detect } from "../src/detect.mjs";

/* Five of eight real starter kits declare their tables in Prisma or Drizzle
   schema files, where a query-string scan sees nothing. Without this the Fix
   generated an entitlement module against a default "profiles" table those
   apps do not have. Each test is one real shape found in the wild. */

async function project(files) {
  const root = await mkdtemp(path.join(tmpdir(), "akeso-schema-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "x", dependencies: { next: "15", stripe: "17" } }));
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), contents);
  }
  return root;
}

test("a Prisma model carrying Stripe fields is the billing table", async () => {
  const root = await project({
    "prisma/schema.prisma": `
model Account { id String @id  name String }
model User {
  id                     String  @id
  email                  String
  stripeCustomerId       String? @map("stripe_customer_id")
  stripeSubscriptionId   String? @map("stripe_subscription_id")
  stripePriceId          String? @map("stripe_price_id")
  stripeCurrentPeriodEnd DateTime? @map("stripe_current_period_end")
  @@map("users")
}
`,
    "app/api/webhooks/stripe/route.ts": "export async function POST(){}",
  });
  const { database } = await detect(root);
  assert.equal(database.entitlementTable, "users", "the @@map name is the real table");
  assert.equal(database.entitlementColumn, "stripe_price_id", "the @map name is the real column");
  assert.equal(database.tableConfirmed, true);
  assert.equal(database.schemaSource, "prisma");
});

test("a Drizzle pgTable carrying Stripe fields is the billing table", async () => {
  const root = await project({
    "src/db/schema.ts": `
export const users = pgTable("gf_user", { id: serial("id").primaryKey(), email: text("email") });
export const subscriptions = pgTable("gf_subscriptions", {
  id: serial("id").primaryKey(),
  userId: integer("userId"),
  stripeSubscriptionId: text("stripeSubscriptionId"),
  stripeCustomerId: text("stripeCustomerId"),
  stripePriceId: text("stripePriceId"),
  expires: timestamp("expires"),
});
`,
    "app/api/webhooks/stripe/route.ts": "export async function POST(){}",
  });
  const { database } = await detect(root);
  assert.equal(database.entitlementTable, "gf_subscriptions");
  assert.equal(database.entitlementColumn, "stripePriceId", "Drizzle: text(\"stripePriceId\") names the column");
  assert.equal(database.schemaSource, "drizzle");
});

test("a status column outranks a price id when both exist", async () => {
  const root = await project({
    "lib/db/schema.ts": `
export const teams = pgTable("teams", {
  id: serial("id").primaryKey(),
  stripeSubscriptionId: text("stripe_subscription_id"),
  stripeProductId: text("stripe_product_id"),
  planName: varchar("plan_name"),
  subscriptionStatus: varchar("subscription_status"),
});
`,
  });
  const { database } = await detect(root);
  assert.equal(database.entitlementTable, "teams");
  assert.equal(database.entitlementColumn, "subscription_status", "the Drizzle column name, not the field name");
});

test("a boolean active flag is recognised as the entitlement column", async () => {
  const root = await project({
    "prisma/schema.prisma": `
model Subscription {
  id         String   @id
  customerId String
  priceId    String
  active     Boolean  @default(false)
  startDate  DateTime
}
`,
  });
  const { database } = await detect(root);
  assert.equal(database.entitlementTable, "Subscription");
  assert.equal(database.entitlementColumn, "active");
  assert.equal(database.columnConfirmed, true);
});

test("a schema with nothing Stripe-shaped falls back honestly", async () => {
  const root = await project({
    "prisma/schema.prisma": `
model Post { id String @id  title String  body String }
`,
  });
  const { database } = await detect(root);
  assert.equal(database.tableConfirmed, false, "no evidence means the default is admitted, not claimed");
});

test("the named form, @map(name: \"...\"), is the one real schemas use", async () => {
  /* mickasmt/next-saas-stripe-starter, 3,000 stars, writes every map this
     way. The bare-string form passed the tests while the real file resolved
     to the Prisma field name and a table Postgres does not have. */
  const root = await project({
    "prisma/schema.prisma": `
model User {
  id                     String    @id @default(cuid())
  stripeCustomerId       String?   @unique @map(name: "stripe_customer_id")
  stripeSubscriptionId   String?   @unique @map(name: "stripe_subscription_id")
  stripePriceId          String?   @map(name: "stripe_price_id")
  stripeCurrentPeriodEnd DateTime? @map(name: "stripe_current_period_end")

  @@map(name: "users")
}
`,
  });
  const { database } = await detect(root);
  assert.equal(database.entitlementTable, "users");
  assert.equal(database.entitlementColumn, "stripe_price_id");
});
