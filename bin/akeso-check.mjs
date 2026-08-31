#!/usr/bin/env node
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { detect } from "../src/detect.mjs";
import { runLifecycle } from "../src/lifecycle.mjs";
import { renderReport } from "../src/report.mjs";
import { installProbe, removeProbe } from "../src/probe.mjs";

/* The whole Check, in the order a stranger meets it:
 *   npx akeso-check                    → static pass, graded report, opens
 *   npx akeso-check --lifecycle-url http://localhost:3000
 *                                      → probe auto-installed, scenarios run,
 *                                        probe removed, merged report, opens
 * Options: --account <id> (map scenarios onto one real account, reset between),
 * --webhook-secret <whsec_…>, --html <path>, --no-open, --json.
 * Every default favours the founder who read nothing: something visible always
 * comes out, and the terminal always says what to do next. */

const args = process.argv.slice(2);
const flagValue = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
};
const root = path.resolve(args[0] && !args[0].startsWith("--") ? args[0] : process.cwd());

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

async function probeAnswers(url) {
  try {
    const response = await fetch(`${url}?account=akeso-warmup`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return false;
    const body = await response.json();
    return typeof body.billingEntitled === "boolean";
  } catch { return false; }
}

let lifecycle = null;
let probeNote = null;
const base = (flagValue("--lifecycle-url") || "").replace(/\/$/, "");
if (base) {
  const webhookPath = detection.webhookHandlers[0]
    ? "/" + detection.webhookHandlers[0].file.replace(/^app/, "api").replace(/\/route\.(ts|js|mjs|tsx)$/, "").replace(/^api\/api/, "api")
    : "/api/stripe/webhook";
  const webhookUrl = `${base}${webhookPath.startsWith("/api") ? webhookPath : "/api/stripe/webhook"}`;

  const secret = await projectWebhookSecret();
  if (!secret) {
    console.error("\nNo STRIPE_WEBHOOK_SECRET found in this project's env files.");
    console.error("The lifecycle pass signs events the way Stripe does, with your app's own");
    console.error("signing secret — without it every delivery would be rejected as forged.");
    console.error("Add it to .env.local, or pass --webhook-secret whsec_…\n");
    process.exit(1);
  }

  /* Find a probe, or install the temporary one and let the dev server pick it
     up. Removal happens no matter how the run ends. */
  let probeUrl = null;
  let installed = null;
  for (const candidate of [`${base}/api/__akeso_probe`, `${base}/__akeso_probe`]) {
    if (await probeAnswers(candidate)) { probeUrl = candidate; break; }
  }
  if (!probeUrl) {
    installed = await installProbe(root, detection);
    if (!installed.wired) {
      probeNote = `A probe stub was written to ${path.relative(root, installed.routeFile)} — the Check could not safely pick your access function (${installed.reason}). Complete the two marked lines (or ask your coding agent to), then run this again.`;
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
      if (!probeUrl) probeNote = "The temporary probe never came up at " + candidate + " — is the dev server running at that address? Start it and run this again.";
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
    } finally {
      if (installed) await removeProbe(installed.routeFile).catch(() => {});
    }
  }
}

if (args.includes("--json")) {
  console.log(JSON.stringify({ detection, lifecycle }, null, 2));
  process.exit(0);
}

const { framework, stripe, database, webhookHandlers, accessDecisionSites, capabilities } = detection;

console.log(`\nAkeso Check — looking at ${root}`);
console.log(`Scanned ${detection.scannedFiles} source files.\n`);

console.log(`App        : ${framework.framework}${framework.packageName ? ` (${framework.packageName})` : ""}`);
console.log(`Stripe     : ${stripe.secretKey ? `${stripe.secretKey.mode} key ending …${stripe.secretKey.lastFour}` : "no key found"}${stripe.sdkInstalled ? "" : stripe.secretKey ? " (SDK not installed)" : ""}`);
console.log(`Database   : ${database.kind}${database.supabase ? ` (${database.supabase.urlHost})` : ""}`);

if (webhookHandlers.length) {
  const handler = webhookHandlers[0];
  console.log(`\nWebhook handler: ${handler.file}`);
  console.log(`  signature verified : ${handler.verifiesSignature ? "yes" : "NOT SEEN — anyone could forge events"}`);
  console.log(`  raw body handling  : ${handler.rawBodySeen ? "seen" : "not seen — verification may fail at runtime"}`);
  console.log(`  events handled     : ${handler.handledEvents.length ? handler.handledEvents.join(", ") : "none of the required set"}`);
  if (handler.missingEvents.length) console.log(`  events MISSING     : ${handler.missingEvents.join(", ")}`);
} else {
  console.log("\nWebhook handler: none found.");
}

if (accessDecisionSites.length) {
  console.log("\nWhere paid access appears to be decided (ranked, needs confirming):");
  for (const site of accessDecisionSites.slice(0, 5)) {
    console.log(`  ${String(site.score).padStart(2)}  ${site.file}${site.clientSideOnly ? "  [client-side — bypassable]" : ""}`);
    console.log(`      ${site.evidence.join("; ")}`);
  }
} else {
  console.log("\nWhere paid access is decided: could not find any candidate.");
}

if (lifecycle) {
  console.log(`\nLifecycle: grade ${lifecycle.grade.letter} — ${lifecycle.grade.reason}`);
  for (const result of lifecycle.results) {
    const mark = result.outcome === "pass" ? "✓" : result.outcome === "fail" ? "✗" : "—";
    console.log(`  ${mark} ${result.name}`);
  }
}
if (probeNote) console.log(`\n⚠ ${probeNote}`);
for (const blocker of capabilities.blockers) console.log(`⚠ ${blocker}`);

/* Something visible always comes out: the report, and the next step. */
const out = flagValue("--html") || path.join(root, "akeso-report.html");
await writeFile(out, renderReport({ detection, lifecycle }));
console.log(`\nReport: ${out}`);
if (!args.includes("--no-open")) {
  const { spawn } = await import("node:child_process");
  spawn(process.platform === "darwin" ? "open" : "xdg-open", [out], { stdio: "ignore", detached: true });
}

if (!lifecycle && !probeNote) {
  console.log(`\nNext — the real test (a pretend customer pays, cancels, gets refunded):`);
  console.log(`  1. start your dev server (usually: npm run dev)`);
  console.log(`  2. npx akeso-check --lifecycle-url http://localhost:3000`);
}
console.log();
