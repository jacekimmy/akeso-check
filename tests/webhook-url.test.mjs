import assert from "node:assert/strict";
import test from "node:test";
import { webhookUrlFor } from "../src/webhook-url.mjs";

/* This existed twice and the copies drifted: the verify path produced
   "/api/api/stripe/webhook", every delivery 404'd, and a perfectly good repair
   was reported as untestable and rolled back. Each shape gets a test. */

const withHandler = (file) => ({ webhookHandlers: file ? [{ file }] : [] });

test("Next app router", () => {
  assert.equal(
    webhookUrlFor(withHandler("app/api/stripe/webhook/route.ts"), "http://localhost:3000"),
    "http://localhost:3000/api/stripe/webhook",
  );
});

test("Next app router, .mjs", () => {
  assert.equal(
    webhookUrlFor(withHandler("app/api/stripe/webhook/route.mjs"), "http://localhost:3000"),
    "http://localhost:3000/api/stripe/webhook",
  );
});

test("Next pages router", () => {
  assert.equal(
    webhookUrlFor(withHandler("pages/api/stripe/webhook.ts"), "http://localhost:3000"),
    "http://localhost:3000/api/stripe/webhook",
  );
});

test("a nonstandard route name is kept", () => {
  assert.equal(
    webhookUrlFor(withHandler("app/api/billing/hooks/route.ts"), "http://localhost:3000"),
    "http://localhost:3000/api/billing/hooks",
  );
});

test("a handler outside api/ still gets an api prefix", () => {
  assert.equal(
    webhookUrlFor(withHandler("src/webhook.js"), "http://localhost:3000"),
    "http://localhost:3000/api/src/webhook",
  );
});

test("Supabase Edge Functions use their own prefix", () => {
  assert.equal(
    webhookUrlFor(withHandler("supabase/functions/stripe-webhook/index.ts"), "https://x.supabase.co"),
    "https://x.supabase.co/functions/v1/stripe-webhook",
  );
});

test("no handler falls back to the conventional path", () => {
  assert.equal(webhookUrlFor(withHandler(null), "http://localhost:3000"), "http://localhost:3000/api/stripe/webhook");
});

test("a trailing slash on the base never doubles up", () => {
  assert.equal(
    webhookUrlFor(withHandler("app/api/stripe/webhook/route.ts"), "http://localhost:3000/"),
    "http://localhost:3000/api/stripe/webhook",
  );
});

test("api is never doubled", () => {
  for (const file of ["app/api/stripe/webhook/route.ts", "pages/api/stripe/webhook.ts", "app/api/billing/route.js"]) {
    assert.ok(!webhookUrlFor(withHandler(file), "http://x").includes("/api/api/"), `${file} produced a doubled api segment`);
  }
});
