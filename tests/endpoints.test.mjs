import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detect } from "../src/detect.mjs";
import { applyFixPlan, buildFixPlan } from "../src/fix.mjs";

/* The generated endpoints are the entire surface of what Akeso can do to a
 * customer's app: one boolean, one account, through their own guarded
 * function. They are executed here, not string-matched, because "the auth
 * check is present in the source" and "the auth check actually refuses" are
 * different claims and only the second one protects anyone.
 */

const PORT = 4211;
const FIXTURE = path.resolve("fixtures", "repairable-app");
const SECRET = "akeso-shared-secret-for-tests";

const sign = (body, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) =>
  `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

const call = (route, payload, header) => {
  const body = JSON.stringify(payload);
  return fetch(`http://localhost:${PORT}/api/akeso/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(header ? { "akeso-signature": header } : {}) },
    body,
  });
};

async function withRepairedApp(run) {
  const root = path.join(await mkdtemp(path.join(tmpdir(), "akeso-endpoints-")), "app");
  await cp(FIXTURE, root, { recursive: true });
  await cp(path.join(root, "tutorial-handler.mjs.txt"), path.join(root, "app/api/stripe/webhook/route.mjs"));
  await rm(path.join(root, ".akeso"), { recursive: true, force: true });
  await rm(path.join(root, "akeso"), { recursive: true, force: true });

  /* Apply the repair WITH the monitoring endpoints, which is what a founder
     who wants the monitor runs. */
  const detection = await detect(root);
  await applyFixPlan(root, buildFixPlan({ detection, withEndpoints: true }), { stamp: "endpoints" });

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
    return await run(root);
  } finally {
    server.kill();
  }
}

test("an unsigned request is refused and changes nothing", async () => {
  await withRepairedApp(async () => {
    const response = await call("restore", { account: "s1", target: true });
    assert.equal(response.status, 401);

    const probe = await fetch(`http://localhost:${PORT}/api/akeso-probe?account=s1`).then((r) => r.json());
    assert.equal(probe.billingEntitled, false, "a refused request must not have written anything");
  });
});

test("a forged signature is refused", async () => {
  await withRepairedApp(async () => {
    const body = JSON.stringify({ account: "s1", target: true });
    const wrong = sign(body, "not-the-secret");
    assert.equal((await call("restore", { account: "s1", target: true }, wrong)).status, 401);

    const probe = await fetch(`http://localhost:${PORT}/api/akeso-probe?account=s1`).then((r) => r.json());
    assert.equal(probe.billingEntitled, false);
  });
});

test("a replayed old signature is refused", async () => {
  await withRepairedApp(async () => {
    const payload = { account: "s1", target: true };
    const body = JSON.stringify(payload);
    /* Captured an hour ago. The timestamp is inside the signed material, so a
       valid-forever signature is exactly what this prevents. */
    const stale = sign(body, SECRET, Math.floor(Date.now() / 1000) - 3600);
    assert.equal((await call("restore", payload, stale)).status, 401);
  });
});

test("a signed restore grants access and confirms it by re-reading", async () => {
  await withRepairedApp(async () => {
    const payload = { account: "s1", target: true, expectedState: false, reasonCode: "test", idempotencyKey: "k1" };
    const response = await call("restore", payload, sign(JSON.stringify(payload)));
    const outcome = await response.json();

    assert.equal(outcome.result, "applied");
    assert.equal(outcome.verified, true, "the endpoint must confirm by re-reading, not assume");
    assert.equal(outcome.after.billingEntitled, true);

    const probe = await fetch(`http://localhost:${PORT}/api/akeso-probe?account=s1`).then((r) => r.json());
    assert.equal(probe.billingEntitled, true, "the app really changed");
  });
});

test("a dry run reports what would happen and changes nothing", async () => {
  await withRepairedApp(async () => {
    const payload = { account: "s1", target: true, dryRun: true };
    const outcome = await (await call("restore", payload, sign(JSON.stringify(payload)))).json();

    assert.equal(outcome.result, "dry_run");
    assert.notEqual(outcome.result, "applied", "a dry run that reports applied is a protocol violation");

    const probe = await fetch(`http://localhost:${PORT}/api/akeso-probe?account=s1`).then((r) => r.json());
    assert.equal(probe.billingEntitled, false, "a dry run must not write");
  });
});

test("a restore whose expected state no longer matches loses, loudly", async () => {
  await withRepairedApp(async () => {
    /* Grant first, so the account is already entitled. */
    const grant = { account: "s1", target: true, expectedState: false, idempotencyKey: "k1" };
    await call("restore", grant, sign(JSON.stringify(grant)));

    /* Now a restore prepared when the account looked NOT entitled arrives late.
       Compare-and-set must refuse rather than race. */
    const stale = { account: "s2", target: true, expectedState: true, idempotencyKey: "k2" };
    const outcome = await (await call("restore", stale, sign(JSON.stringify(stale)))).json();
    assert.equal(outcome.result, "conflict");
  });
});

test("a blocked account is never restored, whatever Stripe says", async () => {
  await withRepairedApp(async (root) => {
    /* Mark the account as abuse-blocked, the way an admin would. */
    const dbPath = path.join(root, "data", "db.json");
    const { readFile, writeFile } = await import("node:fs/promises");
    const db = JSON.parse(await readFile(dbPath, "utf8"));
    db.tables.profiles.find((row) => row.id === "s3").abuse_block = true;
    await writeFile(dbPath, JSON.stringify(db, null, 2));

    const payload = { account: "s3", target: true, expectedState: false, idempotencyKey: "k3" };
    const outcome = await (await call("restore", payload, sign(JSON.stringify(payload)))).json();

    assert.equal(outcome.result, "unsupported");
    assert.match(outcome.reason, /block/);
    const probe = await fetch(`http://localhost:${PORT}/api/akeso-probe?account=s3`).then((r) => r.json());
    assert.equal(probe.billingEntitled, false, "a blocked account must stay blocked");
  });
});

test("the entitlements list needs a signature too", async () => {
  await withRepairedApp(async () => {
    assert.equal((await call("entitlements", {})).status, 401, "who is paying you is not public");

    const payload = {};
    const listed = await (await call("entitlements", payload, sign(JSON.stringify(payload)))).json();
    assert.ok(Array.isArray(listed.accounts));
    assert.ok(listed.accounts.length > 0);
    for (const row of listed.accounts) {
      assert.equal(typeof row.account, "string");
      assert.equal(typeof row.billingEntitled, "boolean");
    }
  });
});

test("a rule version from a different policy is refused", async () => {
  await withRepairedApp(async () => {
    const payload = { account: "s1", target: true, ruleVersion: "999", idempotencyKey: "k9" };
    const outcome = await (await call("restore", payload, sign(JSON.stringify(payload)))).json();
    assert.equal(outcome.result, "conflict");
    assert.match(outcome.reason, /rules changed/);
  });
});
