import assert from "node:assert/strict";
import test from "node:test";
import { compareEntitlements } from "../src/snapshot.mjs";
import { buildJourney } from "../src/journey.mjs";
import { nextStep } from "../src/next-step.mjs";

/* The two bugs a real walkthrough found that no unit test did. Both were
   invisible until the product was used the way a founder uses it, in order,
   with the output read as English rather than as data. */

test("nothing comparable is never reported as everything matching", () => {
  /* Stripe uses customer ids, the app uses its own account ids, and nothing
     lines up. Zero disagreements out of zero comparisons is not a clean bill
     of health, and calling it one would be the most reassuring lie the
     product could tell. */
  const comparison = compareEntitlements(
    [{ account: "cus_stripe_1", status: "active", priceMonthly: 29 }, { account: "cus_stripe_2", status: "canceled", priceMonthly: 29 }],
    [{ account: "app-user-1", billingEntitled: true }, { account: "app-user-2", billingEntitled: false }],
  );

  assert.equal(comparison.counts.matched, 0);
  assert.equal(comparison.comparable, false, "a run that compared nothing must say so");
  assert.equal(comparison.canceledButEntitled.length, 0);
  assert.equal(comparison.payingButLockedOut.length, 0);
});

test("one matched account is enough to be comparable", () => {
  const comparison = compareEntitlements(
    [{ account: "shared", status: "active", priceMonthly: 29 }, { account: "cus_unmatched", status: "canceled" }],
    [{ account: "shared", billingEntitled: true }],
  );
  assert.equal(comparison.comparable, true);
  assert.equal(comparison.clean, true);
});

test("a proven repair is recorded, so later commands do not call it failed", () => {
  /* The fix ran its own verification and got an A, but only the original
     failing check was in the ledger. Every later command then read the app as
     broken and told the founder their proven repair "did not hold". */
  const ledgerWithoutProof = [
    { kind: "check", seq: 1, hash: "h1", grade: "F", lifecycleGrade: "F" },
    { kind: "fix", seq: 2, hash: "h2", files: [] },
  ];
  const before = buildJourney({ ledger: ledgerWithoutProof });
  assert.equal(before.stages.find((stage) => stage.id === "repaired").state, "failed",
    "with no proof recorded, an unproven repair is correctly not trusted");

  const ledgerWithProof = [
    ...ledgerWithoutProof,
    { kind: "check", seq: 3, hash: "h3", grade: "A", lifecycleGrade: "A", provedFix: "h2" },
  ];
  const after = buildJourney({ ledger: ledgerWithProof });
  assert.equal(after.stages.find((stage) => stage.id === "repaired").state, "done",
    "once the proof is in the ledger, the repair reads as proven");
  assert.equal(nextStep({ ledger: ledgerWithProof }).stage, "monitor");
});

test("a later sweep does not resurrect an old failing grade", () => {
  const ledger = [
    { kind: "check", seq: 1, hash: "h1", grade: "F", lifecycleGrade: "F" },
    { kind: "fix", seq: 2, hash: "h2", files: [] },
    { kind: "check", seq: 3, hash: "h3", grade: "A", lifecycleGrade: "A", provedFix: "h2" },
    { kind: "sweep", seq: 4, hash: "h4", comparison: { clean: true, counts: { matched: 3 } } },
  ];
  const journey = buildJourney({ ledger });
  assert.equal(journey.grade, "A", "the newest check decides, not the oldest");
  assert.equal(journey.stages.find((stage) => stage.id === "repaired").state, "done");
  assert.equal(journey.stages.find((stage) => stage.id === "watched").state, "done");
});
