import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_POLICY, describePolicy, entitledUnder } from "../src/policy.mjs";
import { compareEntitlements } from "../src/snapshot.mjs";

/* The precision tests. A monitor that cries wolf gets muted, and a muted
   monitor is worth nothing, so every one of these is a false alarm that must
   never fire. */

test("a subscription set to cancel at period end is still paying", () => {
  /* Stripe keeps the status `active` until the period actually ends. Treating
     a pending cancellation as canceled would fire a false alarm on most
     cancellations that exist. */
  const comparison = compareEntitlements(
    [{ account: "leaving", status: "active", priceMonthly: 29 }],
    [{ account: "leaving", billingEntitled: true }],
  );
  assert.equal(comparison.canceledButEntitled.length, 0);
  assert.equal(comparison.clean, true);
});

test("unpaid is the one unambiguous revoke", () => {
  assert.equal(entitledUnder("unpaid"), false);
  const comparison = compareEntitlements(
    [{ account: "a", status: "unpaid", priceMonthly: 29 }],
    [{ account: "a", billingEntitled: true }],
  );
  assert.equal(comparison.canceledButEntitled.length, 1);
  assert.equal(comparison.canceledButEntitled[0].certain, true);
});

test("past_due follows the merchant's policy, not ours", () => {
  assert.equal(entitledUnder("past_due", DEFAULT_POLICY), true, "the forgiving default keeps access during retries");
  assert.equal(entitledUnder("past_due", { ...DEFAULT_POLICY, entitledWhilePastDue: false }), false);

  const strict = compareEntitlements(
    [{ account: "a", status: "past_due", priceMonthly: 29 }],
    [{ account: "a", billingEntitled: true }],
    { ...DEFAULT_POLICY, entitledWhilePastDue: false },
  );
  assert.equal(strict.canceledButEntitled[0].certain, false, "a policy-dependent finding is marked less certain");
});

test("an account mid-checkout produces no finding either way", () => {
  const comparison = compareEntitlements(
    [{ account: "buying", status: "incomplete", priceMonthly: 29 }],
    [{ account: "buying", billingEntitled: true }],
  );
  assert.equal(comparison.canceledButEntitled.length, 0);
  assert.equal(comparison.payingButLockedOut.length, 0);
  assert.equal(comparison.noConclusion.length, 1);
  assert.equal(comparison.monthlyExposure, 0, "an unjudged account never counts as leaked money");
});

test("an unrecognised Stripe status is never guessed at", () => {
  assert.equal(entitledUnder("some_future_status"), null);
  const comparison = compareEntitlements(
    [{ account: "a", status: "some_future_status" }],
    [{ account: "a", billingEntitled: true }],
  );
  assert.equal(comparison.noConclusion.length, 1);
  assert.equal(comparison.clean, true);
});

test("an old canceled subscription never overrides a current active one", () => {
  const comparison = compareEntitlements(
    [
      { account: "loyal", status: "canceled", priceMonthly: 9, subscriptionId: "sub_old" },
      { account: "loyal", status: "active", priceMonthly: 29, subscriptionId: "sub_new" },
    ],
    [{ account: "loyal", billingEntitled: true }],
  );
  assert.equal(comparison.canceledButEntitled.length, 0, "an upgraded customer is not a leak");
  assert.equal(comparison.clean, true);
});

test("order does not change the multi-subscription verdict", () => {
  const rows = [
    { account: "a", status: "active", priceMonthly: 29 },
    { account: "a", status: "canceled", priceMonthly: 9 },
  ];
  const forward = compareEntitlements(rows, [{ account: "a", billingEntitled: true }]);
  const backward = compareEntitlements([...rows].reverse(), [{ account: "a", billingEntitled: true }]);
  assert.equal(forward.clean, backward.clean);
  assert.equal(forward.clean, true);
});

test("a genuinely canceled customer with access is still caught", () => {
  const comparison = compareEntitlements(
    [{ account: "leak", status: "canceled", priceMonthly: 87 }],
    [{ account: "leak", billingEntitled: true }],
  );
  assert.equal(comparison.canceledButEntitled.length, 1, "precision must not cost the finding the product exists for");
  assert.equal(comparison.monthlyExposure, 87);
});

test("the policy in force can be read in plain English", () => {
  const lines = describePolicy();
  assert.ok(lines.some((line) => line.includes("cancel at period end")));
  assert.ok(lines.join(" ").includes("past_due"));
});
