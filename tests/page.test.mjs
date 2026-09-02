import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { renderDashboard } from "../src/dashboard.mjs";
import { appendEntry, readLedger, restoreEntry } from "../src/ledger.mjs";
import { queueRemoval } from "../src/approvals.mjs";

/* The dashboard folds the ledger in the browser, so most of its truth is
   tested in the browser by execution (see the headless run in the handoff).
   What can be pinned here: what the file contains, what it never contains,
   and that a hostile ledger cannot escape into markup or script. */

const scratch = () => mkdtemp(path.join(tmpdir(), "akeso-dash-"));

test("the local copy loads nothing from the network", () => {
  const html = renderDashboard({ ledger: [], appName: "demo", hosted: false });
  /* The only URL allowed in the local copy is the one it tells the founder to
     run against (localhost), which loads nothing. */
  const external = (html.match(/https?:\/\/[^\s"<)]+/g) || []).filter((u) => !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(u));
  assert.deepEqual(external, [], "no external URL in the local file");
  assert.ok(!html.includes("fonts.googleapis"));
});

test("the hosted copy has the run panel and the file loader, the local copy does not", () => {
  const hosted = renderDashboard({ ledger: [], appName: "demo", hosted: true, demo: true });
  const local = renderDashboard({ ledger: [], appName: "demo", hosted: false });
  assert.ok(hosted.includes('id="ledgerFile"') && hosted.includes('id="tabs"'));
  assert.ok(!local.includes('id="ledgerFile"') && !local.includes('id="tabs"'));
  assert.match(hosted, /never uploaded/i);
});

test("the ledger travels embedded, byte for byte", async () => {
  const root = await scratch();
  await appendEntry(root, { kind: "check", grade: "F", lifecycleGrade: "F", findings: [], scenarioResults: [{ id: "immediate-cancel", outcome: "fail" }] });
  const ledger = await readLedger(root);
  const html = renderDashboard({ ledger, appName: "demo" });
  const embedded = JSON.parse(html.match(/window\.AKESO = (\{.*?\});<\/script>/s)[1]);
  assert.deepEqual(embedded.ledger, ledger, "the browser folds exactly what the file holds");
  assert.equal(embedded.scenarioNames["immediate-cancel"], "Customer cancels immediately: access ends");
});

test("a hostile ledger cannot break out of the script or the markup", async () => {
  const root = await scratch();
  const hostile = '</script><script>alert(1)</script><img src=x onerror=alert(2)>';
  await appendEntry(root, { kind: "check", grade: hostile, lifecycleGrade: "F", findings: [hostile], scenarioResults: [] });
  await queueRemoval(root, { account: hostile, reason: hostile, priceMonthly: 1, expectedState: true, ruleVersion: "1", delayMinutes: 0 });
  const html = renderDashboard({ ledger: await readLedger(root), appName: hostile, hosted: true });
  assert.ok(!html.includes("</script><script>alert(1)"), "a closing script tag inside the data must be neutralised");
  /* Inside the JSON blob a raw tag is inert (only </script matters, and that
     is escaped). Outside the script blocks, none of it may survive. */
  const outsideScripts = html.replace(/<script>[\s\S]*?<\/script>/g, "");
  assert.ok(!outsideScripts.includes("<img src=x onerror"), "markup in the app name must be escaped in the shell");
  /* Everything rendered from the ledger goes through esc() in the browser;
     the raw string is only ever inside the JSON blob, where </ is escaped. */
  assert.match(html, /<\\\/script>/);
});

test("revenue recovered is never a figure, and the rule is on every copy", () => {
  const html = renderDashboard({ ledger: [restoreEntry({ account: "a", direction: "grant", result: "applied", verified: true, reasonCode: "x", idempotencyKey: "k" })], appName: "demo" });
  const at = html.indexOf("Revenue recovered");
  assert.match(html.slice(at, at + 200), /not measured/i);
  assert.match(html, /never removes access on its own/);
});

test("it is one page: verdict, loop, approvals, settings, receipts, and the truth table", () => {
  const html = renderDashboard({ ledger: [], appName: "demo" });
  for (const id of ["ring", "verdict", "next", "loop", "compare", "inbox", "figures", "bound", "timeline"]) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(!html.includes("data-view="), "no tabs: the master doc allows one page");
  assert.ok(html.includes("Stripe says") && html.includes("App says"), "the truth table is still there");
});

test("a stranger on the hosted copy sees step one, and the demo only behind a link", () => {
  const html = renderDashboard({ ledger: [{ kind: "check", seq: 1, hash: "h", grade: "F" }], appName: "watch-this", hosted: true, demo: true });
  const embedded = JSON.parse(html.match(/window\.AKESO = (\{.*?\});<\/script>/s)[1]);
  assert.equal(embedded.onboarding, true);
  assert.deepEqual(embedded.ledger, [], "nothing is folded until they load or ask for the demo");
  assert.equal(embedded.demoLedger.length, 1);
  assert.ok(html.includes('id="start"') && html.includes('id="demoLink"'));
  const local = renderDashboard({ ledger: [], appName: "mine" });
  assert.ok(!local.includes('id="start"'), "the local page never onboards; it has its ledger");
});

test("the inline script parses, so a bad quote cannot blank the whole page", async () => {
  const vm = await import("node:vm");
  const html = renderDashboard({ ledger: [], appName: "x", hosted: true, demo: true });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 2);
  for (const src of scripts) new vm.Script(src);
});

test("the local page renders without the hosted-only elements", async () => {
  /* The hosted copy has a start section; the local page does not. A script
     that assumes either one blanks the whole page for the other. */
  const html = renderDashboard({ ledger: [], appName: "mine" });
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(!/\$\("start"\)\.hidden/.test(script[1]), "start is guarded");
});
