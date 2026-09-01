import assert from "node:assert/strict";
import test from "node:test";
import { buildJourney, renderJourney } from "../src/journey.mjs";
import { renderReport } from "../src/report.mjs";

/* The loop picture is evidence, not decoration. A stage drawn as done that
   nobody earned is the most expensive lie this page could tell, so every test
   here is about refusing to draw progress that did not happen. */

const detection = {
  root: "/app",
  framework: { packageName: "demo", framework: "next-app-router" },
  database: { kind: "supabase" },
  stripe: { secretKey: { mode: "TEST", lastFour: "1234" } },
  webhookHandlers: [{ file: "app/api/stripe/webhook/route.ts", verifiesSignature: true, rawBodySeen: true, handledEvents: [], missingEvents: [] }],
  accessDecisionSites: [],
  capabilities: { blockers: [] },
};

const entry = (kind, over = {}) => ({ kind, seq: over.seq ?? 1, hash: `h${over.seq ?? 1}`, ...over });
const stageOf = (journey, id) => journey.stages.find((stage) => stage.id === id);

test("reading code alone never draws the check as done", () => {
  const journey = buildJourney({ detection, ledger: [entry("check", { grade: null })] });
  assert.equal(stageOf(journey, "checked").state, "partial");
  assert.match(stageOf(journey, "checked").proved, /not what it does/);
});

test("an executed run draws the check as done and names the grade", () => {
  const journey = buildJourney({ detection, lifecycle: { grade: { letter: "F" } } });
  assert.equal(stageOf(journey, "checked").state, "done");
  assert.match(stageOf(journey, "checked").proved, /Grade F/);
});

test("writing files is not a repair until something re-tested it", () => {
  /* The whole doctrine in one assertion: the repairer does not grade itself. */
  const journey = buildJourney({
    detection,
    lifecycle: { grade: { letter: "F" } },
    ledger: [entry("check", { seq: 1, grade: "F" }), entry("fix", { seq: 2, files: [{ path: "a" }] })],
  });
  assert.equal(stageOf(journey, "repaired").state, "failed");
  assert.match(stageOf(journey, "repaired").proved, /does not call this repaired/);
});

test("a repair only counts once the same test passes afterwards", () => {
  const journey = buildJourney({
    detection,
    lifecycle: { grade: { letter: "A" } },
    ledger: [entry("check", { seq: 1, grade: "F" }), entry("fix", { seq: 2, files: [{ path: "a" }] }), entry("check", { seq: 3, grade: "A" })],
  });
  assert.equal(stageOf(journey, "repaired").state, "done");
  assert.match(stageOf(journey, "repaired").handsOn, /does not fix accounts that already drifted/);
});

test("a passing app with a completed repair does not also say there was nothing to repair", () => {
  const journey = buildJourney({
    detection,
    lifecycle: { grade: { letter: "A" } },
    ledger: [entry("check", { seq: 1, grade: "F" }), entry("fix", { seq: 2, files: [] }), entry("check", { seq: 3, grade: "A" })],
  });
  assert.equal(stageOf(journey, "checked").handsOn, "Nothing left to repair.");
});

test("a sweep that could not run never counts as watching", () => {
  const journey = buildJourney({
    detection,
    lifecycle: { grade: { letter: "A" } },
    ledger: [entry("check", { seq: 1, grade: "A" }), entry("sweep", { seq: 2, couldNotRun: "Stripe answered 401" })],
  });
  assert.equal(stageOf(journey, "watched").state, "failed");
  assert.match(stageOf(journey, "watched").proved, /Nothing about your app was learned/);
});

test("a clean sweep completes the loop", () => {
  const journey = buildJourney({
    detection,
    lifecycle: { grade: { letter: "A" } },
    ledger: [entry("check", { seq: 1, grade: "A" }), entry("sweep", { seq: 2, comparison: { clean: true, counts: { matched: 12 } } })],
  });
  assert.equal(stageOf(journey, "watched").state, "done");
  assert.match(stageOf(journey, "watched").what, /12 matched accounts/);
});

test("a failing app points at repair, a passing one points at watching", () => {
  const failing = buildJourney({ detection, lifecycle: { grade: { letter: "F" } } });
  assert.equal(failing.currentId, "repaired");
  assert.equal(stageOf(failing, "repaired").state, "next");

  const passing = buildJourney({ detection, lifecycle: { grade: { letter: "A" } } });
  assert.equal(passing.currentId, "watched");
});

test("a real-event failure is not hidden by a passing synthetic run", () => {
  const journey = buildJourney({ detection, lifecycle: { grade: { letter: "A" } }, sandbox: { grade: { letter: "F" } } });
  assert.equal(journey.grade, "F");
  assert.equal(journey.passing, false);
});

test("the connector line is only solid behind a stage that finished", () => {
  const done = renderJourney(buildJourney({ detection, lifecycle: { grade: { letter: "A" } } }), { escape: String });
  const notDone = renderJourney(buildJourney({ detection, ledger: [entry("check")] }), { escape: String });
  assert.ok(done.strip.includes("jline-done"), "a finished stage draws a finished line");
  assert.ok(!notDone.strip.includes("jline-done"), "an unfinished stage must not draw a finished line");
});

test("the page and the terminal never disagree about the next step", () => {
  /* Both read the same ladder; this asserts the page actually shows it. */
  const html = renderReport({ detection, lifecycle: { scenarioCount: 1, grade: { letter: "F", reason: "x" }, results: [] }, ledger: [] });
  assert.ok(html.includes("npx akeso-check fix"), "the page offers the same command the terminal does");
  assert.ok(html.includes("Where this app is"));
  assert.ok(html.includes("Hands to the next step"));
});

test("account identifiers and app names are escaped, never rendered as markup", () => {
  const html = renderReport({
    detection: { ...detection, framework: { packageName: '<img src=x onerror="alert(1)">', framework: "next-app-router" } },
    lifecycle: null,
    ledger: [],
  });
  assert.ok(!html.includes("<img src=x"), "a project name is data, not markup");
  assert.ok(html.includes("&lt;img"));
});
