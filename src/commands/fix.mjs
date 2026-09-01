import path from "node:path";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { flagValue as flagValueOf, positionalPath } from "../args.mjs";
import { detect } from "../detect.mjs";
import { runLifecycle } from "../lifecycle.mjs";
import { scenarios } from "../stripe-events.mjs";
import { installProbe, removeProbe } from "../probe.mjs";
import { applyFixPlan, branchForFix, buildFixPlan, gitState, revertFix } from "../fix.mjs";
import { appendEntry, checkEntry, fixEntry, lastOfKind, readLedger } from "../ledger.mjs";
import { nextStep, printNextStep } from "../next-step.mjs";
import { webhookUrlFor } from "../webhook-url.mjs";
import { buildJourney, printJourney } from "../journey.mjs";

/* `npx akeso-check fix`
 *
 * Shows what it would change. Changes nothing until --apply. Can always be
 * undone with --revert. Refuses to run at all unless a Check found something,
 * because a repair with no evidence behind it is exactly the kind of confident
 * damage this product exists to argue against.
 */

export async function runFix(args) {
  const flagValue = (name) => flagValueOf(args, name);
  const root = path.resolve(positionalPath(args, "fix") || process.cwd());
  const ledger = await readLedger(root);

  if (args.includes("--revert")) return revert(root, ledger);

  const lastCheck = lastOfKind(ledger, "check");
  if (!lastCheck) {
    console.log("\nNothing to fix yet, because nothing has been checked.");
    console.log("Akeso only repairs what it has measured. Run the Check first:\n");
    console.log("  npx akeso-check\n");
    process.exitCode = 1;
    return;
  }

  const detection = await detect(root);
  /* The plan is rebuilt from the current code plus the last Check's executed
     results. Static findings come from now; scenario failures come from the
     run that actually happened. */
  const lifecycle = lastCheck.scenarioResults?.length
    ? { results: rehydrate(lastCheck.scenarioResults) }
    : null;
  /* The monitoring endpoints are opt-in. A founder who wanted their webhook
     repaired should not silently also get a write path into their own app. */
  const withEndpoints = args.includes("--with-endpoints");
  const plan = buildFixPlan({ detection, lifecycle, withEndpoints });

  if (!plan.repairs.length) {
    console.log("\nNothing to repair. The Check did not find anything wrong with your billing code.");
    printNextStep(nextStep({ ledger, detection }));
    console.log();
    return;
  }

  console.log(`\nAkeso Fix: ${plan.repairs.length} repair${plan.repairs.length === 1 ? "" : "s"} for ${root}\n`);
  for (const repair of plan.repairs) {
    console.log(`  ${repair.severity === "critical" ? "!!" : " !"} ${repair.title}`);
    console.log(`     ${repair.because}`);
    if (repair.handWork) console.log(`     This one Akeso cannot do for you. It needs a human decision about where the gate lives.`);
  }

  console.log(`\nFiles it would write:`);
  for (const file of plan.files) {
    console.log(`  ${file.path}`);
    console.log(`     ${file.why}${file.replaces ? " (replaces your current one; the original is backed up)" : ""}`);
  }

  if (args.includes("--show")) {
    for (const file of plan.files) {
      console.log(`\n${"=".repeat(72)}\n${file.path}\n${"=".repeat(72)}\n`);
      console.log(file.contents);
    }
    return;
  }

  if (!args.includes("--apply")) {
    console.log(`\nNothing has been changed. This was a preview.`);
    console.log(`\n  npx akeso-check fix --show     read the code it would write`);
    console.log(`  npx akeso-check fix --apply    write it (your files are backed up first)\n`);
    return;
  }

  /* Applying. "You can always undo this" has to be true before we write, not
     after — so a dirty tree stops the run unless the founder overrides. */
  const git = await gitState(root);
  if (git.repo && !git.clean && !args.includes("--allow-dirty")) {
    console.log(`\nStopped: you have uncommitted changes in this project.`);
    console.log(`Akeso wants your work saved first, so undoing this fix can never cost you anything.\n`);
    for (const file of git.dirtyFiles.slice(0, 8)) console.log(`  ${file}`);
    if (git.dirtyFiles.length > 8) console.log(`  ...and ${git.dirtyFiles.length - 8} more`);
    console.log(`\nCommit or stash them, then run this again. To go ahead anyway: --allow-dirty\n`);
    process.exitCode = 1;
    return;
  }
  if (!git.repo) {
    console.log(`\nNote: this project is not a git repository, so your only safety net is`);
    console.log(`Akeso's own backup. It is written before anything changes, and`);
    console.log(`"npx akeso-check fix --revert" puts everything back.`);
  }

  /* The repair goes on its own branch when there is one to make, so the
     founder's working branch is never the experiment. */
  if (git.repo && !args.includes("--no-branch")) {
    const branch = await branchForFix(root, `akeso/fix-${new Date().toISOString().slice(0, 10)}`);
    if (branch.branched) console.log(`\nWorking on a new branch: ${branch.branch} (you were on ${branch.from})`);
    else console.log(`\nNote: ${branch.reason}. Applying on your current branch; the backup and --revert still apply.`);
  }

  const applied = await applyFixPlan(root, plan);
  const fixRecord = await appendEntry(root, fixEntry({
    authorisedBy: lastCheck.hash,
    files: applied.written,
    backupDir: applied.backupDir,
    repairs: plan.repairs.map((repair) => repair.id),
  }));

  console.log(`\nDone. ${applied.written.length} files written, originals backed up in ${applied.backupDir}`);
  for (const file of applied.written) console.log(`  ${file.action.padEnd(8)} ${file.path}`);

  const manual = plan.files.filter((file) => file.manual);
  if (manual.length) {
    console.log(`\nOne thing Akeso will not do for you: run database schema changes.`);
    for (const file of manual) console.log(`  Open ${file.path} and paste it into your database's SQL editor.`);
  }

  if (withEndpoints) {
    /* The secret is generated locally and printed once, here, because it is
       the founder's to hold. Akeso stores it in their own env file and nowhere
       else, and the two endpoints refuse every request not signed with it. */
    const secret = `akeso_${randomBytes(24).toString("hex")}`;
    console.log(`\nTwo endpoints were added so the monitor can read and repair this app.`);
    console.log(`They refuse every request that is not signed with a secret only you hold.`);
    console.log(`\nAdd this to your env file (.env.local), and to your host's environment:`);
    console.log(`\n  AKESO_SHARED_SECRET=${secret}`);
    console.log(`\nThat value is generated on your machine and was not sent anywhere. Deleting`);
    console.log(`app/api/akeso/restore removes Akeso's ability to change this app at all.`);
  }

  /* Prove it, and undo it if the proof fails. A repair that its own test
     disagrees with is not a repair, and leaving it in place would be the
     single most damaging thing this tool could do. */
  const verifyUrl = flagValue("--verify-url");
  if (verifyUrl) {
    console.log(`\nProving the repair against ${verifyUrl} ...`);
    const verdict = await verifyRepair(root, verifyUrl, flagValue("--account"));

    if (verdict.couldNotTest) {
      console.log(`\nThe proof run could not complete: ${verdict.couldNotTest}`);
      console.log(`The repair is still in place, unproven. That is a problem with the run,`);
      console.log(`not a verdict on the code. Fix the run and try again, or --revert.\n`);
      return;
    }
    if (verdict.grade === "A") {
      console.log(`\nProven. Grade A: every billing scenario passes against the repaired app.`);
      /* The proof is a real Check run and has to be recorded as one. Without
         this the ledger still held only the failing check from before the
         repair, so every later command read the app as broken and told the
         founder their proven repair "did not hold". */
      await appendEntry(root, checkEntry({
        grade: verdict.grade,
        lifecycleGrade: verdict.grade,
        sandboxGrade: null,
        findings: [],
        scenarioResults: (verdict.lifecycle?.results || []).map((result) => ({ id: result.id, outcome: result.outcome })),
        framework: detection.framework?.framework || null,
        root,
        provedFix: fixRecord.hash,
      })).catch(() => { /* a ledger that cannot be written never blocks the result */ });
      const finalLedger = await readLedger(root);
      printJourney(buildJourney({ detection, lifecycle: verdict.lifecycle, ledger: finalLedger }));
      printNextStep(nextStep({ ledger: finalLedger, detection, lifecycle: verdict.lifecycle }));
      console.log();
      return;
    }

    console.log(`\nThe repair did NOT pass its own test (grade ${verdict.grade}). Putting your files back.`);
    const reverted = await revertFix(root, fixRecord);
    console.log(`Reverted ${reverted.restored.length} files. Your app is exactly as it was.`);
    console.log(`\nThis usually means the one file that touches your database needs adjusting.`);
    console.log(`  npx akeso-check fix --show    read the code, then apply it by hand\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nNow prove it. Akeso does not take its own word for a repair:`);
  console.log(`  1. start your dev server`);
  console.log(`  2. npx akeso-check --lifecycle-url http://localhost:3000`);
  console.log(`\nOr let Akeso prove it and undo itself if the proof fails:`);
  console.log(`  npx akeso-check fix --apply --verify-url http://localhost:3000`);
  console.log(`\nIf anything looks wrong: npx akeso-check fix --revert\n`);
}

/* Runs the real lifecycle against the repaired app. Deliberately the same code
   path the Check uses, so the repair is graded by the same judge as everything
   else and cannot be marked correct by a friendlier one. */
async function verifyRepair(root, baseUrl, account) {
  const base = baseUrl.replace(/\/$/, "");
  const detection = await detect(root);
  const secret = await projectWebhookSecret(root);
  if (!secret) return { couldNotTest: "no STRIPE_WEBHOOK_SECRET found in this project's env files" };

  const webhookUrl = webhookUrlFor(detection, base);

  let probeUrl = null;
  for (const candidate of [`${base}/api/akeso-probe`, `${base}/akeso-probe`, `${base}/api/__akeso_probe`]) {
    const answers = await fetch(`${candidate}?account=akeso-warmup`, { signal: AbortSignal.timeout(4000) })
      .then((response) => response.ok).catch(() => false);
    if (answers) { probeUrl = candidate; break; }
  }
  if (!probeUrl) {
    const installed = await installProbe(root, detection);
    if (!installed.wired) {
      await removeProbe(installed.routeFile).catch(() => {});
      return { couldNotTest: `could not install a temporary probe (${installed.reason})` };
    }
    for (let i = 0; i < 30 && !probeUrl; i += 1) {
      const answers = await fetch(`${base}${installed.urlPath}?account=akeso-warmup`, { signal: AbortSignal.timeout(4000) })
        .then((response) => response.ok).catch(() => false);
      if (answers) probeUrl = `${base}${installed.urlPath}`;
      else await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!probeUrl) {
      await removeProbe(installed.routeFile).catch(() => {});
      return { couldNotTest: "the temporary probe never came up; is the dev server running?" };
    }
    try {
      const lifecycle = await runLifecycle({ webhookUrl, probeUrl, webhookSecret: secret, ...(account ? { accountFor: () => account, resetBeforeEach: true } : {}), settleMs: 1000 });
      return { grade: lifecycle.grade.letter, lifecycle };
    } finally {
      await removeProbe(installed.routeFile).catch(() => {});
    }
  }

  const lifecycle = await runLifecycle({ webhookUrl, probeUrl, webhookSecret: secret, ...(account ? { accountFor: () => account, resetBeforeEach: true } : {}), settleMs: 1000 });
  return { grade: lifecycle.grade.letter, lifecycle };
}

async function projectWebhookSecret(root) {
  if (process.env.STRIPE_WEBHOOK_SECRET) return process.env.STRIPE_WEBHOOK_SECRET;
  for (const file of [".env.local", ".env", ".env.development.local", ".env.development"]) {
    const text = await readFile(path.join(root, file), "utf8").catch(() => null);
    if (!text) continue;
    const match = text.match(/^\s*STRIPE_WEBHOOK_SECRET\s*=\s*"?([^"\s#]+)/m);
    if (match) return match[1];
  }
  return null;
}

/* Turns the compact ledger rows ({ id, outcome }) back into full scenarios, so
   a repair can say "Customer cancels; period ends: access ends" rather than
   "cancel-at-period-end". Built from the scenario definitions themselves —
   hand-copied maps of ids to names and expectations drift the moment a
   scenario is renamed. */
const SCENARIO_META = new Map(scenarios().map((scenario) => [scenario.id, { name: scenario.name, expected: scenario.expect }]));

const rehydrate = (rows = []) => rows.map((row) => ({
  ...row,
  name: SCENARIO_META.get(row.id)?.name || row.id,
  expected: SCENARIO_META.get(row.id)?.expected ?? null,
}));

async function revert(root, ledger) {
  const lastFix = lastOfKind(ledger, "fix");
  if (!lastFix) {
    console.log("\nThere is no Akeso fix to undo in this project.\n");
    process.exitCode = 1;
    return;
  }
  const result = await revertFix(root, lastFix);
  console.log(`\nUndone. ${result.restored.length} files put back.`);
  for (const file of result.restored) console.log(`  ${file.action.padEnd(9)} ${file.path}`);
  if (result.refused.length) {
    console.log(`\nLeft alone:`);
    for (const file of result.refused) console.log(`  ${file.path}: ${file.reason}`);
  }
  console.log();
}
