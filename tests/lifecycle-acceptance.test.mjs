import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { runLifecycle } from "../src/lifecycle.mjs";

/* THE acceptance test from the master doc: the Check must catch the broken app
   (F, with the cancel scenario failing) and clear the fixed one (A). If either
   half fails, the Check is not ready — a checker that misses the bug it was
   built for, or that alarms on a healthy app, is worse than no checker. */

async function withFixture(name, port, run) {
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: path.resolve("fixtures", name),
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });
  try {
    for (let i = 0; i < 50; i += 1) {
      try { await fetch(`http://localhost:${port}/__akeso_probe?account=warmup`); break; }
      catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    return await run({
      webhookUrl: `http://localhost:${port}/api/stripe/webhook`,
      probeUrl: `http://localhost:${port}/__akeso_probe`,
      webhookSecret: "whsec_fixturefixturefixture5678",
    });
  } finally {
    server.kill();
  }
}

test("the broken app grades F, and for the right reason", async () => {
  const outcome = await withFixture("broken-app", 4101, runLifecycle);
  assert.equal(outcome.grade.letter, "F");
  const cancel = outcome.results.find((r) => r.id === "cancel-at-period-end");
  assert.equal(cancel.outcome, "fail", "the money-leaking scenario must be the one that fails");
  assert.equal(cancel.observed, true, "canceled customer still shows entitled — that is the bug");
  assert.equal(outcome.results.find((r) => r.id === "checkout-grants").outcome, "pass");
});

test("the fixed app grades A — no alarms on a healthy app", async () => {
  const outcome = await withFixture("fixed-app", 4102, runLifecycle);
  assert.equal(outcome.grade.letter, "A", JSON.stringify(outcome.results.filter(r => r.outcome !== "pass"), null, 2));
});

test("shared real account: grants after the first are not provable, never vacuous passes", async () => {
  /* Deployed apps have no rows for made-up accounts, so every scenario maps
     onto one real account. On a grant-only broken app that account stays
     entitled forever — later grant scenarios must refuse to claim a pass. */
  const outcome = await withFixture("broken-app", 4103, (opts) =>
    runLifecycle({ ...opts, accountFor: () => "shared-real-account" }));
  assert.equal(outcome.grade.letter, "F");
  assert.equal(outcome.results.find((r) => r.id === "checkout-grants").outcome, "pass");
  assert.equal(outcome.results.find((r) => r.id === "trial-converts").outcome, "not_provable");
  assert.equal(outcome.results.find((r) => r.id === "reactivation").outcome, "not_provable");
  assert.equal(outcome.results.find((r) => r.id === "cancel-at-period-end").outcome, "fail");
});

test("shared account + reset on the FIXED app: one real account proves everything", async () => {
  /* The real-world mode: a deployed app has one usable account. Resetting it
     between scenarios (with a cancellation the app understands) must make
     every scenario provable — grade A, nothing vacuous, nothing skipped. */
  const account = `shared-${Date.now()}`; /* fixture state persists on disk across runs */
  const outcome = await withFixture("fixed-app", 4104, (opts) =>
    runLifecycle({ ...opts, accountFor: () => account, resetBeforeEach: true }));
  assert.equal(outcome.grade.letter, "A", JSON.stringify(outcome.results.filter(r => r.outcome !== "pass"), null, 2));
  assert.equal(outcome.results.filter((r) => r.outcome === "not_provable").length, 0);
});

test("a dead server is our failure, never the app's grade", async () => {
  const outcome = await runLifecycle({
    webhookUrl: "http://localhost:59999/api/stripe/webhook",
    probeUrl: "http://localhost:59999/__akeso_probe",
    webhookSecret: "whsec_nothing",
  });
  assert.equal(outcome.grade.letter, "?");
  assert.ok(outcome.results.every((r) => r.outcome === "could_not_test"));
});
