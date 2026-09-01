import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detect } from "../src/detect.mjs";
import { runLifecycle } from "../src/lifecycle.mjs";
import { applyFixPlan, buildFixPlan, revertFix } from "../src/fix.mjs";
import { webhookUrlFor } from "../src/webhook-url.mjs";

/* The whole product on a PRISMA app, the shape five of eight real starter
 * kits take. The generated entitlement module here is the Prisma-native one
 * (raw parameterised SQL through the app's own client), executed through a
 * client double that refuses any literal value in a statement.
 *
 * Original note follows.
 *
 * The whole product, in one test, on code that actually runs.
 *
 * A tutorial-shaped app (verifies signatures, listens only for
 * checkout.session.completed) is graded, repaired, and graded again — and the
 * second grade comes from executing the GENERATED handler and the GENERATED
 * entitlement module against real signed events. Nothing here is stubbed
 * except the two third-party SDKs, and both of those keep their real
 * contracts: the Stripe double performs genuine HMAC verification, and the
 * database double returns errors as values the way supabase-js does.
 *
 * If this test passes, the claim "Akeso finds it, fixes it, and proves the
 * fix" is true. If it fails, the claim is false. That is the whole point.
 */

const PORT = 4213;
const FIXTURE = path.resolve("fixtures", "repairable-prisma-app");
const SECRET = "whsec_fixturefixturefixture5678";

async function withRunningCopy(run) {
  /* A copy, so the test never mutates the fixture in the repository. */
  const root = path.join(await mkdtemp(path.join(tmpdir(), "akeso-e2e-prisma-")), "app");
  await cp(FIXTURE, root, { recursive: true });

  /* Start from the tutorial handler every time, whatever state the fixture
     was left in. A previous run's successful repair once made this test start
     from an already-fixed app, where "the broken app grades F" passed for the
     wrong reason — the exact vacuous-pass failure this project exists to
     refuse, found in its own test suite. */
  await cp(path.join(root, "tutorial-handler.mjs.txt"), path.join(root, "app/api/stripe/webhook/route.mjs"));
  await rm(path.join(root, ".akeso"), { recursive: true, force: true });
  await rm(path.join(root, "akeso"), { recursive: true, force: true });

  const busy = await fetch(`http://localhost:${PORT}/api/akeso-probe?account=x`).then(() => true).catch(() => false);
  assert.equal(busy, false, `something is already listening on port ${PORT}; stop it and run the tests again`);

  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), AKESO_FIXTURE_DB: path.join(root, "data", "db.json") },
    stdio: "ignore",
  });
  try {
    let up = false;
    for (let i = 0; i < 60; i += 1) {
      up = await fetch(`http://localhost:${PORT}/api/akeso-probe?account=s1`).then((r) => r.ok).catch(() => false);
      if (up) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(up, "the repairable fixture never came up");
    return await run(root);
  } finally {
    server.kill();
  }
}

const grade = async (root) => {
  const detection = await detect(root);
  const outcome = await runLifecycle({
    webhookUrl: webhookUrlFor(detection, `http://localhost:${PORT}`),
    probeUrl: `http://localhost:${PORT}/api/akeso-probe`,
    webhookSecret: SECRET,
    settleMs: 60,
  });
  return { detection, outcome };
};

test("the whole loop on Prisma: a broken app is graded F, repaired, and proven A", async () => {
  await withRunningCopy(async (root) => {
    /* 1. The Check, on the app as the founder wrote it. */
    const before = await grade(root);
    assert.equal(before.outcome.grade.letter, "F", "a grant-only handler must fail");
    assert.equal(
      before.outcome.results.find((result) => result.id === "immediate-cancel").outcome, "fail",
      "the money-leaking scenario is the one that fails",
    );

    /* 2. The Fix, built from that evidence and applied. */
    const plan = buildFixPlan({ detection: before.detection, lifecycle: before.outcome });
    assert.ok(plan.repairs.some((repair) => repair.id === "removals-must-remove"));
    const applied = await applyFixPlan(root, plan, { stamp: "e2e" });
    assert.ok(applied.written.some((file) => file.action === "replaced"), "the founder's handler was replaced");

    /* 3. The Check again — the same judge, now grading the generated code as
          it actually executes. */
    const after = await grade(root);
    assert.equal(after.outcome.grade.letter, "A",
      `the repair must pass its own test. Failing scenarios: ${after.outcome.results.filter((r) => r.outcome === "fail").map((r) => r.id).join(", ")}`);

    for (const result of after.outcome.results) {
      assert.notEqual(result.outcome, "fail", `${result.name} still fails after the repair`);
    }

    /* 4. Undo, and the app is exactly what it was. */
    const reverted = await revertFix(root, { files: applied.written, backupDir: applied.backupDir });
    assert.equal(reverted.refused.length, 0);
    const restored = await grade(root);
    assert.equal(restored.outcome.grade.letter, "F", "revert must genuinely put the old behaviour back");
  });
});

test("the Prisma-native generated handler rejects a forged event", async () => {
  await withRunningCopy(async (root) => {
    const detection = await detect(root);
    await applyFixPlan(root, buildFixPlan({ detection }), { stamp: "e2e-forge" });

    const forged = await fetch(webhookUrlFor(detection, `http://localhost:${PORT}`), {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
      body: JSON.stringify({ id: "evt_forged", type: "checkout.session.completed", created: 1, data: { object: { client_reference_id: "s1" } } }),
    });
    assert.equal(forged.status, 400, "an event with a bad signature must be refused");

    const probe = await fetch(`http://localhost:${PORT}/api/akeso-probe?account=s1`).then((r) => r.json());
    assert.equal(probe.billingEntitled, false, "a forged event must not grant access");
  });
});

test("the Prisma-native generated code names the real table and column", async () => {
  await withRunningCopy(async (root) => {
    const plan = buildFixPlan({ detection: await detect(root) });
    const entitlement = plan.files.find((file) => file.path.includes("entitlement")).contents;
    assert.match(entitlement, /from "@prisma\/client"/, "finished code through the app's own client, not a stub");
    assert.match(entitlement, /FROM "users"/, "the @@map table name");
    assert.match(entitlement, /"stripe_price_id"/, "the @map column name, not the Prisma field name");
    assert.ok(!entitlement.includes("yourDatabase"), "no TODO stubs on a Prisma app");
    assert.ok(!/'\$\{/.test(entitlement), "values are parameters, never interpolated into SQL");
  });
});
