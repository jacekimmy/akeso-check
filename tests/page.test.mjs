import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderPage } from "../src/page.mjs";
import { appendEntry, readLedger, restoreEntry } from "../src/ledger.mjs";
import { queueRemoval } from "../src/approvals.mjs";
import { certify, fingerprintSchema } from "../src/certification.mjs";

/* The one page. Every number on it is read from the ledger, and the rules the
   rest of the product keeps apply here too: nothing drawn that did not run,
   nothing invented, nothing that a founder cannot act on with a command. */

const detection = { framework: { packageName: "demo" }, webhookHandlers: [{ file: "app/api/stripe/webhook/route.ts" }] };
const scratch = () => mkdtemp(path.join(tmpdir(), "akeso-page-"));

test("an empty project renders a start, not a crash and not a verdict", () => {
  const html = renderPage({ root: "/x/demo", ledger: [], detection: null });
  assert.ok(html.startsWith("<!doctype html>"));
  assert.match(html, /Nothing has been checked yet/);
  assert.match(html, /Nothing is waiting for you/);
  assert.match(html, /not measured/, "an unmeasured number is shown as unmeasured");
  const exposureAt = html.indexOf("Unpaid access exposure");
  assert.ok(!/\$\d/.test(html.slice(exposureAt - 200, exposureAt + 200)), "no exposure figure is invented for a project with no sweeps");
});

test("a real ledger reports its chain as unbroken", async () => {
  const root = await scratch();
  await appendEntry(root, { kind: "check", grade: "A", lifecycleGrade: "A", findings: [], scenarioResults: [] });
  await appendEntry(root, { kind: "sweep", comparison: { clean: true, comparable: true, counts: { matched: 3 }, monthlyExposure: 0 }, drift: { grants: 0, removalsQueued: 0 } });
  const html = renderPage({ root, ledger: await readLedger(root), detection });
  assert.match(html, /chain unbroken/);
  assert.ok(!html.includes("chain BROKEN"));
});

test("a queued removal is shown as waiting, with the command to decide it", async () => {
  const root = await scratch();
  await appendEntry(root, { kind: "check", grade: "A", lifecycleGrade: "A", findings: [], scenarioResults: [] });
  await appendEntry(root, { kind: "sweep", comparison: { clean: false, comparable: true, counts: { matched: 9 }, monthlyExposure: 29 }, drift: { grants: 0, removalsQueued: 1 } });
  await queueRemoval(root, { account: "acct_77", reason: "Stripe says canceled", priceMonthly: 29, expectedState: true, ruleVersion: "1", delayMinutes: 0 });
  const html = renderPage({ root, ledger: await readLedger(root), detection });
  assert.match(html, /acct_77/);
  assert.match(html, /npx akeso-check approvals/);
  assert.match(html, /never removes access on its own/);
});

test("revenue recovered is never a number, whatever the ledger holds", async () => {
  const root = await scratch();
  await appendEntry(root, restoreEntry({ account: "a", direction: "grant", result: "applied", verified: true, reasonCode: "x", idempotencyKey: "k" }));
  const html = renderPage({ root, ledger: await readLedger(root), detection });
  /* The figure sits beside the label in a ledger column, so look on both
     sides of it: the rule is "no dollar figure near revenue recovered". */
  const at = html.indexOf("Revenue recovered");
  const revenueBlock = html.slice(at, at + 300);
  assert.match(revenueBlock, /not measured/);
  assert.ok(!/\$\d/.test(revenueBlock), "no dollar figure next to revenue recovered");
});

test("schedule lines appear only once coverage is on", async () => {
  const root = await scratch();
  await appendEntry(root, { kind: "sweep", comparison: { clean: true, comparable: true, counts: { matched: 3 }, monthlyExposure: 0 }, drift: { grants: 0, removalsQueued: 0 } });
  const fingerprint = fingerprintSchema({ table: "profiles", column: "is_pro", accountColumn: "id" });

  const before = renderPage({ root, ledger: await readLedger(root), detection, schemaFingerprint: fingerprint });
  assert.match(before, /not covering this app yet/);
  assert.ok(!/Akeso last checked your customers/.test(before), "an uncertified app must not read as watched");

  await certify(root, { policy: { entitledWhilePastDue: true, entitledWhilePaused: false, neverConclude: ["incomplete"], ruleVersion: "1" }, priceToPlan: {}, schemaFingerprint: fingerprint, adapterVersion: "1" });
  const after = renderPage({ root, ledger: await readLedger(root), detection, schemaFingerprint: fingerprint });
  assert.ok(!/not covering this app yet/.test(after));
});

test("hostile account names are escaped, never rendered as markup", async () => {
  const root = await scratch();
  const hostile = '<img src=x onerror="alert(1)">';
  await appendEntry(root, { kind: "check", grade: "A", lifecycleGrade: "A", findings: [], scenarioResults: [] });
  await appendEntry(root, { kind: "sweep", comparison: { clean: false, comparable: true, counts: { matched: 1 }, monthlyExposure: 0 }, drift: { grants: 0, removalsQueued: 1 } });
  await queueRemoval(root, { account: hostile, reason: hostile, priceMonthly: null, expectedState: true, ruleVersion: "1", delayMinutes: 0 });
  const html = renderPage({ root, ledger: await readLedger(root), detection: { framework: { packageName: hostile } } });
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img"));
});

test("the page and the terminal agree on the next step", async () => {
  const root = await scratch();
  await appendEntry(root, { kind: "check", grade: "F", lifecycleGrade: "F", findings: ["cancels ignored"], scenarioResults: [{ id: "immediate-cancel", outcome: "fail" }] });
  const html = renderPage({ root, ledger: await readLedger(root), detection });
  assert.match(html, /npx akeso-check fix/, "the page offers the same command the terminal would");
  assert.match(html, /1 failing scenario, handed to the fix/, "singular, because the count is one");
});
