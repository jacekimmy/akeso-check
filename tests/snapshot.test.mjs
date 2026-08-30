import assert from "node:assert/strict";
import test from "node:test";
import { compareEntitlements } from "../src/snapshot.mjs";

test("finds the money leak: canceled in Stripe, entitled in the app", () => {
  const out = compareEntitlements(
    [
      { account: "a1", status: "canceled", priceMonthly: 29, subscriptionId: "sub_1" },
      { account: "a2", status: "canceled", priceMonthly: 29, subscriptionId: "sub_2" },
      { account: "a3", status: "canceled", priceMonthly: 29, subscriptionId: "sub_3" },
      { account: "a4", status: "active", priceMonthly: 29, subscriptionId: "sub_4" },
    ],
    [
      { account: "a1", billingEntitled: true },
      { account: "a2", billingEntitled: true },
      { account: "a3", billingEntitled: true },
      { account: "a4", billingEntitled: true },
    ],
  );
  assert.equal(out.canceledButEntitled.length, 3);
  assert.equal(out.monthlyExposure, 87); /* the sales line: "$87 a month" */
  assert.equal(out.clean, false);
});

test("finds the customer-hurting direction: paying but locked out", () => {
  const out = compareEntitlements(
    [{ account: "b1", status: "active", priceMonthly: 49, subscriptionId: "sub_b" }],
    [{ account: "b1", billingEntitled: false }],
  );
  assert.equal(out.payingButLockedOut.length, 1);
  assert.equal(out.canceledButEntitled.length, 0);
});

test("past_due is grace, not a leak", () => {
  const out = compareEntitlements(
    [{ account: "c1", status: "past_due", priceMonthly: 19, subscriptionId: "sub_c" }],
    [{ account: "c1", billingEntitled: true }],
  );
  assert.equal(out.clean, true);
});

test("reports, never guesses: unmatched accounts are listed separately", () => {
  const out = compareEntitlements(
    [{ account: "known", status: "active", priceMonthly: 9, subscriptionId: "sub_k" }],
    [
      { account: "known", billingEntitled: true },
      { account: "mystery", billingEntitled: true }, /* entitled, no subscription anywhere */
    ],
  );
  assert.equal(out.clean, true, "a possible comp account is not a confirmed leak");
  assert.deepEqual(out.entitledWithNoSubscription, [{ account: "mystery" }]);
});

test("a subscription with no priced row adds nothing to the exposure figure", () => {
  const out = compareEntitlements(
    [{ account: "d1", status: "canceled", priceMonthly: null, subscriptionId: "sub_d" }],
    [{ account: "d1", billingEntitled: true }],
  );
  assert.equal(out.canceledButEntitled.length, 1);
  assert.equal(out.monthlyExposure, 0, "never invent a dollar figure");
});
