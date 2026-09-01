import path from "node:path";
import { readFile } from "node:fs/promises";
import { flagValue as flagValueOf, positionalPath } from "../args.mjs";
import { detect } from "../detect.mjs";
import { buildReceipt, runSweep } from "../monitor.mjs";
import { appendEntry, readLedger, verifyLedger } from "../ledger.mjs";
import { CADENCE, describeSchedule, dueWork, runLoop, scheduleState } from "../schedule.mjs";
import { nextStep, printNextStep } from "../next-step.mjs";
import { describePolicy } from "../policy.mjs";
import { buildJourney, printJourney } from "../journey.mjs";
import { certificationStatus, coverageStatement, fingerprintSchema } from "../certification.mjs";
import { guardWrite } from "../safety.mjs";
import { restoreEntitlement, signRequest } from "../restore.mjs";
import { queueRemoval } from "../approvals.mjs";
import { applyStandings, standingsFor } from "../precision.mjs";

/* `npx akeso-check monitor`
 *
 * Compares who Stripe says is paying against who the app actually lets in,
 * right now, and says what it would do about each disagreement. Read-only
 * unless --apply, and even then it only ever grants access: removals are
 * queued for a human, always.
 *
 * It reaches the app through the probe the Check already knows how to install,
 * which means no new access, no adapter to wire, and nothing new to trust.
 */

export async function runMonitor(args) {
  const flagValue = (name) => flagValueOf(args, name);
  const root = path.resolve(positionalPath(args, "monitor") || process.cwd());

  if (args.includes("--receipt")) return receipt(root);
  if (args.includes("--after-deploy")) return afterDeploy(root, flagValue("--ref"));
  if (args.includes("--watch")) return watch(args, root);

  const detection = await detect(root);
  const stripeKey = await projectStripeKey(root);
  if (!stripeKey) {
    console.log(`\nNo Stripe key found in this project's env files.`);
    console.log(`The monitor reads your subscriptions to compare them with your app.`);
    console.log(`A restricted read-only key is the right one to use here.\n`);
    process.exitCode = 1;
    return;
  }
  if (stripeKey.startsWith("sk_live_") && !args.includes("--i-know-this-is-live")) {
    /* Reading live data is legitimate and is the entire point of the monitor,
       but it should never happen by accident on a founder's first run. */
    console.log(`\nThis is a LIVE Stripe key, so this sweep would read your real customers.`);
    console.log(`That is what the monitor is for, but not by accident. Reading is safe;`);
    console.log(`nothing is written without --apply, and removals are never automatic.\n`);
    console.log(`  npx akeso-check monitor --i-know-this-is-live\n`);
    process.exitCode = 1;
    return;
  }

  const probeUrl = flagValue("--probe-url");
  const listUrl = flagValue("--entitlements-url");
  if (!probeUrl && !listUrl) {
    console.log(`\nThe monitor needs to ask your app who it currently lets in.`);
    console.log(`Point it at your app's entitlement list, or at accounts one by one:\n`);
    console.log(`  npx akeso-check monitor --entitlements-url http://localhost:3000/api/akeso-entitlements`);
    console.log(`\nThat endpoint is part of what "npx akeso-check fix" generates.\n`);
    process.exitCode = 1;
    return;
  }

  /* Coverage starts at certification, never before. A sweep may still RUN
     uncertified, because looking is always safe and the founder should be able
     to see what Akeso would find. It just may not write, and the report says
     plainly that this is not coverage. */
  const fingerprint = fingerprintSchema({
    table: detection.database?.entitlementTable,
    column: detection.database?.entitlementColumn,
    accountColumn: "id",
  });
  const coverage = certificationStatus(await readLedger(root), { schemaFingerprint: fingerprint, now: Date.now() });

  const wantApply = args.includes("--apply");
  const restoreUrl = flagValue("--restore-url");
  const sharedSecret = process.env.AKESO_SHARED_SECRET;

  /* The gate every write passes, whatever asked for it. */
  const guard = wantApply
    ? await guardWrite(root, { account: null, direction: "grant", entries: await readLedger(root), now: Date.now() })
    : { allowed: false, reasons: ["read-only run"] };

  const mayWrite = wantApply && coverage.certified && !coverage.stale && guard.allowed && Boolean(restoreUrl && sharedSecret);

  const sweep = await runSweep({
    root,
    stripeKey,
    policy: coverage.policy || undefined,
    readAppEntitlements: () => readEntitlements({ listUrl, probeUrl, secret: sharedSecret }),
    apply: mayWrite,
    restore: mayWrite
      ? (account, target, meta) => restoreEntitlement({
        endpoint: restoreUrl,
        secret: sharedSecret,
        account,
        target,
        expectedState: meta.expected,
        reasonCode: meta.reasonCode,
        idempotencyKey: meta.idempotencyKey,
      })
      : null,
  });

  if (!sweep.ranged) {
    console.log(`\nThe sweep could not run: ${sweep.couldNotRun}`);
    console.log(`This is a problem with the run, not a verdict about your app.\n`);
    process.exitCode = 1;
    return;
  }

  const { comparison, drift, safety, alerts } = sweep;
  console.log(`\nAkeso Monitor: ${comparison.counts.stripeSubscriptions} Stripe subscriptions, ${comparison.counts.appAccounts} app accounts, ${comparison.counts.matched} matched.`);

  /* Whether this was coverage or just a look, said before any finding. */
  if (!coverage.certified || coverage.stale) {
    console.log(`\n${coverageStatement(coverage).headline}`);
    console.log(`This run looked, and everything below is real, but Akeso is not watching this app`);
    console.log(`between runs and did not change anything.`);
    if (coverage.stale && coverage.staleReason) console.log(`  ${coverage.staleReason}`);
    console.log(`  npx akeso-check certify`);
  } else if (wantApply && !mayWrite) {
    console.log(`\nRead-only this run. Akeso was asked to fix things but could not:`);
    for (const reason of guard.allowed ? ["your app's restore endpoint was not given (--restore-url), or AKESO_SHARED_SECRET is not set"] : guard.reasons) {
      console.log(`  ${reason}`);
    }
  }
  /* The rule that produced every verdict below, before the verdicts. A
     founder who cannot see the rule cannot tell a real finding from a
     mis-set policy. */
  console.log(`\nThe rule this used:`);
  for (const line of describePolicy()) console.log(`  ${line}`);
  console.log();

  if (!comparison.comparable) {
    /* Zero matched accounts is not a clean month, it is a run that compared
       nothing. Almost always the account id Stripe stores does not match the
       one the app uses, and saying "everything matches" here would be the
       most reassuring lie the product could tell. */
    console.log(`NOTHING COULD BE COMPARED. None of the ${comparison.counts.stripeSubscriptions} Stripe subscriptions`);
    console.log(`matched any of the ${comparison.counts.appAccounts} accounts your app reported, so this run says`);
    console.log(`nothing at all about your billing.`);
    console.log(`\nThis is almost always the account id: Stripe needs to carry the same id your`);
    console.log(`app uses, in client_reference_id or in the subscription's metadata. Until they`);
    console.log(`line up, Akeso has no way to tell whose access is whose.`);
  } else if (comparison.clean) {
    console.log(`Everything matches. Every paying customer has access, and nobody who stopped paying still has it.`);
  } else {
    if (drift.grants.length) {
      console.log(`PAYING BUT LOCKED OUT (${drift.grants.length}). These people paid you and cannot get in:`);
      for (const row of drift.grants) console.log(`  ${row.account}  ${row.reason}`);
      console.log();
    }
    const queued = safety.removalsAllowed;
    const held = drift.removals.filter((row) => row.action === "hold");
    if (queued.length) {
      console.log(`CANCELED BUT STILL HAVE ACCESS (${queued.length}):`);
      for (const row of queued) console.log(`  ${row.account}  ${row.reason}${row.priceMonthly ? `  ($${row.priceMonthly}/mo at list)` : ""}`);
      /* Queued, so a human can act on them later without re-running the sweep.
         Queuing is not removing: nothing has been sent to the app. */
      for (const row of queued) {
        await queueRemoval(root, {
          account: row.account,
          reason: row.reason,
          priceMonthly: row.priceMonthly,
          expectedState: true,
          ruleVersion: coverage.policy?.ruleVersion || "1",
        }).catch(() => { /* a queue that cannot be written never blocks the report */ });
      }
      console.log(`  Removals are never automatic. Nothing above has happened.`);
      console.log(`  npx akeso-check approvals\n`);
    }
    if (held.length) {
      console.log(`HELD BACK (${held.length}). Inside the recent-grant protection window, so Akeso will not touch them:`);
      for (const row of held) console.log(`  ${row.account}  ${row.held}`);
      console.log();
    }
    if (comparison.noConclusion?.length) {
      console.log(`NO CONCLUSION DRAWN (${comparison.noConclusion.length}). These are mid-flight, so judging them`);
      console.log(`either way would be a guess:`);
      for (const row of comparison.noConclusion.slice(0, 10)) console.log(`  ${row.account}  ${row.status}: ${row.why}`);
      console.log();
    }
    if (drift.unmatched.length) {
      console.log(`NO STRIPE SUBSCRIPTION AT ALL (${drift.unmatched.length}). Reported, never acted on. Trials and`);
      console.log(`complimentary accounts look exactly like this, so Akeso does not guess:`);
      for (const row of drift.unmatched.slice(0, 10)) console.log(`  ${row.account}`);
      console.log();
    }
    if (comparison.monthlyExposure > 0) {
      console.log(`About $${comparison.monthlyExposure.toFixed(2)} a month of access is being given away at list price.`);
      console.log(`That is exposure, not money you will get back by removing it.\n`);
    }
  }

  for (const halt of safety.halts) console.log(`STOPPED: ${halt.message}\n`);
  for (const alert of alerts.filter((a) => a.level === "urgent")) console.log(`URGENT: ${alert.title}. ${alert.whatHappensNext}`);

  console.log(`Written to .akeso/ledger.jsonl (append-only, and "monitor --receipt" reads it back).`);
  const finalLedger = await readLedger(root);
  printJourney(buildJourney({ detection, ledger: finalLedger }));
  printNextStep(nextStep({ ledger: finalLedger, detection }));
  console.log();
}

/* `monitor --after-deploy`: a deploy is the moment billing code most often
   breaks, so one is recorded and a fresh sweep becomes due shortly after. The
   watcher runs it; without a watcher, the founder is told to. */
async function afterDeploy(root, ref) {
  await appendEntry(root, { kind: "deploy", ...(ref ? { ref } : {}) });
  console.log(`\nDeploy recorded${ref ? ` (${ref})` : ""}. A fresh check of your real customers is due in about a minute.`);
  console.log(`If "npx akeso-check monitor --watch" is running, it will do that itself.`);
  console.log(`Otherwise, run the monitor yourself once the deploy has settled.\n`);
}

/* `monitor --watch`: the sweep, forever. Each tick asks the schedule whether a
   sweep is due and runs one only if so, so the cadence lives in schedule.mjs
   and not here. A tick that throws is reported and the loop continues, because
   a monitor that dies quietly on one bad night is worse than no monitor. */
async function watch(args, root) {
  const single = args.filter((arg) => arg !== "--watch");
  const state = scheduleState(await readLedger(root), { now: Date.now() });
  console.log(`\nWatching. Akeso checks your real customers every ${CADENCE.fullSweepMinutes} minutes, and`);
  console.log(`again after any deploy you record with "monitor --after-deploy". Ctrl-C to stop.`);
  for (const line of describeSchedule(state)) console.log(`  ${line}`);

  let stop = false;
  process.on("SIGINT", () => { stop = true; console.log(`\nStopping after this check.`); });
  process.on("SIGTERM", () => { stop = true; });

  await runLoop({
    intervalMs: 60 * 1000,
    shouldStop: () => stop,
    tick: async () => {
      const due = dueWork(await readLedger(root), { now: Date.now() });
      if (!due.full) return;
      console.log(`\n${new Date().toISOString().slice(0, 16).replace("T", " ")}  ${due.reasons?.[0]?.detail || "a check is due"}`);
      await runMonitor(single);
    },
    onError: (error) => {
      console.log(`\nThis check failed and the watcher is continuing: ${error?.message || error}`);
    },
  });
}

/* The app's current answer for every account. Prefers one list call; falls
   back to asking the probe account by account when the app only offers that. */
async function readEntitlements({ listUrl, probeUrl, secret }) {
  if (listUrl) {
    /* The generated endpoint requires a signature: who is paying you is not
       public. An unsigned call is still attempted for apps that expose their
       own unauthenticated list, and its 401 is reported honestly. */
    const requestBody = JSON.stringify({});
    const response = await fetch(listUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { "akeso-signature": signRequest(requestBody, secret) } : {}),
      },
      body: requestBody,
      signal: AbortSignal.timeout(20000),
    }).catch(() => fetch(listUrl, { signal: AbortSignal.timeout(20000) }));
    if (!response.ok) throw new Error(`your app answered ${response.status} at ${listUrl}`);
    const payload = await response.json();
    const rows = Array.isArray(payload) ? payload : payload.accounts || payload.entitlements;
    if (!Array.isArray(rows)) throw new Error("that endpoint did not return a list of accounts");
    return rows.map((row) => ({ account: row.account ?? row.id, billingEntitled: Boolean(row.billingEntitled ?? row.entitled) }));
  }
  throw new Error("account-by-account probing needs an account list; use --entitlements-url");
}

async function projectStripeKey(root) {
  for (const name of ["STRIPE_SECRET_KEY", "STRIPE_API_KEY", "STRIPE_SK"]) {
    if (process.env[name]) return process.env[name];
  }
  for (const file of [".env.local", ".env", ".env.development.local", ".env.development"]) {
    const text = await readFile(path.join(root, file), "utf8").catch(() => null);
    if (!text) continue;
    const match = text.match(/^\s*STRIPE_(?:SECRET_KEY|API_KEY|SK)\s*=\s*"?([^"\s#]+)/m);
    if (match) return match[1];
  }
  return null;
}

/* The receipt: three numbers that are never added together, and a statement
   about whether the history behind them was tampered with. */
async function receipt(root) {
  const ledger = await readLedger(root);
  if (!ledger.length) {
    console.log(`\nNo history yet in this project.\n`);
    return;
  }
  const intact = verifyLedger(ledger);
  const summary = buildReceipt(ledger);

  console.log(`\nAkeso receipt for ${root}`);
  console.log(`Since ${summary.since?.slice(0, 10) || "unknown"} · ${summary.sweeps} sweeps\n`);
  console.log(`  Access restored to paying customers : ${summary.accessRestored} (${summary.verifiedRestores} confirmed by re-reading afterwards)`);
  console.log(`  Access removed after cancellation   : ${summary.accessRemoved}`);
  console.log(`  Unpaid access exposure, per sweep    : $${summary.unpaidAccessExposure.toFixed(2)} a month at list price`);
  console.log(`  Revenue recovered                    : ${summary.revenueRecoveredNote}`);
  /* Tamper-EVIDENT, never tamper-proof. The chain lives on the same machine as
     whoever could rewrite it, so an editor who also recomputes the hashes
     leaves no trace. Claiming more than this is the kind of overclaim a real
     auditor finds immediately. */
  console.log(`\n  History: ${intact.intact
    ? `${intact.entries} entries, chain unbroken (no entry was edited by anything that did not also rewrite the chain)`
    : `BROKEN at entry ${intact.brokenAt}. ${intact.reason}`}`);
  console.log(`\nThese three numbers are never added together. Only money actually collected`);
  console.log(`would count as recovered revenue, and Akeso cannot see your payouts.\n`);
}
