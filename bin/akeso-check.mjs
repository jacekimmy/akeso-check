#!/usr/bin/env node
import path from "node:path";
import { detect } from "../src/detect.mjs";

/* Stage one of the Check: understand the project, say what is possible, and be
   honest about what is not. The lifecycle pass and the report build on this. */

const root = path.resolve(process.argv[2] || process.cwd());

const detection = await detect(root);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(detection, null, 2));
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
