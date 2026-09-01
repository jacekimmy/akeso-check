import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LIMITS, applyBlastRadius, buildAlerts, buildReceipt, classifyDrift, runSweep } from "../src/monitor.mjs";
import { compareEntitlements } from "../src/snapshot.mjs";
import { appendEntry, readLedger, restoreEntry } from "../src/ledger.mjs";

/* The Monitor can take paid access away from a real customer. Every test here
   is a rule that stands between it and someone's incident. */

const scratch = () => mkdtemp(path.join(tmpdir(), "akeso-monitor-"));

const comparisonOf = (stripeSide, appSide) => compareEntitlements(stripeSide, appSide);

test("a paying customer locked out is restored now; a canceled one waits for a human", () => {
  const comparison = comparisonOf(
    [{ account: "a", status: "active", priceMonthly: 29 }, { account: "b", status: "canceled", priceMonthly: 29 }],
    [{ account: "a", billingEntitled: false }, { account: "b", billingEntitled: true }],
  );
  const drift = classifyDrift(comparison);

  assert.equal(drift.grants[0].action, "restore_now", "a paying customer waits for nobody");
  assert.equal(drift.removals[0].action, "queue_for_approval", "taking access away is never automatic");
});

test("access granted in the last seven days is never removed", () => {
  const now = Date.now();
  const comparison = comparisonOf(
    [{ account: "fresh", status: "canceled", priceMonthly: 10 }],
    [{ account: "fresh", billingEntitled: true }],
  );
  const drift = classifyDrift(comparison, { grantedAt: { fresh: new Date(now - 3600000).toISOString() }, now });

  assert.equal(drift.removals[0].action, "hold");
  assert.match(drift.removals[0].held, /protection window/);
});

test("an account with no Stripe subscription is reported, never acted on", () => {
  const comparison = comparisonOf([], [{ account: "comp", billingEntitled: true }]);
  const drift = classifyDrift(comparison);

  assert.equal(drift.unmatched.length, 1);
  assert.equal(drift.unmatched[0].action, "report_only");
  assert.equal(drift.removals.length, 0, "a comped or trial account must never be queued for removal");
});

test("a mass removal halts instead of running", () => {
  const many = Array.from({ length: LIMITS.maxRemovalsPerSweep + 2 }, (_, i) => `acct-${i}`);
  const comparison = comparisonOf(
    many.map((account) => ({ account, status: "canceled", priceMonthly: 5 })),
    many.map((account) => ({ account, billingEntitled: true })),
  );
  const safety = applyBlastRadius(classifyDrift(comparison));

  assert.equal(safety.removalsAllowed.length, 0, "nothing is removed when the count is suspicious");
  assert.equal(safety.halts[0].kind, "too_many_removals");
  assert.match(safety.halts[0].message, /mapping problem/, "the halt explains itself in plain English");
});

test("the hourly limit counts removals that already happened", () => {
  const comparison = comparisonOf(
    [{ account: "a", status: "canceled", priceMonthly: 5 }],
    [{ account: "a", billingEntitled: true }],
  );
  const safety = applyBlastRadius(classifyDrift(comparison), { recentRemovals: LIMITS.maxRemovalsPerHour });
  assert.equal(safety.removalsAllowed.length, 0);
  assert.equal(safety.halts[0].kind, "hourly_limit");
});

test("grants are never blocked by the removal limits", () => {
  const many = Array.from({ length: 20 }, (_, i) => `acct-${i}`);
  const comparison = comparisonOf(
    many.map((account) => ({ account, status: "active", priceMonthly: 5 })),
    many.map((account) => ({ account, billingEntitled: false })),
  );
  const safety = applyBlastRadius(classifyDrift(comparison));
  assert.equal(safety.grantsAllowed.length, 20, "twenty locked-out paying customers all get let back in");
  assert.equal(safety.halts.length, 0);
});

test("a clean sweep produces no alert at all", () => {
  const comparison = comparisonOf([{ account: "a", status: "active" }], [{ account: "a", billingEntitled: true }]);
  const drift = classifyDrift(comparison);
  const alerts = buildAlerts({ drift, safety: applyBlastRadius(drift), comparison, previousSweep: { clean: true } });
  assert.deepEqual(alerts, [], "silence is the goal; a monitor that cries every sweep gets muted");
});

test("the first clean sweep after a bad one says so", () => {
  const comparison = comparisonOf([{ account: "a", status: "active" }], [{ account: "a", billingEntitled: true }]);
  const drift = classifyDrift(comparison);
  const alerts = buildAlerts({ drift, safety: applyBlastRadius(drift), comparison, previousSweep: { clean: false } });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].level, "good_news");
});

test("every alert says what happens next", () => {
  const comparison = comparisonOf(
    [{ account: "a", status: "active", priceMonthly: 29 }, { account: "b", status: "canceled", priceMonthly: 29 }],
    [{ account: "a", billingEntitled: false }, { account: "b", billingEntitled: true }],
  );
  const drift = classifyDrift(comparison);
  const alerts = buildAlerts({ drift, safety: applyBlastRadius(drift), comparison });

  assert.ok(alerts.length >= 2);
  for (const alert of alerts) {
    assert.ok(alert.whatHappensNext, `alert "${alert.title}" must say what happens next or it is just noise`);
  }
  assert.equal(alerts.find((alert) => alert.title.includes("locked out")).level, "urgent");
});

test("no dollar figure is invented when no price is known", () => {
  const comparison = comparisonOf(
    [{ account: "b", status: "canceled", priceMonthly: null }],
    [{ account: "b", billingEntitled: true }],
  );
  const drift = classifyDrift(comparison);
  const alerts = buildAlerts({ drift, safety: applyBlastRadius(drift), comparison });
  const removal = alerts.find((alert) => alert.title.includes("canceled"));
  assert.match(removal.detail, /no dollar figure is claimed/);
});

test("the receipt keeps its three numbers apart and never invents revenue", async () => {
  const root = await scratch();
  await appendEntry(root, { kind: "sweep", comparison: { monthlyExposure: 87, clean: false } });
  await appendEntry(root, restoreEntry({ account: "a", direction: "grant", result: "applied", verified: true, reasonCode: "x", idempotencyKey: "k" }));
  await appendEntry(root, restoreEntry({ account: "b", direction: "remove", result: "applied", verified: true, reasonCode: "x", idempotencyKey: "k2" }));
  await appendEntry(root, restoreEntry({ account: "c", direction: "grant", result: "conflict", verified: false, reasonCode: "x", idempotencyKey: "k3" }));

  const receipt = buildReceipt(await readLedger(root));
  assert.equal(receipt.accessRestored, 1, "a conflicted restore is not a restore");
  assert.equal(receipt.accessRemoved, 1);
  assert.equal(receipt.unpaidAccessExposure, 87);
  assert.equal(receipt.revenueRecovered, null, "revenue Akeso cannot see is never a number");
  assert.match(receipt.revenueRecoveredNote, /does not see your payouts/);
});

test("a sweep that cannot read both sides reports itself as unrun", async () => {
  const root = await scratch();
  const result = await runSweep({
    root,
    stripeKey: "sk_test_x",
    fetchSubscriptions: async () => { throw new Error("Stripe answered 401"); },
    readAppEntitlements: async () => [],
  });

  assert.equal(result.ranged, false);
  assert.match(result.couldNotRun, /401/);
  const ledger = await readLedger(root);
  assert.equal(ledger.at(-1).kind, "sweep");
  assert.equal(ledger.at(-1).comparison, null, "a failed sweep never records a verdict about the app");
});

test("a full sweep writes one ledger entry and restores only grants", async () => {
  const root = await scratch();
  const restored = [];
  const result = await runSweep({
    root,
    stripeKey: "sk_test_x",
    fetchSubscriptions: async () => ([
      { account: "locked-out", status: "active", priceMonthly: 29 },
      { account: "still-in", status: "canceled", priceMonthly: 29 },
    ]),
    readAppEntitlements: async () => ([
      { account: "locked-out", billingEntitled: false },
      { account: "still-in", billingEntitled: true },
    ]),
    apply: true,
    restore: async (account, target, meta) => {
      restored.push({ account, target, ...meta });
      return { result: "applied", before: { billingEntitled: false }, after: { billingEntitled: true }, verified: true };
    },
  });

  assert.equal(restored.length, 1, "only the grant was written");
  assert.equal(restored[0].account, "locked-out");
  assert.equal(restored[0].target, true);
  assert.equal(result.queuedRemovals.length, 1, "the removal is queued for a human, not applied");

  const ledger = await readLedger(root);
  assert.equal(ledger.filter((entry) => entry.kind === "sweep").length, 1);
  const restoreRow = ledger.find((entry) => entry.kind === "restore");
  assert.equal(restoreRow.verified, true);
  assert.equal(restoreRow.direction, "grant");
});

test("a restore that throws is recorded as failed, not silently dropped", async () => {
  const root = await scratch();
  await runSweep({
    root,
    stripeKey: "sk_test_x",
    fetchSubscriptions: async () => [{ account: "a", status: "active", priceMonthly: 9 }],
    readAppEntitlements: async () => [{ account: "a", billingEntitled: false }],
    apply: true,
    restore: async () => { throw new Error("the app's restore endpoint timed out"); },
  });

  const restoreRow = (await readLedger(root)).find((entry) => entry.kind === "restore");
  assert.equal(restoreRow.result, "failed");
  assert.equal(restoreRow.verified, false);
});
