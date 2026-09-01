import { randomUUID } from "node:crypto";
import { compareEntitlements, fetchStripeSubscriptions } from "./snapshot.mjs";
import { DEFAULT_POLICY } from "./policy.mjs";
import { appendEntry, readLedger, restoreEntry, sweepEntry } from "./ledger.mjs";

/* The Monitor: the Check, but forever, plus the ability to put things right.
 *
 * The Check answers "does the code handle billing correctly?" once. The
 * Monitor answers a different and harder question continuously: "right now,
 * today, does every person's access match what they are actually paying?"
 * Code can be correct and state can still be wrong — from the weeks before the
 * fix, from a missed webhook, from a manual edit.
 *
 * Three rules run through everything here, and each exists because of a way
 * this kind of product normally fails:
 *
 *   1. Grants are instant, removals are queued. A wrong grant costs a few
 *      dollars. A wrong removal locks a paying customer out of the thing they
 *      paid for, and that is the incident that ends the relationship.
 *   2. An alert must be actionable or it must not exist. Everything else is
 *      written to the ledger and read when the founder wants it.
 *   3. Every action is a receipt: what we saw, what we changed, what we
 *      re-read afterwards. Success is only claimed after the re-read agrees.
 */

/* Blast-radius limits. These are not tuning knobs; they are the difference
   between a bug and a mass lockout, and they are checked before every batch. */
export const LIMITS = {
  maxRemovalsPerSweep: 3,        /* more than this in one sweep halts and asks a human */
  maxRemovalsPerHour: 3,         /* the same limit across time, from the ledger */
  minAccountAgeHoursForRemoval: 168, /* never remove access granted in the last 7 days */
  removalDelayMinutes: 30,       /* the window in which a queued removal can be cancelled */
};

/* ---------------------------------------------------------------- drift */

/* What the sweep found, sorted into what we may do about it. Pure, so every
   rule below is testable without a Stripe account or a database. */
export function classifyDrift(comparison, { grantedAt = {}, now = Date.now() } = {}) {
  const grants = comparison.payingButLockedOut.map((row) => ({
    account: row.account,
    direction: "grant",
    reason: `Stripe says ${row.status}, the app says no access`,
    /* A paying customer locked out is urgent and safe to fix: the worst case
       of a wrong grant is a few dollars of access. */
    action: "restore_now",
    priceMonthly: row.priceMonthly ?? null,
  }));

  const removals = comparison.canceledButEntitled.map((row) => {
    /* A grant timestamp comes out of a ledger that may have been hand-edited,
       so it can be anything. An unreadable one means the protection window is
       simply unknown, never that the window has passed. */
    const granted = grantedAt[row.account];
    const grantedMs = typeof granted === "string" || typeof granted === "number" ? new Date(granted).getTime() : NaN;
    const ageHours = Number.isFinite(grantedMs) ? (now - grantedMs) / 3600000 : null;
    /* Recently granted access is the signature of a race we lost, not of a
       leak. Removing it would fight the app's own recent decision. */
    const tooNew = ageHours !== null && ageHours < LIMITS.minAccountAgeHoursForRemoval;
    return {
      account: row.account,
      direction: "remove",
      reason: `Stripe says ${row.status}, the app still grants access`,
      action: tooNew ? "hold" : "queue_for_approval",
      ...(tooNew ? { held: `access was granted ${Math.round(ageHours)}h ago, inside the ${LIMITS.minAccountAgeHoursForRemoval}h protection window` } : {}),
      priceMonthly: row.priceMonthly ?? null,
    };
  });

  const unmatched = comparison.entitledWithNoSubscription.map((row) => ({
    account: row.account,
    direction: "none",
    /* No subscription is not the same as "should not have access": trials,
       comps, and grandfathered accounts all look like this. Reported, never
       acted on, never counted as leaked money. */
    reason: "has access with no Stripe subscription at all",
    action: "report_only",
  }));

  return { grants, removals, unmatched };
}

/* The safety gate that runs before anything is written. Returns the subset we
   are allowed to act on plus every refusal, each with its reason in plain
   English — a halt the founder cannot understand is a halt they will disable. */
export function applyBlastRadius(drift, { recentRemovals = 0 } = {}) {
  const queued = drift.removals.filter((row) => row.action === "queue_for_approval");
  const halts = [];

  if (queued.length > LIMITS.maxRemovalsPerSweep) {
    halts.push({
      kind: "too_many_removals",
      message: `${queued.length} accounts would lose access in one sweep, over the limit of ${LIMITS.maxRemovalsPerSweep}. Nothing was removed. This many at once usually means a mapping problem, not ${queued.length} real cancellations.`,
    });
  }
  if (recentRemovals + queued.length > LIMITS.maxRemovalsPerHour) {
    halts.push({
      kind: "hourly_limit",
      message: `${recentRemovals} removals already happened in the last hour. Nothing was removed.`,
    });
  }

  return {
    grantsAllowed: drift.grants,
    removalsAllowed: halts.length ? [] : queued,
    halts,
  };
}

/* -------------------------------------------------------------- alerting */

/* What actually reaches a human. Everything else lands in the ledger.
 *
 * The rule, borrowed from people who run pagers for a living: an alert must
 * name something a human can do something about right now. A monitor that
 * cries every sweep gets muted, and a muted monitor is worth nothing — so the
 * bar for interrupting someone is deliberately high and stated here. */
export function buildAlerts({ drift, safety, comparison, previousSweep = null }) {
  const alerts = [];

  if (drift.grants.length) {
    alerts.push({
      level: "urgent",
      /* Customer-hurting, so it interrupts even at 3am. */
      title: `${drift.grants.length} paying customer${drift.grants.length === 1 ? " is" : "s are"} locked out`,
      detail: drift.grants.map((row) => row.account).join(", "),
      whatHappensNext: "Akeso restores their access now and re-reads it to confirm.",
    });
  }

  for (const halt of safety.halts) {
    alerts.push({ level: "urgent", title: "Akeso stopped itself", detail: halt.message, whatHappensNext: "Nothing was changed. Look at the list before approving anything." });
  }

  if (safety.removalsAllowed.length) {
    const exposure = safety.removalsAllowed.reduce((sum, row) => sum + (row.priceMonthly || 0), 0);
    alerts.push({
      level: "action_needed",
      title: `${safety.removalsAllowed.length} canceled customer${safety.removalsAllowed.length === 1 ? "" : "s"} still ha${safety.removalsAllowed.length === 1 ? "s" : "ve"} paid access`,
      detail: exposure > 0 ? `About $${exposure.toFixed(2)} a month at list price.` : "No list price known for these, so no dollar figure is claimed.",
      whatHappensNext: `Queued for ${LIMITS.removalDelayMinutes} minutes. Approve or cancel before then.`,
    });
  }

  /* Silence is the goal. A clean sweep is a ledger entry, never a message —
     but the FIRST clean sweep after a bad one is worth saying out loud,
     because "it is fixed now" is the thing the founder is waiting to hear. */
  if (comparison.clean && previousSweep && previousSweep.clean === false) {
    alerts.push({
      level: "good_news",
      title: "Everything matches again",
      detail: "Every account's access now agrees with Stripe.",
      whatHappensNext: "Back to quiet. Akeso keeps checking.",
    });
  }

  return alerts;
}

/* -------------------------------------------------------------- receipts */

/* Three numbers, never blended into one. The blended number is always the
   flattering one, and inventing it is how these products start lying. */
export function buildReceipt(entries) {
  const restores = entries.filter((entry) => entry.kind === "restore" && entry.result === "applied");
  const sweeps = entries.filter((entry) => entry.kind === "sweep");

  return {
    sweeps: sweeps.length,
    since: entries[0]?.at ?? null,
    /* 1. What was at stake, at list price. NOT money we saved — money that
          was exposed. Only rows with a known price count. */
    unpaidAccessExposure: sweeps.reduce((sum, sweep) => sum + (sweep.comparison?.monthlyExposure || 0), 0) / Math.max(sweeps.length, 1),
    /* 2. What we actually changed. Counts, not dollars, because a restore is
          not revenue and calling it revenue would be a lie. */
    accessRestored: restores.filter((entry) => entry.direction === "grant").length,
    accessRemoved: restores.filter((entry) => entry.direction === "remove").length,
    /* 3. Revenue actually collected after a correction. Nothing here can
          measure that yet, so it is reported as unmeasured, not as zero and
          never as an estimate. */
    revenueRecovered: null,
    revenueRecoveredNote: "Not measured. Akeso does not see your payouts, so it will not put a number here.",
    verifiedRestores: restores.filter((entry) => entry.verified).length,
  };
}

/* ------------------------------------------------------------ the sweep */

/* One full pass. Read-only unless `apply` is set, and even then only grants go
   through without a human. Every path ends in a ledger entry. */
export async function runSweep({
  root,
  stripeKey,
  readAppEntitlements,
  restore = null,
  apply = false,
  now = Date.now(),
  policy = DEFAULT_POLICY,
  fetchSubscriptions = fetchStripeSubscriptions,
}) {
  const ledger = await readLedger(root);
  const previousSweep = [...ledger].reverse().find((entry) => entry.kind === "sweep") || null;

  let stripeSide;
  let appSide;
  const readStartedAt = now;
  let appReadAt = now;
  try {
    stripeSide = await fetchSubscriptions(stripeKey);
    appReadAt = Date.now();
    appSide = await readAppEntitlements();
  } catch (error) {
    /* Our failure is never their state. A sweep that could not read both
       sides reports itself as unrun, exactly like a Check that could not
       reach the app. */
    const entry = await appendEntry(root, {
      kind: "sweep",
      couldNotRun: error?.message || String(error),
      comparison: null, drift: null, alerts: [],
    });
    return { ranged: false, couldNotRun: entry.couldNotRun, entry };
  }

  const comparison = compareEntitlements(stripeSide, appSide, policy);

  /* When access was granted feeds the protection window; it comes from our own
     ledger, so an app that does not record it simply gets no protection rather
     than a wrong one. */
  const grantedAt = {};
  for (const entry of ledger) {
    if (entry.kind === "restore" && entry.direction === "grant" && entry.result === "applied") grantedAt[entry.account] = entry.at;
  }

  const drift = classifyDrift(comparison, { grantedAt, now });
  const hourAgo = now - 3600000;
  const recentRemovals = ledger.filter((entry) =>
    entry.kind === "restore" && entry.direction === "remove" && entry.result === "applied" && new Date(entry.at).getTime() > hourAgo).length;
  const safety = applyBlastRadius(drift, { recentRemovals });
  const alerts = buildAlerts({ drift, safety, comparison, previousSweep });

  const sweep = await appendEntry(root, sweepEntry({
    comparison: {
      monthlyExposure: comparison.monthlyExposure,
      counts: comparison.counts,
      /* "Clean" is only meaningful when something was actually compared. A
         sweep where no Stripe subscription matched any app account is neither
         clean nor dirty, and recording it as clean would let every downstream
         reader (the receipt, the statement, the loop picture) report a clean
         bill of health nobody earned. */
      comparable: comparison.comparable,
      clean: comparison.comparable ? comparison.clean : null,
      /* The rule version the verdict was reached under. A finding read back
         next month means nothing without knowing which policy produced it. */
      policyVersion: comparison.policyVersion,
      /* When each side was read, kept apart on purpose: clock skew between
         Stripe and the app is a real cause of apparent disagreement. */
      stripeReadAt: new Date(readStartedAt).toISOString(),
      appReadAt: new Date(appReadAt).toISOString(),
    },
    drift: {
      grants: drift.grants.length,
      removalsQueued: safety.removalsAllowed.length,
      removalsHeld: drift.removals.filter((row) => row.action === "hold").length,
      reportOnly: drift.unmatched.length,
    },
    alerts,
  }));

  /* Grants only. Removals never travel this path: they wait for a human, by
     design, and that is the whole safety posture of the product. */
  const restores = [];
  if (apply && restore) {
    for (const row of safety.grantsAllowed) {
      const idempotencyKey = `akeso-grant-${row.account}-${randomUUID().slice(0, 8)}`;
      let outcome;
      try {
        outcome = await restore(row.account, true, { expected: false, reasonCode: "monitor:paying-but-locked-out", idempotencyKey });
      } catch (error) {
        outcome = { result: "failed", reason: error?.message || String(error) };
      }
      const entry = await appendEntry(root, restoreEntry({
        account: row.account,
        direction: "grant",
        reasonCode: "monitor:paying-but-locked-out",
        idempotencyKey,
        result: outcome.result,
        before: outcome.before?.billingEntitled ?? null,
        after: outcome.after?.billingEntitled ?? null,
        /* Verified means we read it back and it agreed. Nothing else counts. */
        verified: Boolean(outcome.verified),
      }));
      restores.push(entry);
    }
  }

  return {
    ranged: true,
    comparison,
    drift,
    safety,
    alerts,
    restores,
    queuedRemovals: safety.removalsAllowed,
    sweep,
  };
}
