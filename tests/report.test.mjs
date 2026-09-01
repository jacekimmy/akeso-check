import assert from "node:assert/strict";
import test from "node:test";
import { renderReport } from "../src/report.mjs";

/* The report may never describe work that did not happen. A real user ran the
   default static pass and was told "the run itself had problems" over a clean
   code read, on a page claiming Akeso had acted out ten billing situations.
   Nothing had executed. These tests exist so that cannot come back. */

const detection = {
  root: "/tmp/app",
  framework: { packageName: "watch-this", framework: "next-app-router" },
  database: { kind: "supabase" },
  stripe: { secretKey: { mode: "TEST", lastFour: "1234" } },
  webhookHandlers: [{ file: "app/api/stripe/webhook/route.ts", verifiesSignature: true, rawBodySeen: true, handledEvents: ["checkout.session.completed"], missingEvents: [] }],
  accessDecisionSites: [],
  capabilities: { blockers: [] },
};

test("a static-only run never claims the lifecycle was acted out", () => {
  const html = renderReport({ detection, lifecycle: null });
  assert.ok(!html.includes("acted out ten"), "must not claim ten situations were run");
  assert.ok(!html.includes("run itself had problems"), "a clean code read is not a broken run");
  assert.ok(html.includes("has not run yet"), "must say the live test has not run");
  assert.ok(html.includes("--lifecycle-url"), "must show how to run the real test");
});

test("a static-only run leads with what the code actually showed", () => {
  const clean = renderReport({ detection, lifecycle: null });
  assert.match(clean, /<h1>Your billing code reads clean\./);

  const broken = renderReport({
    detection: { ...detection, webhookHandlers: [{ ...detection.webhookHandlers[0], missingEvents: ["invoice.paid", "customer.subscription.deleted"] }] },
    lifecycle: null,
  });
  assert.match(broken, /<h1>Your webhook ignores 2 of the 7 billing events\./);
});

test("a graded run still shows its grade and scenarios", () => {
  const html = renderReport({
    detection,
    lifecycle: {
      scenarioCount: 1,
      grade: { letter: "F", reason: "Customers who cancel keep their paid access." },
      results: [{ id: "cancel", name: "Customer cancels", expected: false, observed: true, outcome: "fail", critical: true }],
    },
  });
  assert.ok(html.includes(">F<"), "grade letter shown");
  assert.ok(html.includes("acted out ten"), "the real run may describe itself");
  assert.ok(html.includes("Customer cancels"), "scenario rows shown");
});
