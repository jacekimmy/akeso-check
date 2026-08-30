import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderAdapter, renderReferenceAdapter } from "../src/adapter.mjs";

/* The contract itself gets proven here, against the runnable reference
   implementation — so the rules exist as executed behaviour, not just as
   comments in generated code a founder might delete. */

async function loadReference(initialStore) {
  const dir = await mkdtemp(path.join(tmpdir(), "akeso-adapter-"));
  const dbFile = path.join(dir, "store.json");
  await writeFile(dbFile, JSON.stringify(initialStore));
  const moduleFile = path.join(dir, "adapter.mjs");
  await writeFile(moduleFile, renderReferenceAdapter());
  process.env.AKESO_REF_DB = dbFile;
  const adapter = await import(moduleFile);
  return { adapter, dbFile };
}

test("the generated TS adapter carries the six fields and both functions", () => {
  const source = renderAdapter({ tableName: "profiles", entitledColumn: "is_pro" });
  for (const field of ["billingEntitled", "manualComplimentaryAccess", "manualBillingOverride",
    "administrativeBlock", "securityOrAbuseBlock", "finalAccessDecision"]) {
    assert.ok(source.includes(field), `missing ${field}`);
  }
  assert.match(source, /getBillingEntitlement/);
  assert.match(source, /restoreBillingEntitlement/);
  assert.match(source, /NEVER overridden/);
});

test("restore applies, verifies by re-read, and is honest in its receipt", async () => {
  const { adapter } = await loadReference({ a1: { billing_entitled: false } });
  const out = await adapter.restoreBillingEntitlement(
    "a1", { billingEntitled: false }, { billingEntitled: true }, "1", "idem-1", "stripe_says_active");
  assert.equal(out.result, "applied");
  assert.equal(out.verified, true);
  assert.equal(out.before.billingEntitled, false);
  assert.equal(out.after.billingEntitled, true);
});

test("a blocked account is never restored, whatever Stripe says", async () => {
  const { adapter } = await loadReference({ banned: { billing_entitled: false, abuse_block: true } });
  const out = await adapter.restoreBillingEntitlement(
    "banned", { billingEntitled: false }, { billingEntitled: true }, "1", "idem-2", "stripe_says_active");
  assert.equal(out.result, "unsupported");
  assert.match(out.reason, /block/);
  const after = await adapter.getBillingEntitlement("banned");
  assert.equal(after.billingEntitled, false, "the write must not have happened");
});

test("a restore racing a newer change loses loudly, not wins silently", async () => {
  const { adapter } = await loadReference({ r1: { billing_entitled: true } });
  /* prepared believing entitled=false; reality moved on */
  const out = await adapter.restoreBillingEntitlement(
    "r1", { billingEntitled: false }, { billingEntitled: true }, "1", "idem-3", "reconcile");
  assert.equal(out.result, "no_op" /* already at target */);

  const conflicting = await adapter.restoreBillingEntitlement(
    "r1", { billingEntitled: false }, { billingEntitled: false }, "1", "idem-4", "reconcile");
  assert.equal(conflicting.result, "conflict");
  assert.match(conflicting.reason, /changed since/);
});

test("a rule-version mismatch refuses before touching anything", async () => {
  const { adapter, dbFile } = await loadReference({ v1: { billing_entitled: false } });
  const out = await adapter.restoreBillingEntitlement(
    "v1", { billingEntitled: false }, { billingEntitled: true }, "999", "idem-5", "stale_plan");
  assert.equal(out.result, "conflict");
  assert.equal(JSON.parse(await readFile(dbFile, "utf8")).v1.billing_entitled, false);
});
