import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { flagValue as flagValueOf, positionalPath } from "../args.mjs";
import { detect } from "../detect.mjs";
import { runLifecycle } from "../lifecycle.mjs";
import { renderReport } from "../report.mjs";
import { installProbe, removeProbe } from "../probe.mjs";
import { runSandboxLifecycle } from "../sandbox.mjs";

/* The whole Check, in the order a stranger meets it:
 *   npx akeso-check                    → static pass, graded report, opens
 *   npx akeso-check --lifecycle-url http://localhost:3000
 *                                      → probe auto-installed, scenarios run,
 *                                        probe removed, merged report, opens
 *   … --sandbox                        → additionally: real customers in the
 *                                        founder's own Stripe TEST sandbox,
 *                                        test-clock trial + renewal, Stripe's
 *                                        own events delivered to the app
 * Options: --account <id> (map scenarios onto one real account, reset between),
 * --webhook-secret <whsec_…>, --html <path>, --no-open, --json.
 * Every default favours the founder who read nothing: something visible always
 * comes out, and the terminal always says what to do next. */

import { appendEntry, checkEntry, readLedger } from "../ledger.mjs";
import { nextStep, printNextStep } from "../next-step.mjs";
import { webhookUrlFor } from "../webhook-url.mjs";
import { buildJourney, printJourney } from "../journey.mjs";

export async function runCheck(args) {
const flagValue = (name) => flagValueOf(args, name);
const root = path.resolve(positionalPath(args, "check") || process.cwd());

const detection = await detect(root);

/* The webhook signing secret comes from the project's own env files, read
   locally and never printed. A shell export or flag can override. */
async function projectWebhookSecret() {
  const flag = flagValue("--webhook-secret");
  if (flag) return flag;
  if (process.env.STRIPE_WEBHOOK_SECRET) return process.env.STRIPE_WEBHOOK_SECRET;
  for (const file of [".env.local", ".env", ".env.development.local", ".env.development"]) {
    const text = await readFile(path.join(root, file), "utf8").catch(() => null);
    if (!text) continue;
    const match = text.match(/^\s*STRIPE_WEBHOOK_SECRET\s*=\s*"?([^"\s#]+)/m);
    if (match) return match[1];
  }
  return null;
}

/* The founder's own Stripe TEST key, read the same local-only way as the
   webhook secret. The sandbox driver itself refuses anything but sk_test_/
   rk_test_; this just finds the value. */
async function projectStripeKey() {
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

async function probeAnswers(url) {
  try {
    const response = await fetch(`${url}?account=akeso-warmup`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return false;
    const body = await response.json();
    return typeof body.billingEntitled === "boolean";
  } catch { return false; }
}

let lifecycle = null;
let sandbox = null;
let probeNote = null;
let sandboxNote = null;
const wantSandbox = args.includes("--sandbox");
const base = (flagValue("--lifecycle-url") || "").replace(/\/$/, "");
if (wantSandbox && !base) {
  console.error("\n--sandbox runs against your app while it is running, so it needs the");
  console.error("same address the lifecycle test uses. Start your dev server, then:");
  console.error("  npx akeso-check --lifecycle-url http://localhost:3000 --sandbox\n");
  process.exit(1);
}
if (base) {
  /* The promise on the tin: lifecycle tests never run against a live-mode
     setup. Delivered events can change entitlement state in whatever database
     the target app writes to. */
  if (detection.stripe.liveKeyPresent && !detection.stripe.lifecycleTestable) {
    console.error("\nThis project is configured with a LIVE Stripe key.");
    console.error("The lifecycle test changes entitlement state in the app it points at,");
    console.error("so it only runs against test-mode projects. Switch your env to a test");
    console.error("key (sk_test_...) and run it again.\n");
    process.exit(1);
  }
  const webhookUrl = webhookUrlFor(detection, base);

  const secret = await projectWebhookSecret();
  if (!secret) {
    console.error("\nNo STRIPE_WEBHOOK_SECRET found in this project's env files.");
    console.error("The lifecycle pass signs events the way Stripe does, with your app's own");
    console.error("signing secret. Without it every delivery would be rejected as forged.");
    console.error("Add it to .env.local, or pass --webhook-secret whsec_…\n");
    process.exit(1);
  }

  /* Find a probe, or install the temporary one and let the dev server pick it
     up. Removal happens no matter how the run ends. */
  let probeUrl = null;
  let installed = null;
  for (const candidate of [`${base}/api/akeso-probe`, `${base}/akeso-probe`, `${base}/api/__akeso_probe`, `${base}/__akeso_probe`]) {
    if (await probeAnswers(candidate)) { probeUrl = candidate; break; }
  }
  if (!probeUrl) {
    installed = await installProbe(root, detection);
    if (!installed.wired) {
      probeNote = `A probe stub was written to ${path.relative(root, installed.routeFile)}. The Check could not safely pick your access function (${installed.reason}). Complete the two marked lines (or ask your coding agent to), then run this again.`;
      await removeProbe(installed.routeFile).catch(() => {});
      installed = null;
    } else {
      process.stdout.write(`\nAdded a temporary probe (${path.relative(root, installed.routeFile)}, removed after the run), waiting for your dev server to pick it up`);
      const candidate = `${base}${installed.urlPath}`;
      for (let i = 0; i < 30 && !probeUrl; i += 1) {
        if (await probeAnswers(candidate)) probeUrl = candidate;
        else { process.stdout.write("."); await new Promise((r) => setTimeout(r, 1000)); }
      }
      console.log();
      if (!probeUrl) probeNote = "The temporary probe never came up at " + candidate + ". Is the dev server running at that address? Start it and run this again.";
    }
  }

  if (probeUrl) {
    const account = flagValue("--account");
    const local = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(base);
    try {
      lifecycle = await runLifecycle({
        webhookUrl,
        probeUrl,
        webhookSecret: secret,
        ...(account ? { accountFor: () => account, resetBeforeEach: true } : {}),
        settleMs: local ? 150 : 1000,
      });

      if (wantSandbox) {
        const stripeKey = await projectStripeKey();
        if (!stripeKey) {
          sandboxNote = "Sandbox skipped: no Stripe secret key found in this project's env files. Add your TEST key (sk_test_…) as STRIPE_SECRET_KEY and run again.";
        } else if (!/^(sk|rk)_test_/.test(stripeKey)) {
          sandboxNote = "Sandbox skipped: the Stripe key in this project is not a test-mode key. The sandbox creates and deletes customers, so it only ever runs against a test sandbox (sk_test_…).";
        } else {
          console.log("\nSandbox: real customers in your Stripe test sandbox, trial and renewal");
          console.log("via a Stripe test clock. This takes a few minutes.");
          try {
            sandbox = await runSandboxLifecycle({
              stripeKey,
              webhookUrl,
              probeUrl,
              webhookSecret: secret,
              log: (line) => console.log(`  ${line}`),
            });
          } catch (error) {
            /* Our failure, never the app's grade. */
            sandboxNote = `Sandbox could not finish: ${error?.message || error}. Nothing from this counts against your app.`;
          }
        }
      }
    } finally {
      if (installed) await removeProbe(installed.routeFile).catch(() => {});
    }
  }
}

/* The Check's result goes into the ledger before anything is printed. This is
   what makes the three commands one product: Fix refuses to run without a
   Check entry to authorise it, and Monitor reads the same history. */
const staticFindings = [
  detection.webhookHandlers[0] ? null : "no webhook handler found",
  detection.webhookHandlers[0] && !detection.webhookHandlers[0].verifiesSignature ? "signature not verified" : null,
  detection.webhookHandlers[0]?.missingEvents?.length ? `${detection.webhookHandlers[0].missingEvents.length} of 7 events unhandled` : null,
].filter(Boolean);

await appendEntry(root, checkEntry({
  grade: sandbox?.grade?.letter || lifecycle?.grade?.letter || null,
  lifecycleGrade: lifecycle?.grade?.letter || null,
  sandboxGrade: sandbox?.grade?.letter || null,
  findings: staticFindings,
  scenarioResults: (lifecycle?.results || []).map((result) => ({ id: result.id, outcome: result.outcome })),
  framework: detection.framework?.framework || null,
  root,
})).catch(() => { /* a ledger that cannot be written never blocks a Check */ });

if (args.includes("--json")) {
  console.log(JSON.stringify({ detection, lifecycle, sandbox }, null, 2));
  return;
}

const { framework, stripe, database, webhookHandlers, accessDecisionSites, capabilities } = detection;

console.log(`\nAkeso Check: looking at ${root}`);
console.log(`Scanned ${detection.scannedFiles} source files.\n`);

console.log(`App        : ${framework.framework}${framework.packageName ? ` (${framework.packageName})` : ""}`);
console.log(`Stripe     : ${stripe.secretKey ? `${stripe.secretKey.mode} key ending …${stripe.secretKey.lastFour}` : "no key found"}${stripe.sdkInstalled ? "" : stripe.secretKey ? " (SDK not installed)" : ""}`);
console.log(`Database   : ${database.kind}${database.supabase ? ` (${database.supabase.urlHost})` : ""}`);

if (webhookHandlers.length) {
  const handler = webhookHandlers[0];
  console.log(`\nWebhook handler: ${handler.file}`);
  console.log(`  signature verified : ${handler.verifiesSignature ? "yes" : "NOT SEEN. Anyone could forge events"}`);
  console.log(`  raw body handling  : ${handler.rawBodySeen ? "seen" : "not seen. Verification may fail at runtime"}`);
  console.log(`  events handled     : ${handler.handledEvents.length ? handler.handledEvents.join(", ") : "none of the required set"}`);
  if (handler.missingEvents.length) console.log(`  events MISSING     : ${handler.missingEvents.join(", ")}`);
} else {
  console.log("\nWebhook handler: none found.");
}

if (accessDecisionSites.length) {
  console.log("\nWhere paid access appears to be decided (ranked, needs confirming):");
  for (const site of accessDecisionSites.slice(0, 5)) {
    console.log(`  ${String(site.score).padStart(2)}  ${site.file}${site.clientSideOnly ? "  [client-side, bypassable]" : ""}`);
    console.log(`      ${site.evidence.join("; ")}`);
  }
} else {
  console.log("\nWhere paid access is decided: could not find any candidate.");
}

if (lifecycle) {
  console.log(`\nLifecycle: grade ${lifecycle.grade.letter}. ${lifecycle.grade.reason}`);
  for (const result of lifecycle.results) {
    const mark = result.outcome === "pass" ? "✓" : result.outcome === "fail" ? "✗" : "—";
    console.log(`  ${mark} ${result.name}`);
  }
}
if (sandbox) {
  console.log(`\nSandbox (real Stripe events): grade ${sandbox.grade.letter}. ${sandbox.grade.reason}`);
  for (const phase of sandbox.phases) {
    const mark = phase.outcome === "pass" ? "✓" : phase.outcome === "fail" ? "✗" : "—";
    console.log(`  ${mark} ${phase.phase}`);
  }
}
if (probeNote) console.log(`\n⚠ ${probeNote}`);
if (sandboxNote) console.log(`\n⚠ ${sandboxNote}`);
for (const blocker of capabilities.blockers) console.log(`⚠ ${blocker}`);

/* Something visible always comes out: the report, and the next step. */
const out = flagValue("--html") || path.join(root, "akeso-report.html");
await writeFile(out, renderReport({ detection, lifecycle, sandbox, ledger: await readLedger(root) }));
console.log(`\nReport: ${out}`);
if (process.env.CODESPACES) {
  console.log(`To view it: right-click ${path.basename(out)} in the file list on the left and choose Download, then open the downloaded file.`);
} else if (!args.includes("--no-open")) {
  const { spawn } = await import("node:child_process");
  spawn(process.platform === "darwin" ? "open" : "xdg-open", [out], { stdio: "ignore", detached: true });
}

/* Where this leaves the founder, decided in one place for all three commands.
   The loop is printed first so the next step lands inside a picture the
   founder already understands, rather than as a bare instruction. */
if (!probeNote) {
  const finalLedger = await readLedger(root);
  printJourney(buildJourney({ detection, lifecycle, sandbox, ledger: finalLedger }));
  printNextStep(nextStep({ ledger: finalLedger, detection, lifecycle, sandbox }));
}
console.log();
}
