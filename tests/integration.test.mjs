import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detect } from "../src/detect.mjs";
import { applyFixPlan, buildFixPlan } from "../src/fix.mjs";
import { restoreEntitlement } from "../src/restore.mjs";
import { runSweep } from "../src/monitor.mjs";
import { readLedger, verifyLedger } from "../src/ledger.mjs";
import { approve, pendingApprovals, queueRemoval } from "../src/approvals.mjs";
import { guardWrite, haltNow, isHalted, resumeHalt } from "../src/safety.mjs";
import { certificationStatus, certify, fingerprintSchema } from "../src/certification.mjs";
import { monthlyStatement, renderStatementText } from "../src/receipts.mjs";
import { dueWork } from "../src/schedule.mjs";

/* INTEGRATION
 *
 * Every piece here was built separately. These tests exist because separately
 * correct pieces are not the same as a working product: the client and the
 * endpoint have to agree on a signature byte for byte, the monitor has to
 * respect the safety gate, and a queued removal has to reach the app only
 * after a human said so.
 *
 * The app under test is a real repaired app with the generated endpoints,
 * running in a real process. Nothing here is mocked except Stripe itself.
 */

const PORT = 4212;
const FIXTURE = path.resolve("fixtures", "repairable-app");
const SECRET = "akeso-integration-secret";

async function withRepairedApp(run) {
  const root = path.join(await mkdtemp(path.join(tmpdir(), "akeso-integration-")), "app");
  await cp(FIXTURE, root, { recursive: true });
  await cp(path.join(root, "tutorial-handler.mjs.txt"), path.join(root, "app/api/stripe/webhook/route.mjs"));
  await rm(path.join(root, ".akeso"), { recursive: true, force: true });
  await rm(path.join(root, "akeso"), { recursive: true, force: true });

  const detection = await detect(root);
  await applyFixPlan(root, buildFixPlan({ detection, withEndpoints: true }), { stamp: "integration" });

  const busy = await fetch(`http://localhost:${PORT}/api/akeso-probe?account=x`).then(() => true).catch(() => false);
  assert.equal(busy, false, `something is already listening on port ${PORT}`);

  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), AKESO_FIXTURE_DB: path.join(root, "data", "db.json"), AKESO_SHARED_SECRET: SECRET },
    stdio: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 60; i += 1) {
      up = await fetch(`http://localhost:${PORT}/api/akeso-probe?account=s1`).then((r) => r.ok).catch(() => false);
      if (up) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(up, "the repaired fixture never came up");
    return await run({ root, endpoint: `http://localhost:${PORT}/api/akeso/restore`, listUrl: `http://localhost:${PORT}/api/akeso/entitlements` });
  } finally {
    server.kill();
  }
}

const probe = (account) =>
  fetch(`http://localhost:${PORT}/api/akeso-probe?account=${account}`).then((r) => r.json()).then((b) => b.billingEntitled);

/* ------------------------------- the two halves actually speak to each other */

test("the restore client and the generated endpoint agree, byte for byte", async () => {
  await withRepairedApp(async ({ endpoint }) => {
    assert.equal(await probe("s1"), false);

    const outcome = await restoreEntitlement({
      endpoint, secret: SECRET, account: "s1", target: true,
      expectedState: false, reasonCode: "integration", idempotencyKey: "int-1",
    });

    assert.equal(outcome.result, "applied", `client and endpoint disagreed: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.verified, true, "success is only success once the app re-read it");
    assert.equal(await probe("s1"), true, "the app really changed");
  });
});

test("a client signing with the wrong secret is refused by the app", async () => {
  await withRepairedApp(async ({ endpoint }) => {
    const outcome = await restoreEntitlement({
      endpoint, secret: "the-wrong-secret", account: "s1", target: true, idempotencyKey: "int-2",
    });
    assert.notEqual(outcome.result, "applied");
    assert.equal(await probe("s1"), false, "a refused request must change nothing");
  });
});

test("a dry run through the whole path changes nothing and is never applied", async () => {
  await withRepairedApp(async ({ endpoint }) => {
    const outcome = await restoreEntitlement({
      endpoint, secret: SECRET, account: "s1", target: true, dryRun: true, idempotencyKey: "int-3",
    });
    assert.notEqual(outcome.result, "applied", "a dry run must never report applied");
    assert.equal(await probe("s1"), false);
  });
});

test("an unreachable app is our failure, with the outcome reported as unknown", async () => {
  const outcome = await restoreEntitlement({
    endpoint: "http://localhost:9/api/akeso/restore",
    secret: SECRET, account: "s1", target: true, idempotencyKey: "int-4", timeoutMs: 1500,
  });
  assert.equal(outcome.result, "could_not_reach");
  assert.match(JSON.stringify(outcome), /unknown/i, "it must say the outcome is unknown, never that nothing happened");
});

test("the secret never appears anywhere in a returned outcome", async () => {
  await withRepairedApp(async ({ endpoint }) => {
    const outcomes = [
      await restoreEntitlement({ endpoint, secret: SECRET, account: "s1", target: true, idempotencyKey: "s-1" }),
      await restoreEntitlement({ endpoint, secret: SECRET, account: "nope", target: true, idempotencyKey: "s-2" }),
      await restoreEntitlement({ endpoint: "http://localhost:9/x", secret: SECRET, account: "s1", target: true, timeoutMs: 800 }),
    ];
    for (const outcome of outcomes) {
      assert.ok(!JSON.stringify(outcome).includes(SECRET), `the secret leaked: ${JSON.stringify(outcome)}`);
    }
  });
});

/* --------------------------------- the monitor drives the real write path */

test("a full sweep restores a locked-out payer through the real endpoint", async () => {
  await withRepairedApp(async ({ root, endpoint, listUrl }) => {
    /* Set up both directions of drift on a real app:
       s1 pays but is locked out (Akeso fixes this immediately).
       s2 cancelled but still has access (Akeso must NOT touch it).
       s2 needs access granted first, or "still has access" is not true and the
       test would pass while proving nothing. */
    await restoreEntitlement({
      endpoint, secret: SECRET, account: "s2", target: true,
      expectedState: false, reasonCode: "seed", idempotencyKey: "seed-s2",
    });
    assert.equal(await probe("s2"), true, "the leak must actually exist before we test that it is left alone");

    const result = await runSweep({
      root,
      stripeKey: "sk_test_integration",
      fetchSubscriptions: async () => [
        { account: "s1", status: "active", priceMonthly: 29 },
        { account: "s2", status: "canceled", priceMonthly: 29 },
      ],
      readAppEntitlements: async () => {
        const body = JSON.stringify({});
        const { signRequest } = await import("../src/restore.mjs");
        const response = await fetch(listUrl, {
          method: "POST",
          headers: { "content-type": "application/json", "akeso-signature": signRequest(body, SECRET) },
          body,
        });
        const json = await response.json();
        return json.accounts;
      },
      apply: true,
      restore: async (account, target, meta) => restoreEntitlement({
        endpoint, secret: SECRET, account, target,
        expectedState: meta.expected, reasonCode: meta.reasonCode, idempotencyKey: meta.idempotencyKey,
      }),
    });

    assert.equal(result.drift.grants.length, 1);
    assert.equal(await probe("s1"), true, "the paying customer was let back in");
    assert.equal(await probe("s2"), true, "the cancelled one still has access, because removal is never automatic");
    assert.equal(result.queuedRemovals.length, 1, "the removal waits for a human");

    const ledger = await readLedger(root);
    assert.equal(verifyLedger(ledger).intact, true, "the history of a real write must verify");
    const restore = ledger.find((entry) => entry.kind === "restore");
    assert.equal(restore.verified, true);
  });
});

/* ----------------------------------- safety actually gates the write path */

test("a halted system refuses every write, including grants", async () => {
  await withRepairedApp(async ({ root }) => {
    await haltNow(root, { reason: "integration test", by: "test" });
    assert.equal((await isHalted(root)).halted, true);

    const entries = await readLedger(root);
    const grant = await guardWrite(root, { account: "s1", direction: "grant", entries, now: Date.now() });
    const removal = await guardWrite(root, { account: "s2", direction: "remove", entries, now: Date.now() });

    assert.equal(grant.allowed, false, "a kill switch that only stops removals is not a kill switch");
    assert.equal(removal.allowed, false);

    await resumeHalt(root, { by: "test" });
    assert.equal((await isHalted(root)).halted, false);
    const after = await guardWrite(root, { account: "s1", direction: "grant", entries: await readLedger(root), now: Date.now() });
    assert.equal(after.allowed, true, "resuming must actually resume");
  });
});

/* ------------------------------- a removal reaches the app only via a human */

test("a queued removal does nothing until a human approves it", async () => {
  await withRepairedApp(async ({ root, endpoint }) => {
    /* Give s4 access first, so removing it is a real change. */
    await restoreEntitlement({ endpoint, secret: SECRET, account: "s4", target: true, expectedState: false, idempotencyKey: "seed" });
    assert.equal(await probe("s4"), true);

    const queued = await queueRemoval(root, {
      account: "s4", reason: "Stripe says canceled", priceMonthly: 29,
      expectedState: true, ruleVersion: "1", delayMinutes: 0,
    });

    /* Queued is not removed. */
    assert.equal(await probe("s4"), true, "queuing must never change anything");

    const pending = pendingApprovals(await readLedger(root), { now: Date.now() });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].account, "s4");

    await approve(root, queued.id, { by: "jace" });
    assert.equal(pendingApprovals(await readLedger(root), { now: Date.now() }).length, 0, "an approved removal leaves the queue");

    /* A removal will not travel without naming the approval that authorised
       it, even after a human approved: the write path refuses an untraceable
       removal, and that refusal is the point. */
    const unnamed = await restoreEntitlement({
      endpoint, secret: SECRET, account: "s4", target: false, direction: "remove",
      expectedState: true, reasonCode: "approved-removal", idempotencyKey: queued.id,
    });
    assert.notEqual(unnamed.result, "applied", "a removal with no approval named must never be sent");
    assert.equal(await probe("s4"), true, "and it must not have changed anything");

    /* Named, it goes. */
    const outcome = await restoreEntitlement({
      endpoint, secret: SECRET, account: "s4", target: false, direction: "remove",
      expectedState: true, reasonCode: "approved-removal",
      idempotencyKey: queued.id, approvalId: queued.id,
    });
    assert.equal(outcome.result, "applied");
    assert.equal(await probe("s4"), false);
  });
});

/* ------------------------------------- certification gates the whole thing */

test("coverage is not claimed before certification, and goes stale when the schema moves", async () => {
  await withRepairedApp(async ({ root }) => {
    const fingerprint = fingerprintSchema({ table: "profiles", column: "is_pro", accountColumn: "id" });

    const before = certificationStatus(await readLedger(root), { schemaFingerprint: fingerprint, now: Date.now() });
    assert.equal(before.certified, false, "there is no implicit certification");

    await certify(root, {
      policy: { entitledWhilePastDue: true, entitledWhilePaused: false, neverConclude: ["incomplete"], ruleVersion: "1" },
      priceToPlan: { price_1: "Pro" },
      schemaFingerprint: fingerprint,
      adapterVersion: "1",
    });

    const after = certificationStatus(await readLedger(root), { schemaFingerprint: fingerprint, now: Date.now() });
    assert.equal(after.certified, true);
    assert.equal(after.stale, false);

    /* The founder renames the column. Everything Akeso certified is now about
       a schema that no longer exists. */
    const moved = fingerprintSchema({ table: "profiles", column: "is_premium", accountColumn: "id" });
    const drifted = certificationStatus(await readLedger(root), { schemaFingerprint: moved, now: Date.now() });
    assert.equal(drifted.stale, true, "a changed schema must invalidate certification");
    /* The reason is checked for meaning, not for jargon: a founder reads this,
       so "schema" is exactly the word it should NOT need to use. */
    assert.match(String(drifted.staleReason), /not the one you certified/i);
    assert.ok(!/fingerprint|schema hash/i.test(String(drifted.staleReason)), "the reason must stay in plain English");
  });
});

/* ------------------------------------------ the statement reads the truth */

test("the monthly statement reports what really happened, and admits gaps", async () => {
  await withRepairedApp(async ({ root, endpoint, listUrl }) => {
    await runSweep({
      root,
      stripeKey: "sk_test_x",
      fetchSubscriptions: async () => [{ account: "s5", status: "active", priceMonthly: 12 }],
      readAppEntitlements: async () => [{ account: "s5", billingEntitled: false }],
      apply: true,
      restore: async (account, target, meta) => restoreEntitlement({
        endpoint, secret: SECRET, account, target,
        expectedState: meta.expected, reasonCode: meta.reasonCode, idempotencyKey: meta.idempotencyKey,
      }),
    });

    const ledger = await readLedger(root);
    const month = new Date().toISOString().slice(0, 7);
    const statement = monthlyStatement(ledger, { month, now: Date.now() });

    assert.equal(statement.accessRestored, 1);
    assert.equal(statement.revenueRecovered, null, "revenue Akeso cannot see is never a number");
    const text = renderStatementText(statement);
    assert.ok(!/\$0\b/.test(text.split("\n").find((line) => /revenue/i.test(line)) || ""), "revenue is never printed as zero");
  });
});

test("a month Akeso never ran is reported as not run, never as clean", async () => {
  const statement = monthlyStatement([], { month: "2026-01", now: Date.parse("2026-02-01T00:00:00Z") });
  const text = renderStatementText(statement).toLowerCase();
  assert.equal(statement.sweeps, 0);
  assert.ok(!text.includes("everything matches"), "silence is not a clean bill of health");
  assert.ok(/did not run|no sweeps|never ran/.test(text), `statement did not admit it never ran: ${text}`);
});

/* ------------------------------------------------ scheduling sees reality */

test("a sweep that could not run leaves the next one still due", async () => {
  await withRepairedApp(async ({ root }) => {
    await runSweep({
      root,
      stripeKey: "sk_test_x",
      fetchSubscriptions: async () => { throw new Error("Stripe answered 401"); },
      readAppEntitlements: async () => [],
    });

    const due = dueWork(await readLedger(root), { now: Date.now() });
    assert.equal(due.full, true, "a broken monitor must not look like a quiet one");
  });
});
