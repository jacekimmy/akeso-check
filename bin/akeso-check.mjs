#!/usr/bin/env node
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { detect } from "../src/detect.mjs";
import { runLifecycle } from "../src/lifecycle.mjs";
import { renderReport } from "../src/report.mjs";

/* Stage one of the Check: understand the project, say what is possible, and be
   honest about what is not. The lifecycle pass and the report build on this. */

const root = path.resolve(process.argv[2] || process.cwd());

const detection = await detect(root);

/* --lifecycle-url: the app is already running there; deliver the scenarios and
   grade. The webhook secret comes from the project's own env, read locally. */
let lifecycle = null;
const urlFlag = process.argv.indexOf("--lifecycle-url");
if (urlFlag !== -1) {
  const base = process.argv[urlFlag + 1].replace(/\/$/, "");
  const webhookPath = detection.webhookHandlers[0]
    ? "/" + detection.webhookHandlers[0].file.replace(/^app/, "api").replace(/\/route\.(ts|js|mjs|tsx)$/, "").replace(/^api\/api/, "api")
    : "/api/stripe/webhook";
  const envSecret = process.env.STRIPE_WEBHOOK_SECRET || null;
  lifecycle = await runLifecycle({
    webhookUrl: `${base}${webhookPath.startsWith("/api") ? webhookPath : "/api/stripe/webhook"}`,
    probeUrl: `${base}/__akeso_probe`,
    webhookSecret: envSecret || "whsec_fixturefixturefixture5678",
  });
}

const htmlFlag = process.argv.indexOf("--html");
if (htmlFlag !== -1) {
  const out = process.argv[htmlFlag + 1] || "akeso-report.html";
  await writeFile(out, renderReport({ detection, lifecycle }));
  console.log(`report written: ${out}`);
  if (process.argv.includes("--open")) {
    const { spawn } = await import("node:child_process");
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [out], { stdio: "ignore", detached: true });
  }
}

if (process.argv.includes("--json")) {
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

console.log(`\nWhat the Check can do here:`);
console.log(`  static analysis  : yes`);
console.log(`  lifecycle test   : ${capabilities.lifecyclePass ? "yes (test-mode key present)" : "no"}`);
console.log(`  live snapshot    : ${capabilities.liveSnapshot ? "yes (read-only)" : "no"}`);
for (const blocker of capabilities.blockers) console.log(`  ⚠ ${blocker}`);
console.log();
