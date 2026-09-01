import assert from "node:assert/strict";
import test from "node:test";
import { renderReport } from "../src/report.mjs";
import { gradeOf } from "../src/lifecycle.mjs";

/* The sandbox pass merges into the same report a founder already knows. The
   rules under test: the worse driver decides the letter (a clean synthetic
   pass must never hide a real-event failure), a sandbox-only run is not
   "static only", and the page never claims real-event coverage it did not do. */

const detection = {
  root: "/tmp/app",
  framework: { packageName: "watch-this", framework: "next-app-router" },
  database: { kind: "supabase" },
  stripe: { secretKey: { mode: "TEST", lastFour: "1234" } },
  webhookHandlers: [{ file: "app/api/stripe/webhook/route.ts", verifiesSignature: true, rawBodySeen: true, handledEvents: ["checkout.session.completed"], missingEvents: [] }],
  accessDecisionSites: [],
  capabilities: { blockers: [] },
};

const phase = (name, outcome, { expected = true, critical = false, reason } = {}) =>
  ({ phase: name, expected, observed: outcome === "pass" ? expected : !expected, outcome, critical, reason, eventsDelivered: [] });

const sandboxResult = (phases) => ({
  driver: "stripe-sandbox",
  phases,
  grade: gradeOf(phases.map((p) => ({ ...p, id: p.phase }))),
  passed: phases.every((p) => p.outcome === "pass"),
  notProvable: [],
  criticalFailure: phases.find((p) => p.critical && p.outcome === "fail") || null,
});

const lifecycleA = {
  scenarioCount: 10,
  grade: { letter: "A", reason: "Every lifecycle scenario passed." },
  results: [{ id: "checkout-grants", name: "New payment unlocks access", expected: true, observed: true, outcome: "pass", critical: false }],
};

test("a real-event critical failure overrides a clean synthetic pass", () => {
  const sandbox = sandboxResult([
    phase("real subscription grants access", "pass"),
    phase("cancellation removes access", "fail", { expected: false, critical: true }),
  ]);
  assert.equal(sandbox.grade.letter, "F");
  const html = renderReport({ detection, lifecycle: lifecycleA, sandbox });
  assert.ok(html.includes('g-F">F<'), "the card must show F, not the synthetic A");
  assert.ok(html.includes("What real Stripe events showed"), "sandbox section present");
  assert.ok(html.includes("access should have ended, but your app still grants it"));
});

test("a sandbox-only run is a real run, not static analysis", () => {
  const sandbox = sandboxResult([
    phase("real subscription grants access", "pass"),
    phase("trial ends and converts to a paying subscription", "pass"),
    phase("monthly renewal keeps access", "pass"),
    phase("cancellation removes access", "pass", { expected: false, critical: true }),
  ]);
  assert.equal(sandbox.grade.letter, "A");
  const html = renderReport({ detection, lifecycle: null, sandbox });
  assert.ok(!html.includes("has not run yet"), "must not claim nothing ran");
  assert.ok(!html.includes("acted out ten"), "must not claim the synthetic scenarios ran");
  assert.ok(html.includes('g-A">A<'));
  assert.ok(html.includes("not tested on this run"), "must state the synthetic-only scenarios were not covered");
});

test("could-not-test phases cap the sandbox at B and blame the run, not the app", () => {
  const sandbox = sandboxResult([
    phase("real subscription grants access", "pass"),
    phase("trial ends and converts to a paying subscription", "could_not_test", { reason: "the test clock did not finish advancing in time" }),
    phase("cancellation removes access", "pass", { expected: false, critical: true }),
  ]);
  assert.equal(sandbox.grade.letter, "B");
  const html = renderReport({ detection, lifecycle: lifecycleA, sandbox });
  assert.ok(html.includes('g-B">B<'), "the worse of A and B is B");
  assert.ok(html.includes("the test clock did not finish advancing in time"));
});

test("an untestable synthetic run defers to a sandbox that did test", () => {
  const sandbox = sandboxResult([
    phase("real subscription grants access", "pass"),
    phase("cancellation removes access", "pass", { expected: false, critical: true }),
  ]);
  const html = renderReport({
    detection,
    lifecycle: { scenarioCount: 10, grade: { letter: "?", reason: "Nothing could be tested." }, results: [] },
    sandbox,
  });
  assert.ok(html.includes('g-A">A<'), "? must not outrank a tested A");
});
