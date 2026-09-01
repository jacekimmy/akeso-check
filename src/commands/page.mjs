import path from "node:path";
import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { flagValue as flagValueOf, positionalPath } from "../args.mjs";
import { detect } from "../detect.mjs";
import { readLedger } from "../ledger.mjs";
import { fingerprintSchema } from "../certification.mjs";
import { renderPage } from "../page.mjs";

/* `npx akeso-check page`: the one page, written to akeso.html and opened. */
export async function runPage(args) {
  const flagValue = (name) => flagValueOf(args, name);
  const root = path.resolve(positionalPath(args, "page") || process.cwd());
  const detection = await detect(root);
  const ledger = await readLedger(root);
  const schemaFingerprint = fingerprintSchema({
    table: detection.database?.entitlementTable,
    column: detection.database?.entitlementColumn,
    accountColumn: "id",
  });

  const out = path.resolve(flagValue("--html") || path.join(root, "akeso.html"));
  await writeFile(out, renderPage({ root, ledger, detection, schemaFingerprint }));
  console.log(`\nPage: ${out}`);
  console.log(`Everything on it was read from .akeso/ledger.jsonl. It has no buttons, on purpose:`);
  console.log(`every action is a command, and the page names the one to run next.\n`);
  if (!args.includes("--no-open") && !process.env.CODESPACES) {
    spawn(process.platform === "darwin" ? "open" : "xdg-open", [out], { stdio: "ignore", detached: true });
  }
}
