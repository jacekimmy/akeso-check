import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AKESO_MARKER, applyFixPlan, buildFixPlan, planRepairs, revertFix } from "../src/fix.mjs";

/* The Fix writes to a founder's real project. Every test here is about a way
   that could go wrong: repairing something nobody measured, silently
   destroying work, or being impossible to undo. */

const scratch = () => mkdtemp(path.join(tmpdir(), "akeso-fix-"));

const detection = (over = {}) => ({
  root: "/tmp/app",
  framework: { framework: "next-app-router", packageName: "demo" },
  database: { kind: "supabase", entitlementTable: "profiles", entitlementColumn: "is_pro", tableConfirmed: true, columnConfirmed: true },
  webhookHandlers: [{
    file: "app/api/stripe/webhook/route.ts",
    verifiesSignature: true, rawBodySeen: true,
    handledEvents: ["checkout.session.completed"],
    missingEvents: ["invoice.paid", "customer.subscription.deleted"],
  }],
  accessDecisionSites: [],
  capabilities: { blockers: [] },
  ...over,
});

test("every repair names the evidence that justifies it", () => {
  const repairs = planRepairs({ detection: detection() });
  assert.ok(repairs.length > 0);
  for (const repair of repairs) {
    assert.ok(repair.because && repair.because.length > 20, `repair ${repair.id} must explain itself`);
    assert.ok(repair.title && repair.severity);
  }
});

test("a clean app gets no repairs invented for it", () => {
  const repairs = planRepairs({
    detection: detection({
      webhookHandlers: [{ file: "app/api/stripe/webhook/route.ts", verifiesSignature: true, rawBodySeen: true, handledEvents: ["all"], missingEvents: [] }],
    }),
  });
  assert.deepEqual(repairs, [], "nothing measured wrong means nothing to repair");
});

test("an executed failure outranks a clean code read", () => {
  const repairs = planRepairs({
    detection: detection({
      webhookHandlers: [{ file: "x.ts", verifiesSignature: true, rawBodySeen: true, handledEvents: ["all"], missingEvents: [] }],
    }),
    lifecycle: { results: [{ id: "immediate-cancel", name: "Immediate cancellation removes access", expected: false, outcome: "fail" }] },
  });
  const removal = repairs.find((repair) => repair.id === "removals-must-remove");
  assert.ok(removal, "a scenario that actually failed must produce a repair");
  assert.equal(removal.severity, "critical");
  assert.match(removal.because, /Tested against your running app/);
});

test("sandbox failures produce repairs too", () => {
  const repairs = planRepairs({
    detection: detection({ webhookHandlers: [{ file: "x.ts", verifiesSignature: true, rawBodySeen: true, handledEvents: ["all"], missingEvents: [] }] }),
    sandbox: { phases: [{ phase: "cancellation removes access", expected: false, outcome: "fail", critical: true }] },
  });
  assert.ok(repairs.some((repair) => repair.id === "removals-must-remove"));
});

test("the generated handler carries the rules the report promised", () => {
  const plan = buildFixPlan({ detection: detection() });
  const handler = plan.files.find((file) => file.path.includes("webhook")).contents;

  assert.match(handler, /constructEvent/, "verifies the signature with Stripe's own verifier");
  assert.match(handler, /request\.text\(\)/, "against the raw body");
  assert.match(handler, /alreadyProcessed/, "idempotent by event id");
  assert.match(handler, /event\.created < watermark/, "guards against out-of-order delivery");
  for (const event of ["checkout.session.completed", "invoice.paid", "invoice.payment_failed",
    "customer.subscription.created", "customer.subscription.updated",
    "customer.subscription.deleted", "charge.refunded"]) {
    assert.ok(handler.includes(event), `handles ${event}`);
  }
  assert.match(handler, /status: 400/, "rejects unverified events");
  assert.match(handler, /status: 500/, "lets Stripe retry on a real failure");
});

test("the entitlement module is the only file that touches the database", () => {
  const plan = buildFixPlan({ detection: detection() });
  const entitlement = plan.files.find((file) => file.path.includes("entitlement")).contents;
  const others = plan.files.filter((file) => !file.path.includes("entitlement") && !file.path.endsWith(".sql"));

  assert.match(entitlement, /from\("profiles"\)/, "uses the table the Check actually found");
  assert.match(entitlement, /is_pro/, "uses the column the Check actually found");
  for (const file of others) {
    assert.ok(!/\.from\(["'`]profiles/.test(file.contents), `${file.path} must not query the database directly`);
  }
});

test("a read error never becomes 'not entitled'", () => {
  const plan = buildFixPlan({ detection: detection() });
  const entitlement = plan.files.find((file) => file.path.includes("entitlement")).contents;
  /* The exact bug that cost a session a wrong conclusion, and that would lock
     paying customers out in production. */
  assert.match(entitlement, /if \(error\) throw/, "a failed read throws instead of reporting false");
});

test("blocked and human-set accounts are never written by the restore path", () => {
  const plan = buildFixPlan({ detection: detection() });
  const entitlement = plan.files.find((file) => file.path.includes("entitlement")).contents;
  assert.match(entitlement, /administrativeBlock \|\| before\.securityOrAbuseBlock/);
  assert.match(entitlement, /manualComplimentaryAccess \|\| before\.manualBillingOverride/);
  assert.match(entitlement, /verified: after\.billingEntitled === target/, "success only after a re-read");
});

test("unconfirmed schema names say so in the generated code", () => {
  const plan = buildFixPlan({
    detection: detection({ database: { kind: "supabase", entitlementTable: "profiles", entitlementColumn: "billing_entitled", tableConfirmed: false, columnConfirmed: false } }),
  });
  const entitlement = plan.files.find((file) => file.path.includes("entitlement")).contents;
  assert.match(entitlement, /HEADS UP/, "code built on a default must admit it");
  assert.match(entitlement, /could NOT confirm/);
});

test("a non-Supabase app gets honest stubs, not fake working code", () => {
  const plan = buildFixPlan({ detection: detection({ database: { kind: "postgres", entitlementTable: "users", entitlementColumn: "is_paid" } }) });
  const entitlement = plan.files.find((file) => file.path.includes("entitlement")).contents;
  assert.match(entitlement, /TODO\(1\)/, "the queries it cannot know are marked, not guessed");
  assert.ok(!entitlement.includes("createClient"), "no Supabase client for a non-Supabase app");
});

test("applying backs up the original and revert puts it back exactly", async () => {
  const root = await scratch();
  const handlerPath = "app/api/stripe/webhook/route.ts";
  const original = "// the founder's original handler\nexport async function POST() { return new Response('ok'); }\n";
  await mkdir(path.join(root, path.dirname(handlerPath)), { recursive: true });
  await writeFile(path.join(root, handlerPath), original);

  const plan = buildFixPlan({ detection: detection() });
  const applied = await applyFixPlan(root, plan, { stamp: "test" });

  const afterFix = await readFile(path.join(root, handlerPath), "utf8");
  assert.notEqual(afterFix, original, "the handler was replaced");
  assert.match(afterFix, new RegExp(AKESO_MARKER), "generated files are marked as generated");
  assert.equal(await readFile(path.join(root, applied.backupDir, handlerPath), "utf8"), original, "the original is backed up byte for byte");

  const reverted = await revertFix(root, { files: applied.written, backupDir: applied.backupDir });
  assert.equal(await readFile(path.join(root, handlerPath), "utf8"), original, "revert restores the original exactly");
  assert.ok(reverted.restored.some((file) => file.path === handlerPath));
});

test("revert removes files it created, rather than leaving orphans", async () => {
  const root = await scratch();
  const plan = buildFixPlan({ detection: detection({ webhookHandlers: [] }) });
  const applied = await applyFixPlan(root, plan, { stamp: "test" });
  const created = applied.written.find((file) => file.path.includes("entitlement"));
  assert.equal(created.action, "created");

  await revertFix(root, { files: applied.written, backupDir: applied.backupDir });
  const stillThere = await readFile(path.join(root, created.path), "utf8").catch(() => null);
  assert.equal(stillThere, null, "a file the fix created is removed on revert");
});

test("revert refuses to overwrite a file a human edited afterwards", async () => {
  const root = await scratch();
  const handlerPath = "app/api/stripe/webhook/route.ts";
  await mkdir(path.join(root, path.dirname(handlerPath)), { recursive: true });
  await writeFile(path.join(root, handlerPath), "// original\n");

  const plan = buildFixPlan({ detection: detection() });
  const applied = await applyFixPlan(root, plan, { stamp: "test" });

  /* The founder (or their agent) rewrote the generated file. Their work wins. */
  await writeFile(path.join(root, handlerPath), "// my own hand-written handler, no marker\n");
  const reverted = await revertFix(root, { files: applied.written, backupDir: applied.backupDir });

  assert.equal(await readFile(path.join(root, handlerPath), "utf8"), "// my own hand-written handler, no marker\n");
  assert.ok(reverted.refused.some((file) => file.path === handlerPath), "the edited file is reported as left alone");
});

test("schema changes are written for a human to run, never executed", () => {
  const plan = buildFixPlan({ detection: detection() });
  const migration = plan.files.find((file) => file.path.endsWith(".sql"));
  assert.ok(migration.manual, "the SQL file is marked as the founder's to run");
  assert.match(migration.contents, /paste this into your database/);
  assert.ok(!/drop |delete from/i.test(migration.contents), "the migration only ever adds");
});
