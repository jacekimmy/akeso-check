import assert from "node:assert/strict";
import test from "node:test";
import { nextStep } from "../src/next-step.mjs";

/* The loop is the product: check -> fix -> check again -> monitor. A founder
   should never have to hold that sequence in their head, which means these
   answers have to be right at every point in it. */

const detection = (over = {}) => ({
  webhookHandlers: [{ file: "app/api/stripe/webhook/route.ts" }],
  ...over,
});

const entry = (kind, over = {}) => ({ kind, seq: over.seq ?? 1, hash: `h${over.seq ?? 1}`, ...over });

test("nothing checked yet points at the Check", () => {
  const step = nextStep({});
  assert.equal(step.stage, "start");
  assert.equal(step.command, "npx akeso-check");
});

test("a code read alone points at the live test", () => {
  const step = nextStep({ detection: detection(), ledger: [entry("check", { grade: null })] });
  assert.equal(step.stage, "needs-live-test");
  assert.match(step.command, /--lifecycle-url/);
  assert.ok(step.firstDoThis.includes("npm run dev"), "it says to start the app first");
});

test("an app whose webhook shape is unsupported is told so, not sent in circles", () => {
  const step = nextStep({
    detection: detection({ webhookHandlers: [{ file: "supabase/functions/stripe/index.ts" }] }),
    ledger: [entry("check")],
  });
  assert.equal(step.stage, "static-only-unsupported");
  assert.equal(step.command, null, "no command is better than a command that cannot work");
});

test("a failing grade points at the Fix", () => {
  const step = nextStep({ detection: detection(), lifecycle: { grade: { letter: "F" } } });
  assert.equal(step.stage, "needs-fix");
  assert.equal(step.command, "npx akeso-check fix");
});

test("a passing grade points at the Monitor, and says why code alone is not enough", () => {
  const step = nextStep({ detection: detection(), lifecycle: { grade: { letter: "A" } } });
  assert.equal(step.stage, "monitor");
  assert.equal(step.command, "npx akeso-check monitor");
  assert.match(step.why, /already drifted/, "it explains that correct code does not fix old accounts");
});

test("a fix that did not hold is called out, never re-suggested blindly", () => {
  const step = nextStep({
    detection: detection(),
    lifecycle: { grade: { letter: "F" } },
    ledger: [entry("check", { seq: 1, grade: "F" }), entry("fix", { seq: 2 })],
  });
  assert.equal(step.stage, "fix-did-not-hold");
  assert.match(step.why, /will not call a repair successful/);
});

test("a run that could not test anything blames the run, not the app", () => {
  const step = nextStep({ detection: detection(), lifecycle: { grade: { letter: "?" } } });
  assert.equal(step.stage, "could-not-test");
  assert.match(step.headline, /no verdict/);
});

test("the sandbox grade decides when both drivers ran", () => {
  const step = nextStep({
    detection: detection(),
    lifecycle: { grade: { letter: "A" } },
    sandbox: { grade: { letter: "F" } },
  });
  assert.equal(step.stage, "needs-fix", "a real-event failure must not be hidden by a synthetic pass");
});
